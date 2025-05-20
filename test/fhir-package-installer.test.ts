import path from 'path';
import temp from 'temp';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll } from 'vitest';

import fpi, { FhirPackageInstaller } from 'fhir-package-installer';
import type { FileInPackageIndex, ILogger } from 'fhir-package-installer';

const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Helper to sort index entries by 'filename'
function sortIndexEntries(entries: FileInPackageIndex[]): FileInPackageIndex[] {
  return entries.slice().sort((a, b) => a.filename.localeCompare(b.filename));
}

temp.track();

// Whether to skip specific tests (e.g., heavy package-related tests)
// to speed up the test suite execution
const skip = false;

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('fhir-package-installer module', () => {
  const fakePackage = { id: 'fake-package', version: '1.0.0' };
  const testPkg = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };
  const fshGeneratedPkg = { id: 'fsh.test.pkg', version: '0.1.0' };
  const tstPkgHash = `${testPkg.id}#${testPkg.version}`;
  const tstPkgAt = `${testPkg.id}@${testPkg.version}`;
  
  const heavyPackage = { id: 'us.nlm.vsac', version: '0.11.0' };

  const silentFpi = new FhirPackageInstaller({ logger: noopLogger });
  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache');
  const customCacheFpi = new FhirPackageInstaller({
    cachePath: customCachePath,
    skipExamples: true
  });

  const downloadedPackagesPath = path.join('.', 'test', 'downloaded-packages');
  const resolvedDownloadedPackagesPath = path.resolve(downloadedPackagesPath);
  const fshGeneratedPath = path.join(path.resolve('.'), 'test', 'fsh-generated');

  beforeAll(async () => {
    // cleanup before running tests
    await fs.remove(customCachePath);
    await fs.remove(resolvedDownloadedPackagesPath);
  });

  it('should return correct fake package directory path (default cache)', async () => {
    const expectedPath = path.join(fpi.getCachePath(), 'fake-package#1.0.0');
    expect(await fpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should return correct package directory path (custom cache)', async () => {
    const expectedPath = path.join(customCachePath, 'fake-package#1.0.0');
    expect(await customCacheFpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should throw ENOENT on getPackageIndexFile for fake package', async () => {
    await expect(silentFpi.getPackageIndexFile(fakePackage))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should return false for isInstalled on fake package', async () => {
    expect(await fpi.isInstalled(fakePackage)).toBe(false);
  });

  it('should return false for isInstalled on deleted real package', async () => {
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgHash)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgAt)).toBe(false);
  });

  it('should correctly detect latest available version of test package', async () => {
    const latest = await fpi.checkLatestPackageDist(testPkg.id);
    expect(latest).toBe(testPkg.version);
  });

  it('should install the test package successfully', async () => {
    const result = await customCacheFpi.install(testPkg);
    expect(result).toBe(true);
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(true);
  }, TIMEOUT);

  it('should install the heavy package successfully',
    { timeout: TIMEOUT, skip },
    async () => {
      const result = await customCacheFpi.install(heavyPackage);
      expect(result).toBe(true);
      expect(await customCacheFpi.isInstalled(heavyPackage)).toBe(true);
    });

  it('should get a valid package index file after install', { skip }, async () => {
    const index = await customCacheFpi.getPackageIndexFile(tstPkgAt);
    expect(index).toMatchObject({
      'index-version': 2,
    });
    const index2 = await customCacheFpi.getPackageIndexFile(heavyPackage);
    expect(index2).toMatchObject({
      'index-version': 2,
    });
  });

  it('should get a valid manifest file after install', { skip }, async () => {
    const manifest = await customCacheFpi.getManifest(tstPkgHash);
    expect(manifest.name).toBe(testPkg.id);
    const manifest2 = await customCacheFpi.getManifest(heavyPackage);
    expect(manifest2.name).toBe(heavyPackage.id);
  });

  it('should parse a package string to a valid PackageIdentifier object', async () => {
    const obj = await fpi.toPackageObject('pkg.name@1.0.0');
    expect(obj).toEqual({ id: 'pkg.name', version: '1.0.0' });
  });

  it('should get valid dependencies from the test package', { skip }, async () => {
    const deps = await customCacheFpi.getDependencies(testPkg);
    expect(deps).toMatchObject({
      'hl7.fhir.r4.core': '4.0.1',
      'hl7.fhir.r4.examples': '4.0.1'
    });
    const deps2 = await customCacheFpi.getDependencies(heavyPackage);
    expect(deps2).toMatchObject({
      'hl7.fhir.r4.core' : '4.0.1'
    });
  });

  it('should get true for isInstalled on all non-example dependencies of test package', async () => {
    expect({
      'hl7.fhir.r4.core': await customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.core', version: '4.0.1' }),
      'hl7.fhir.r4.examples': await customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.examples', version: '4.0.1' })
    }).toMatchObject({
      'hl7.fhir.r4.core': true,
      'hl7.fhir.r4.examples': false
    });
  });

  it('should get correct index for hl7.fhir.r4.core package', async () => {
    const generatedIndex = await customCacheFpi.getPackageIndexFile({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
    const referenceIndex = fs.readJSONSync(path.join(path.resolve('.'), 'test', 'hl7.fhir.r4.core-4.0.1.fpi.index.json'));

    expect(generatedIndex['index-version']).toBe(referenceIndex['index-version']);

    // Sort the 'files' array by 'filename' for stable comparison
    const sortedGenerated = sortIndexEntries(generatedIndex.files);
    const sortedReference = sortIndexEntries(referenceIndex.files);

    // Deep compare the sorted arrays
    expect(sortedGenerated).toEqual(sortedReference);
  });

  it('should get correct index for hl7.fhir.uv.sdc package', async () => {
    const generatedIndex = await customCacheFpi.getPackageIndexFile({ id: 'hl7.fhir.uv.sdc', version: '3.0.0' });
    const referenceIndex = fs.readJSONSync(path.join(path.resolve('.'), 'test', 'hl7.fhir.uv.sdc#3.0.0.json'));

    expect(generatedIndex['index-version']).toBe(referenceIndex['index-version']);

    // Sort the 'files' array by 'filename' for stable comparison
    const sortedGenerated = sortIndexEntries(generatedIndex.files);
    const sortedReference = sortIndexEntries(referenceIndex.files);

    // Deep compare the sorted arrays
    expect(sortedGenerated).toEqual(sortedReference);
  });

  // us.nlm.vsac#0.11.0.json
  it('should get correct index for us.nlm.vsac package', { skip }, async () => {
    const generatedIndex = await customCacheFpi.getPackageIndexFile({ id: 'us.nlm.vsac', version: '0.11.0' });
    const referenceIndex = fs.readJSONSync(path.join(path.resolve('.'), 'test', 'us.nlm.vsac#0.11.0.json'));

    expect(generatedIndex['index-version']).toBe(referenceIndex['index-version']);

    // Sort the 'files' array by 'filename' for stable comparison
    const sortedGenerated = sortIndexEntries(generatedIndex.files);
    const sortedReference = sortIndexEntries(referenceIndex.files);

    // Deep compare the sorted arrays
    expect(sortedGenerated).toEqual(sortedReference);
  });

  it('should correctly re-generate index for hl7.fhir.uv.sdc package', async () => {
    const pkgDir = await customCacheFpi.getPackageDirPath('hl7.fhir.uv.sdc#3.0.0');
    const indexToDelete = path.join(pkgDir, 'package', '.fpi.index.json');
    expect(fs.existsSync(indexToDelete)).toBe(true);
    fs.removeSync(indexToDelete);
    expect(fs.existsSync(indexToDelete)).toBe(false);
    const generatedIndex = await customCacheFpi.getPackageIndexFile('hl7.fhir.uv.sdc@3.0.0');
    const referenceIndex = fs.readJSONSync(path.join(path.resolve('.'), 'test', 'hl7.fhir.uv.sdc#3.0.0.json'));

    expect(generatedIndex['index-version']).toBe(referenceIndex['index-version']);

    // Sort the 'files' array by 'filename' for stable comparison
    const sortedGenerated = sortIndexEntries(generatedIndex.files);
    const sortedReference = sortIndexEntries(referenceIndex.files);

    // Deep compare the sorted arrays
    expect(sortedGenerated).toEqual(sortedReference);
  });

  it('should have correct content in the resources', { skip }, () => {
    const filename = 'ValueSet-1.3.6.1.4.1.6997.4.1.2.234.999.4.2.json';
    const referenceVs = fs.readJSONSync(path.join(path.resolve('.'), 'test', filename));
    const installedVs = fs.readJSONSync(path.join(customCachePath, 'us.nlm.vsac#0.11.0', 'package', filename));
    expect(installedVs).toMatchObject(referenceVs);
    expect(installedVs).toEqual(referenceVs);
  });

  // Test downloadPackage function
  describe('downloadPackage', async () => {
    it('download only - default path', async () => {
      const downloadedPath = await fpi.downloadPackage(testPkg, { destination: downloadedPackagesPath });
      expect(downloadedPath).toBe(path.join(resolvedDownloadedPackagesPath, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    const customPath = path.join(downloadedPackagesPath, 'custom-path');
    const resolvedCustomPath = path.resolve(customPath);

    it('download only - custom path - relative', async () => {
      const downloadedPath = await fpi.downloadPackage(testPkg, { destination: customPath });
      expect(downloadedPath).toBe(path.join(resolvedCustomPath, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download only - custom path - fail to override', async () => {
      const action = fpi.downloadPackage(testPkg, { destination: customPath });
      await expect(action).rejects.toThrow('dest already exists.');
    });

    it('download only - custom path - override', async () => {
      const action = fpi.downloadPackage(testPkg, { destination: customPath, overwrite: true });
      await expect(action).resolves.toBeDefined();
    });
    
    it('download only - custom path - absolute', async () => {
      const tempDirectory = temp.mkdirSync();
      const downloadedPath = await fpi.downloadPackage(testPkg, { destination: tempDirectory });
      expect(downloadedPath).toBe(path.join(tempDirectory, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
      // Clean up
      await fs.remove(tempDirectory);
    });

    it('download and extract - default path', async () => {
      const downloadedPath = await fpi.downloadPackage(testPkg, { destination: downloadedPackagesPath, extract: true });
      expect(downloadedPath).toBe(path.join(resolvedDownloadedPackagesPath, `${testPkg.id}#${testPkg.version}`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download and extract - custom path', async () => {
      const downloadedPath = await fpi.downloadPackage(testPkg, { destination: customPath, extract: true });
      expect(downloadedPath).toBe(path.join(resolvedCustomPath, `${testPkg.id}#${testPkg.version}`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download and extract - custom path - fail to override', async () => {
      const action = fpi.downloadPackage(testPkg, { destination: customPath, extract: true });
      await expect(action).rejects.toThrow('dest already exists.');
    });

    it('download and extract - custom path - override', async () => {
      const action = fpi.downloadPackage(testPkg, { destination: customPath, extract: true, overwrite: true });
      await expect(action).resolves.toBeDefined();
    });
  }); // end of downloadPackage tests

  describe('install local package', () => {
    beforeAll(async () => {
      await fs.remove(customCachePath);
    });

    it('should failed when src is empty', async () => {
      const action = customCacheFpi.installLocalPackage('');
      await expect(action).rejects.toThrow('Invalid path');
    });

    it('should failed when src does not exist', async () => {
      const fakePath = path.join(path.resolve('.'), 'test', 'fake-path');
      const action = customCacheFpi.installLocalPackage(fakePath);
      await  expect(action).rejects.toThrow('Invalid path');
    });

    it('should failed when src folder does not contain package/package.json', async () => {
      // arrange: temporary rename package.json to package.json.del
      const originalJsonPath = path.join(fshGeneratedPath, 'package.json');
      const newJsonPath = path.join(path.dirname(originalJsonPath), 'package.json.del');
      await fs.rename(originalJsonPath, newJsonPath);
      // act
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath);
      // assert
      await expect(action).rejects.toThrow();
      // cleanup: rename back to package.json
      await fs.rename(newJsonPath, originalJsonPath);
    });

    it('should failed when src tgz file fails to extract', async () => {
      const fakeTgzPath = path.join(fshGeneratedPath, 'fake.tgz');
      await fs.writeFile(fakeTgzPath, 'fake content');
      const action = customCacheFpi.installLocalPackage(fakeTgzPath);
      await expect(action).rejects.toThrow();
      await fs.remove(fakeTgzPath);
    });

    it('should successfully install from local folder', async () => {
      await expect(customCacheFpi.installLocalPackage(fshGeneratedPath)).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg)).resolves.toBe(true);
      const pkgPath = await customCacheFpi.getPackageDirPath(fshGeneratedPkg);
      const indexPath = path.join(pkgPath, 'package', '.fpi.index.json');
      const indexExists = await fs.exists(indexPath);
      expect(indexExists).toBe(true);
    }, TIMEOUT);

    it('should return false when package is already installed', async () => {
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath);
      await expect(action).resolves.toBe(false);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg)).resolves.toBe(true);
    });

    it('should return true when package is already installed and override=true', async () => {
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath, { override: true });
      await expect(action).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg)).resolves.toBe(true);
    });

    it('should successfully install from local folder with a custom package id', async () => {
      await expect(customCacheFpi.installLocalPackage(fshGeneratedPath, { packageId: fakePackage })).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fakePackage)).resolves.toBe(true);
    }, TIMEOUT);

    it('should successfully install from local tgz file', { timeout: 1000 * 60 * 10 }, async () => {
      const testPkgPath = await customCacheFpi.getPackageDirPath(testPkg);
      const testPkgSrcPath = path.join(resolvedDownloadedPackagesPath, `${testPkg.id}-${testPkg.version}.tgz`);
      const indexPath = path.join(testPkgPath, 'package', '.fpi.index.json');
      await fs.remove(testPkgPath);
      await expect(customCacheFpi.isInstalled(testPkg)).resolves.toBe(false);
      await expect(customCacheFpi.installLocalPackage(testPkgSrcPath)).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(testPkg)).resolves.toBe(true);
      await expect(fs.exists(indexPath)).resolves.toBe(true);
    });
  }); // end of install local package tests
});
