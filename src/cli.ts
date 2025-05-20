import { Command } from 'commander';
import { FhirPackageInstaller } from '.';

// Set up the command line interface and global options
const program = new Command()
  .option('-r, --registry-url <url>', '')
  .option('-c, --cache-path <path>', '')
  .option('-s, --skip-examples', 'Skip dependency installation of example packages');;

program
  .name('fpi')
  .description('CLI for installing and managing FHIR packages')
  .version('0.0.1')
  .addHelpText('beforeAll', 'FHIR Package Installer\n© Copyright Outburn Ltd. 2022-2025 All Rights Reserved\n');

// Commands
program
  .command('install <packageId>')
  .alias('i')
  .description('Download and install a package and all its dependencies')
  .action(async (packageId) => {
    const fpi = createFpi();
    await fpi.install(packageId);
  });

program
  .command('download <packageId>')
  .alias('dl')
  .description('Download a package tarball and optionally extracts it to a destination directory')
  .option('-d, --dest <dest>', 'The directory path where the package should be saved or extracted')
  .option('-o, --overwrite', 'Whether to overwrite the existing package if it already exists')
  .option('-e, --extract', 'Whether to extract the package after downloading')
  .action(async (id, opts) => {
    const fpi = createFpi();
    await fpi.downloadPackage(id, {destination: opts.dest, overwrite: opts.overwrite, extract: opts.extract});
  });

program
  .command('install-local')
  .alias('il')
  .description('Install a package from a local file or directory')
  .argument('<src>', 'The path to a tarball file or a directory containing the package files')
  .option('-i, --id <packageId>', '')
  .option('-o, --override', '')
  .option('-d, --install-dependencies', '')
  .action(async (src, opts) => {
    const fpi = createFpi();
    await fpi.installLocalPackage(src, {packageId: opts.id, override: opts.override, installDependencies: opts.installDependencies});
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
  .description('Parses dependencies listed in the package\'s package.json')
  .action(async (packageId) => {
    const fpi = createFpi();
    const packageIdentifier = await fpi.toPackageObject(packageId);
    const deps = await fpi.getDependencies(packageIdentifier);
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
  .command('is-installed <packageId>')
  .alias('is')
  .description('Determine whether the package is already present in the local cache or not')
  .action(async (packageId) => {
    const fpi = createFpi();
    const isInstalled = await fpi.isInstalled(packageId);
    if (isInstalled) {
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

function createFpi() {
  const { registryUrl, cachePath, skipExamples } = program.opts();
  return new FhirPackageInstaller({ registryUrl, cachePath, skipExamples });
};

function print (data: unknown) {
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
};