/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import https from 'https';
import fs from 'fs-extra';
import pLimit from 'p-limit';
import path from 'path';
import { Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import * as zlib from 'zlib';
import temp from 'temp';
import os from 'os';
import shallowParse from './shallowParse';

import type {
  ILogger,
  FpiConfig,
  FileInPackageIndex,
  PackageIdentifier,
  PackageIndex,
  PackageManifest,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions
} from './types';

temp.track();

/**
 * default logger uses global console methods
 */
const defaultLogger: ILogger = {
  info: (msg: any) => console.log(msg),
  warn: (msg: any) => console.warn(msg),
  error: (msg: any) => console.error(msg)
};

/**
 * Default prethrow function does nothing since the regular throw prints to console.log, which is the default logger
 */
const prethrow = (msg: Error | any): Error => {
  if (msg instanceof Error) {
    return msg;
  }
  const error = new Error(msg);
  return error;
};

/**
 * Max number of concurrent file operations (read / write))
 */
const limit = pLimit(Math.max(4, os.cpus().length));

/**
 * Generates an index entry for the package resource
 * @param filename resource filename
 * @param content resource content
 * @returns FileInPackageIndex object 
 */
const extractResourceIndexEntry = (filename: string, content: PackageResource): FileInPackageIndex => {
  const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
  const indexEntry: FileInPackageIndex = {
    filename,
    resourceType: content.resourceType,
    id: content.id,
    url: evalAttribute(content.url),
    name: evalAttribute(content.name),
    version: evalAttribute(content.version),
    kind: evalAttribute(content.kind),
    type: evalAttribute(content.type),
    supplements: evalAttribute(content.supplements),
    content: evalAttribute(content.content),
    baseDefinition: evalAttribute(content.baseDefinition),
    derivation: evalAttribute(content.derivation),
    date: evalAttribute(content.date)
  };
  return indexEntry;
};

export class FhirPackageInstaller {
  private logger: ILogger = defaultLogger;
  private registryUrl = 'https://packages.fhir.org';
  private fallbackUrlBase = 'https://packages.simplifier.net';
  /**
   * Path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   */
  private cachePath: string = path.join(os.homedir(), '.fhir', 'packages');
  private skipExamples = false; // skip dependency installation of example packages
  private prethrow: (msg: Error | any) => Error = prethrow;
  
  constructor(config?: FpiConfig) {
    const { logger, registryUrl, cachePath, skipExamples } = config || {} as FpiConfig;
    if (registryUrl) {
      this.registryUrl = registryUrl;
    }
    if (cachePath) {
      this.cachePath = cachePath;
    }
    if (logger) {
      this.logger = logger;
      this.prethrow = (msg: Error | any) => {
        if (!(msg instanceof Error)) {
          msg = new Error(msg);
        }
        this.logger.error(msg.message);
        this.logger.error(JSON.stringify(msg, null, 2));
        return msg;
      };
    };
    if (skipExamples) {
      this.skipExamples = skipExamples;
    }
    if (!fs.existsSync(this.cachePath)) {
      fs.mkdirSync(this.cachePath, { recursive: true });
      this.logger.info(`Directory '${this.cachePath}' created successfully.`);
    }
  }

  private async withRetries<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 5000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const isTemporary =
          err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET';
  
        if (!isTemporary || attempt === retries) {
          throw err;
        }
  
        this.logger.warn(
          `⚠️ Attempt ${attempt} failed (${err.code || err.message}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  /**
   * Takes a PackageIdentifier Object and returns the corresponding directory name of the package
   * @param packageObject A PackageObject with both name and version keys
   * @returns (string) Directory name in the standard format `name#version`
   */
  private async toDirName(packageId: PackageIdentifier | string): Promise<string> {
    packageId = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    return packageId.id + '#' + packageId.version;
  }

  /**
   * Takes a PackageIdentifier Object and returns the path to the package folder in the cache
   * @param packageObject A PackageIdentifier Object with both name and version keys
   * @returns The full path to the package directory
   */
  public async getPackageDirPath(packageId: PackageIdentifier | string): Promise<string> {
    try {
      return path.join(this.cachePath, await this.toDirName(packageId));
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  /**
   * Get the full path to the .fpi.index.json file in the package folder
   * @param packageObject A PackageIdentifier Object with both name and version keys
   * @returns (string) The path to the package index file
   */
  private async getPackageIndexPath(packageId: PackageIdentifier | string): Promise<string> {
    return path.join(await this.getPackageDirPath(packageId), 'package', '.fpi.index.json');
  }


  /**
   * Scans a package folder and generates a new `.fpi.index.json` file
   * @param packageObject The package identifier object
   * @returns PackageIndex
   */
  private async generatePackageIndex(packageId: PackageIdentifier | string): Promise<PackageIndex> {
    const pckIdObj = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    this.logger.info(`Generating new .fpi.index.json file for package ${pckIdObj.id}@${pckIdObj.version}...`);
    const packagePath = await this.getPackageDirPath(pckIdObj);
    const indexPath = await this.getPackageIndexPath(pckIdObj);
    try {
      const fileList = await fs.readdir(path.join(packagePath, 'package'));
      const files = await Promise.all(
        fileList.filter(
          file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
        ).map(
          file => limit(
            async () => {
              const content = shallowParse(await fs.readFile(path.join(packagePath, 'package', file), { encoding: 'utf8' }));
              const indexEntry = extractResourceIndexEntry(file, content as PackageResource);
              return indexEntry;
            }
          )
        )
      );
      const indexJson: PackageIndex = {
        'index-version': 2,
        files
      };
      await fs.writeJSON(indexPath, indexJson);
      return indexJson;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  private fetchJson(url: string): Promise<any> {
    return this.withRetries(() => new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      }).on('error', reject);
    }));
  }  

  private fetchStream(url: string): Promise<Readable> {
    return this.withRetries(() => new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve(res);
        } else {
          reject(new Error(`Failed to fetch ${url} (status ${res.statusCode})`));
        }
      }).on('error', reject);
    }));
  }  

  private async getPackageDataFromRegistry(packageName: string): Promise<Record<string, any>> {
    return await this.fetchJson(`${this.registryUrl}/${packageName}/`);
  }

  private async getTarballUrl(packageObject: PackageIdentifier): Promise<string> {
    try {
      const packageData = await this.getPackageDataFromRegistry(packageObject.id);
      return packageData.versions[packageObject.version]?.dist?.tarball;
    } catch {
      return `${this.fallbackUrlBase}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    const tarballStream = await this.fetchStream(url);
    const fileStream = fs.createWriteStream(destination);
    await finished(tarballStream.pipe(fileStream));
  }

  private async downloadTarball(packageObject: PackageIdentifier): Promise<string> {
    const tempDirectory = temp.mkdirSync();
    const tarballPath = path.join(tempDirectory, `${packageObject.id}-${packageObject.version}.tgz`);
    const tarballUrl = await this.getTarballUrl(packageObject);
    
    this.logger.info(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);
    await this.downloadFile(tarballUrl, tarballPath);
    return tarballPath;
  }

  /**
   * Extracts a tarball to a temporary directory and generates a new `.fpi.index.json` file.
   * The tarball can be a file path or a stream.
   * @param src The source tarball, either a file path or a Readable stream.
   * @returns The path to the temporary directory where the package was extracted.
   */
  private async extractTarball(src: string | Readable): Promise<string> {
    const tarballStream: Readable = typeof src === 'string' ? fs.createReadStream(src) : src;
    
    const indexEntries: FileInPackageIndex[] = [];
    const handleEntryPromises: Promise<void>[] = [];

    const tempDirectory = temp.mkdirSync();
    this.logger.info(`Extracting package to ${tempDirectory}`);
    const extract = tar.extract();
  
    extract.on('entry', (header, stream, next) => {
      const fullPath = path.join(tempDirectory, header.name);
      const folderInTarball = path.dirname(header.name);
      const fileName = path.basename(header.name);
  
      // Always ensure directory exists
      fs.ensureDirSync(path.dirname(fullPath));
  
      // Push the write+index task into the limit-controlled queue:
      const task = limit(async () => {
        // Pipe to disk
        await new Promise<void>((resolve, reject) => {
          const fileWriteStream = fs.createWriteStream(fullPath);
          stream.pipe(fileWriteStream);
          stream.on('error', reject);
          fileWriteStream.on('finish', resolve);
          fileWriteStream.on('error', reject);
        });
  
        // Collect metadata if applicable
        if (
          header.type === 'file' &&
          folderInTarball === 'package' &&
          fileName.endsWith('.json') &&
          fileName !== 'package.json' &&
          !fileName.endsWith('.index.json')
        ) {
          const contentBuffer = await fs.readFile(fullPath, 'utf8');
          try {
            const content = shallowParse(contentBuffer) as PackageResource;
            const indexEntry = extractResourceIndexEntry(fileName, content);
            indexEntries.push(indexEntry);
          } catch (err) {
            console.error(`Failed to parse ${fileName}:`, err);
          }
        }
      });
  
      handleEntryPromises.push(task);
  
      // Immediately move on to next entry
      next();
    });
  
    await pipeline(
      tarballStream,
      zlib.createGunzip(),
      extract
    );
  
    await Promise.all(handleEntryPromises);
  
    const indexJson: PackageIndex = {
      'index-version': 2,
      files: indexEntries
    };
    await fs.writeJSON(path.join(tempDirectory, 'package', '.fpi.index.json'), indexJson);
  
    this.logger.info('Extracted to a temporary directory');
    return tempDirectory;
  }

  private async downloadAndExtractTarball(packageObject: PackageIdentifier): Promise<string> {
    const tarballUrl = await this.getTarballUrl(packageObject);
    this.logger.info(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);
    const tarballStream = await this.fetchStream(tarballUrl);
    return await this.extractTarball(tarballStream);
  }

  /**
   * Caches the package in the FHIR package cache directory.
   * If the package is already installed, it will not be reinstalled.
   * @param packageObject The package identifier object
   * @param src The source path of the package to be cached
   * @param move Whether to move the package to the cache or copy it. Defaults to **true**.
   * @returns The path to the cached package directory
   */
  private async cachePackage(packageObject: PackageIdentifier, src: string, move: boolean = true): Promise<string> {
    let finalPath = await this.getPackageDirPath(packageObject);
    if (!await fs.exists(path.join(src, 'package'))) {
      finalPath = path.join(finalPath, 'package');
    }
    const isInstalled = await this.isInstalled(packageObject);
    if (!isInstalled) {
      // try to move the temp dir to the cache, this will fail if pkg was already installed by a parallel process
      try {
        const action = move ? fs.move : fs.copy;
        await action(src, finalPath, { overwrite: false });
        this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
      }
      catch {
        this.logger.warn(`Package ${packageObject.id}@${packageObject.version} already installed by another process`);
        return finalPath;
      }
    }
    return finalPath;
  }

  /**
   * Extracts the version of the package from a raw package identifier string.
   * Supported formats: `name@version`, `name#version`, or just `name`
   * @param packageId Raw package identifier string
   * @returns The version part or 'latest' if not supplied
   */
  private getVersionFromPackageString(packageId: string): string {
    const byPound = packageId.split('#');
    const byAt = packageId.split('@');
    if (byPound.length === 2) return byPound[1];
    if (byAt.length === 2) return byAt[1];
    return 'latest';
  }

  public async isInstalled(packageId: PackageIdentifier | string): Promise<boolean> {
    try {
      return await fs.exists(await this.getPackageDirPath(packageId));      
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async getPackageIndexFile(packageId: PackageIdentifier | string): Promise<PackageIndex> {
    try {
      const indexPath = await this.getPackageIndexPath(packageId);
      if (await fs.exists(indexPath)) {
        return await fs.readJSON(indexPath, { encoding: 'utf8' });
      }
      return await this.generatePackageIndex(packageId);
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async checkLatestPackageDist(packageName: string): Promise<string> {
    try {
      const packageData = await this.getPackageDataFromRegistry(packageName);
      return packageData['dist-tags']?.latest;
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async toPackageObject(packageId: string | PackageIdentifier): Promise<PackageIdentifier> {
    try {
      let packageVersion: string;
      let packageName: string;
      if (typeof packageId === 'string') {
        packageId = packageId.trim();
        if (packageId.length === 0) {
          this.logger.error('Invalid package identifier: empty string');
          throw new Error('Invalid package identifier: empty string');
        }
        packageName = packageId.split('#')[0].split('@')[0];
        packageVersion = this.getVersionFromPackageString(packageId);
      } else {
        packageName = packageId.id;
        packageVersion = packageId.version || 'latest';
      }
      if (packageVersion === 'latest') {
        try {
          packageVersion = await this.checkLatestPackageDist(packageName);
        } catch (e) {
          this.logger.error(`Failed to fetch latest version for package ${packageName}`);
          throw this.prethrow(e);
        }
      }
      return { id: packageName, version: packageVersion };
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  private async readManifestFile(packageFolder: string): Promise<PackageManifest> {
    const manifestPath = path.join(packageFolder, 'package.json');
    return await fs.readJSON(manifestPath, { encoding: 'utf8' });
  }

  public async getManifest(packageId: string | PackageIdentifier): Promise<PackageManifest> {
    try {
      if (typeof packageId === 'string') {
        packageId = await this.toPackageObject(packageId);
      }
      const manifestFile = await this.readManifestFile(path.join(await this.getPackageDirPath(packageId), 'package'));
      if (manifestFile) {
        return manifestFile;
      } else {
        this.logger.warn(`Could not find package manifest for ${packageId.id}@${packageId.version}`);
        return { name: packageId.id, version: packageId.version };
      }
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  /**
   * Get the path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * @returns {string} The path to the FHIR package cache directory
   */
  public getCachePath(): string {
    return this.cachePath;
  }

  /**
   * Get the logger instance used by this FhirPackageInstaller.
  */

  public getLogger(): ILogger {
    return this.logger;
  }

  public async getDependencies(packageObject: PackageIdentifier) {
    try {
      return (await this.getManifest(packageObject))?.dependencies;
    } catch (e) {
      throw this.prethrow(e);
    }    
  }

  public async install(packageId: string | PackageIdentifier): Promise<boolean> {
    try {
      let packageObject: PackageIdentifier;
      if (typeof packageId === 'string') {
        packageId = packageId.trim();
        if (packageId.length === 0) {
          this.logger.error('Invalid package identifier: empty string');
          throw new Error('Invalid package identifier: empty string');
        }
        packageObject = await this.toPackageObject(packageId);
      } else {
        packageObject = packageId;
      }
      const alreadyInstalled = await this.isInstalled(packageObject);
      if (!alreadyInstalled) {
        try {
          const tempPath = await this.downloadAndExtractTarball(packageObject);
          await this.cachePackage(packageObject, tempPath);
        } catch (e) {
          this.logger.error(`Failed to install package ${packageObject.id}@${packageObject.version}`);
          throw this.prethrow(e);
        }
      }
  
      await this.installPackageDependencies(packageObject);
      return true;
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  private async installPackageDependencies(packageObject: PackageIdentifier): Promise<void>{
    await this.getPackageIndexFile(packageObject);
    const deps = await this.getDependencies(packageObject);
    for (const dep in deps) {
      if (this.skipExamples && dep.includes('examples')) {
        this.logger.info(`Skipping example package ${dep}@${deps[dep]}`);
        continue;
      } else {
        await this.install(`${dep}@${deps[dep]}`);
      }
    }
  }

  /**
   * Installs a package from a local file or directory.
   * The package can be a tarball file or a directory containing the package files.
   * @param src The path to the local package file or directory.
   * @param options Options for installing the package.
   * @returns A promise that resolves to true if the package was installed successfully,
   * or false if it was already installed.
   */
  public async installLocalPackage(src: string, options?: InstallPackageOptions): Promise<boolean> {
    try {
      src = src.trim();
      if (src.length === 0) {
        throw new Error('Invalid path: empty string');
      }
      if (!await fs.exists(src)) {
        throw new Error(`Invalid path: ${src} does not exist`);
      }

      const fullPath = path.isAbsolute(src) ? src : path.resolve(src);
      const isDirectory = (await fs.lstat(fullPath)).isDirectory();
      let finalPath: string;

      if (isDirectory) {
        this.logger.info(`Installing package from directory: ${fullPath}`);
        finalPath = fullPath;
      } else {
        this.logger.info(`Installing package from file: ${fullPath}`);
        finalPath = await this.extractTarball(fullPath);
      }
    
      let packageObject: PackageIdentifier;
      if (options?.packageId) {
        packageObject = await this.toPackageObject(options.packageId);
      } else {
        const potentialPackagePath = path.join(finalPath, 'package');
        const manifestFilePath = await fs.exists(potentialPackagePath) ? potentialPackagePath : finalPath;
        const manifest = await this.readManifestFile(manifestFilePath);
        packageObject = { id: manifest.name, version: manifest.version };
      }
        
      const alreadyInstalled = await this.isInstalled(packageObject);
      if (alreadyInstalled && !options?.override) {
        this.logger.info(`Package ${packageObject.id}@${packageObject.version} is already installed`);
        return false;
      } else {
        await fs.remove(await this.getPackageDirPath(packageObject));
      }

      const installedPath = await this.cachePackage(packageObject, finalPath, !isDirectory); // if the source is a file, we can move the temp dir to the cache
      await this.generatePackageIndex(packageObject);
      this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${installedPath}`);
    
      if (options?.installDependencies) {
        await this.installPackageDependencies(packageObject);
      }
    } catch (e) {
      throw this.prethrow(e);
    }

    return true;
  }

  /**
   * Downloads a package tarball and optionally extracts it to a destination directory.
   * 
   * Behavior:
   * - If `extract` is false or omitted: downloads the tarball as a .tgz file to the destination directory.
   * - If `extract` is true: downloads and extracts the package into a subdirectory of the destination path.
   *
   * @param packageId A package identifier string or a PackageIdentifier object.
   * @param options Options controlling the download and extraction behavior.
   * @returns 
   * - If `extract` is false: the full path to the downloaded tarball file.
   * - If `extract` is true: the full path to the extracted package directory.
   */
  public async downloadPackage(
    packageId: string | PackageIdentifier,
    options?: DownloadPackageOptions): Promise<string> 
  {
    try {
      const { destination = '.', overwrite = false, extract = false } = options || {} as DownloadPackageOptions;

      const packageObject = await this.toPackageObject(packageId);
      const packageName = `${packageObject.id}@${packageObject.version}`;
      
      let finalPath = destination && path.isAbsolute(destination)
        ? destination
        : path.join(path.resolve(destination ||'.'));
      if (extract) {
        finalPath = path.join(finalPath, await this.toDirName(packageObject));
      } else {
        finalPath = path.join(finalPath, `${packageObject.id}-${packageObject.version}.tgz`);
      }
      this.logger.info(`Downloading ${(extract ? 'and extracting ' : '')}${packageName} to: ${finalPath}`);
  
      try {
        if (extract) {
          const tempDirectory = await this.downloadAndExtractTarball(packageObject);
          await fs.move(tempDirectory, finalPath, { overwrite });
        } else {
          const tempDirectory = await this.downloadTarball(packageObject);
          await fs.move(tempDirectory, finalPath, { overwrite });
        }
        this.logger.info(`Downloaded ${packageName} to: ${finalPath}`);
      } catch (e) {
        this.logger.error(`Failed to download package ${packageName}`);
        throw this.prethrow(e);
      }
      return finalPath;
    }
    catch (e) {
      throw this.prethrow(e);
    }
  }
}

/**
 * Default instance export for convenience
 */
const fpi = new FhirPackageInstaller();
export default fpi;

export type {
  ILogger,
  PackageIdentifier,
  PackageIndex,
  PackageManifest,
  FileInPackageIndex,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions
} from './types';
