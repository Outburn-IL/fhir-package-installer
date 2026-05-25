#!/usr/bin/env node

import { Command } from 'commander';
import { FhirPackageInstaller } from '.';
import type { FpiConfig } from './types';
import type { Logger } from '@outburn/types';

// Injected at build time via tsup `define` (see tsup.config.ts).
declare const __FPI_VERSION__: string | undefined;
const CLI_VERSION = typeof __FPI_VERSION__ === 'string' && __FPI_VERSION__.trim().length > 0
  ? __FPI_VERSION__
  : '0.0.0';

// Set up the command line interface and global options
const program = new Command()
  .option('-r, --registry-url <url>', 'URL of the FHIR package registry (use "n/a" to disable network access)')
  .option('-t, --registry-token <token>', 'Bearer token for authenticating against a private registry')
  .option('-c, --cache-path <path>', 'Path to the FHIR package cache directory')
  .option('-s, --skip-examples', 'Skip dependency installation of example packages')
  .option('--allow-http', 'Allow HTTP (non-HTTPS) registry URLs (for testing)')
  .option('--request-timeout <ms>', 'HTTP request timeout in milliseconds', parseIntOption)
  .option('--extract-timeout <ms>', 'Tarball extraction timeout in milliseconds', parseIntOption)
  .option('--registry-ttl <ms>', 'TTL for cached registry lookups in milliseconds', parseIntOption)
  .option('-v, --verbose', 'Enable verbose (debug) logging');

const ASCII_HEADER = String.raw`
  ███████╗██████╗ ██╗
  ██╔════╝██╔══██╗██║
  █████╗  ██████╔╝██║
  ██╔══╝  ██╔═══╝ ██║
  ██║     ██║     ██║
  ╚═╝     ╚═╝     ╚═╝
  FHIR Package Installer
`;
const COPYRIGHT = '© Copyright Outburn Ltd. 2022-2026 All Rights Reserved';
const helpText = `${ASCII_HEADER}  ${COPYRIGHT}\n\n`;

program
  .name('fpi')
  .description('CLI for installing and managing FHIR packages')
  .version(CLI_VERSION)
  .addHelpText('beforeAll', helpText);

// Commands
program
  .command('install <packageId>')
  .alias('i')
  .description('Download and install a package and all its dependencies')
  .action(async (packageId) => {
    const fpi = createFpi();
    const installed = await fpi.install(packageId);
    if (installed) {
      console.log(`Package ${packageId} installed successfully.`);
    }
  });

program
  .command('download <packageId>')
  .alias('dl')
  .description('Download a package tarball and optionally extracts it to a destination directory (defaults to the current location)')
  .option('-d, --dest <dest>', 'The directory path where the package should be saved or extracted')
  .option('-o, --overwrite', 'Whether to overwrite the existing package if it already exists')
  .option('-e, --extract', 'Whether to extract the package after downloading')
  .action(async (id, opts) => {
    const fpi = createFpi();
    await fpi.downloadPackage(id, { destination: opts.dest, overwrite: opts.overwrite, extract: opts.extract });
  });

program
  .command('install-local')
  .alias('il')
  .description('Install a package from a local file or directory')
  .argument('<src>', 'The path to a tarball file or a directory containing the package files')
  .option('-i, --id <packageId>', 'Specifies a custom package ID to be installed. Defaults to the package identifier from the `package.json` file')
  .option('-o, --override', 'Whether to override the existing package if it already exists. Defaults to false')
  .option('-d, --install-dependencies', 'Whether to install dependencies of the package. Defaults to false')
  .action(async (src, opts) => {
    const fpi = createFpi();
    await fpi.installLocalPackage(src, { packageId: opts.id, override: opts.override, installDependencies: opts.installDependencies });
  });

program
  .command('get-manifest <packageId>')
  .alias('gm')
  .description('Print the package.json manifest of an installed package')
  .action(async (packageId) => {
    const fpi = createFpi();
    const manifest = await fpi.getManifest(packageId);
    print(manifest);
  });

program
  .command('get-index <packageId>')
  .alias('gi')
  .description('Print the `.fpi.index.json` content for the package.\nIf the file doesn\'t exist, it will be generated automatically')
  .action(async (packageId) => {
    const fpi = createFpi();
    const index = await fpi.getPackageIndexFile(packageId);
    print(index);
  });

program
  .command('get-dependencies <packageId>')
  .alias('gd')
  .description('Parses dependencies listed in the package\'s package.json (includes implicit FHIR core dependencies)')
  .option('--root <rootPackageId>', 'Root package for graph-aware implicit version selection')
  .option('--planning-fallbacks', 'Include planning fallbacks for unresolved implicit dependencies')
  .action(async (packageId, opts) => {
    const fpi = createFpi();
    const packageIdentifier = await fpi.toPackageObject(packageId);
    const deps = await fpi.getDependencies(packageIdentifier, {
      rootPackage: opts.root,
      includePlanningFallbacks: opts.planningFallbacks,
    });
    print(deps);
  });

program
  .command('to-package-object <packageId>')
  .alias('tpo')
  .description('Parses <name>, <name@version>, or <name#version> into an object with `id` and `version`.\nIf no version is provided, resolves to the latest.')
  .action(async (packageId) => {
    const fpi = createFpi();
    const packageObject = await fpi.toPackageObject(packageId);
    print(packageObject);
  });

program
  .command('check-latest <packageName>')
  .alias('cl')
  .description('Resolve the latest published version of a package from the registry')
  .action(async (packageName) => {
    const fpi = createFpi();
    const latest = await fpi.checkLatestPackageDist(packageName);
    print(latest);
  });

program
  .command('is-installed <packageId>')
  .alias('is')
  .description('Determine whether the package is already present in the local cache or not')
  .option('--shallow', 'Only check whether the package itself is installed; skip dependency validation')
  .option('--raw', 'Print the raw boolean result (true/false) instead of a friendly message')
  .action(async (packageId, opts) => {
    const fpi = createFpi({ disableLogging: true });
    const isInstalled = await fpi.isInstalled(packageId, { deep: !opts.shallow });
    if (opts.raw) {
      print(isInstalled);
    } else if (isInstalled) {
      print(`Package ${packageId} is already installed.`);
    } else {
      print(`Package ${packageId} is not installed.`);
    }
  });

program
  .command('get-cache')
  .alias('gc')
  .description('Print the root cache directory used by this installer')
  .action(() => {
    const fpi = createFpi();
    const cachePath = fpi.getCachePath();
    print(cachePath);
  });

program
  .command('get-package-path <packageId>')
  .alias('gp')
  .description('Print the path to a specific package folder in the cache')
  .action(async (packageId) => {
    const fpi = createFpi();
    const packagePath = await fpi.getPackageDirPath(packageId);
    print(packagePath);
  });

program.parse();

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function createConsoleLogger(verbose: boolean): Logger {
  const logger: Logger = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
  if (verbose) {
    logger.debug = (...args: unknown[]) => console.debug(...args);
  }
  return logger;
}

function createSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createFpi(options?: { disableLogging?: boolean }): FhirPackageInstaller {
  const {
    registryUrl,
    registryToken,
    cachePath,
    skipExamples,
    allowHttp,
    requestTimeout,
    extractTimeout,
    registryTtl,
    verbose,
  } = program.opts();

  const config: FpiConfig = {
    logger: options?.disableLogging ? createSilentLogger() : createConsoleLogger(Boolean(verbose)),
    registryUrl,
    registryToken,
    cachePath,
    skipExamples,
    allowHttp,
    requestTimeoutMs: requestTimeout,
    extractTimeoutMs: extractTimeout,
    registryTtlMs: registryTtl,
  };

  const fpi = new FhirPackageInstaller(config);

  // Create a proxy that wraps all method calls with try-catch
  return new Proxy(fpi, {
    get(target, prop, receiver) {
      const originalMethod = Reflect.get(target, prop, receiver);

      // Only wrap functions (methods)
      if (typeof originalMethod === 'function') {
        return function (...args: unknown[]) {
          try {
            const result = originalMethod.apply(target, args);

            // If the result is a Promise, wrap the promise with catch
            if (result instanceof Promise) {
              return result.catch((error: Error) => {
                console.error(`Error in ${String(prop)}:`, error.message);
                process.exit(1);
              });
            }

            return result;
          } catch (error) {
            console.error(`Error in ${String(prop)}:`, (error as Error).message);
            process.exit(1);
          }
        };
      }

      // Return non-function properties as-is
      return originalMethod;
    },
  });
}

function print(data: unknown) {
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}
