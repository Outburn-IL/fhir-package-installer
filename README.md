# FHIR Package Installer

A utility module for downloading, indexing, caching, and managing [FHIR](https://hl7.org/fhir/) packages from the [FHIR Package Registry](https://packages.fhir.org) and [Simplifier](https://simplifier.net/). Commonly used in tooling such as FHIR validators, terminology engines, snapshot generators, and more.

---

## Features

- Download and install [FHIR NPM-style packages](https://hl7.org/fhir/packages.html) (e.g., `hl7.fhir.uv.sdc@3.0.0`)
- Cache downloaded packages locally in the [FHIR Package Cache](https://confluence.hl7.org/spaces/FHIR/pages/66928417/FHIR+Package+Cache) or a custom path if defined in the constructor.
- Automatically resolve `latest` versions
- Generate and retrieve a local index (`.fpi.index.json`) of all FHIR JSON files in the package
- Fetch `package.json` manifest and dependencies
- Recursively install required dependencies
- Support for private registries including JFrog Artifactory, Nexus, and Azure DevOps
- Customizable registry URL, logger, and cache location

---

## Installation

```bash
npm install fhir-package-installer
```

---

## Quick Start (Default Usage)

```ts
import fpi from 'fhir-package-installer';

await fpi.install('hl7.fhir.r4.core@4.0.1');

const index = await fpi.getPackageIndexFile({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
```

---

## Advanced Usage (Custom Configurations)

Use the `FhirPackageInstaller` class directly to customize behavior:

```ts
import { FhirPackageInstaller } from 'fhir-package-installer';

const customFpi = new FhirPackageInstaller({
  logger: {
    info: msg => console.log('[INFO]', msg),
    warn: msg => console.warn('[WARN]', msg),
    error: msg => console.error('[ERROR]', msg)
  },
  registryUrl: 'https://packages.fhir.org',
  registryToken: 'your-registry-token-here', // For private registries / artifactories
  cachePath: './my-fhir-cache'
});

await customFpi.install('hl7.fhir.r4.core');
```

### `FpiConfig` fields:
- `logger` – Optional. Custom logger implementing the `ILogger` interface.
- `registryUrl` – Optional. Custom package registry base URL (e.g., JFrog Artifactory).
- `registryToken` – Optional. Authentication token for private registries.
- `cachePath` – Optional. Directory where packages will be cached.
- `skipExamples` – Optional. Don't install dependencies that have `examples` in the package name

---

## Public API Methods

### `install(packageId: string | PackageIdentifier): Promise<boolean>`
Downloads and installs a package and all its dependencies.  
Accepts either a package identifier object (`{ id, version }`) or a string (`'name@version'`, `'name#version'`, or `'name'`).

---

### `downloadPackage(packageId: string | PackageIdentifier, options?: DownloadPackageOptions): Promise<string>`
Downloads a package tarball and optionally extracts it to a destination directory.

---

### `installLocalPackage(src: string, options?: InstallPackageOptions): Promise<boolean>`
Installs a package from a local file or directory.  
The package can be a tarball file or a directory containing the package files.  

---

### `getManifest(packageId: string | PackageIdentifier): Promise<PackageManifest>`
Fetches the `package.json` manifest of an installed package.

---

### `getPackageIndexFile(packageId: string | PackageIdentifier): Promise<PackageIndex>`
Returns the `.fpi.index.json` content for the package.  
If the file doesn't exist, it will be generated automatically.

---

### `getDependencies(packageId: string | PackageIdentifier): Promise<Record<string, string>>`
Parses dependencies listed in the package's `package.json`.

---

### `checkLatestPackageDist(packageName: string): Promise<string>`
Looks up the latest published version for a given package name (string only).

---

### `toPackageObject(packageId: string | PackageIdentifier): Promise<PackageIdentifier>`
Parses `name`, `name@version`, or `name#version` into an object with `id` and `version`.  
If no version is provided, resolves to the latest.

---

### `isInstalled(packageId: string | PackageIdentifier): Promise<boolean>`
Returns `true` if the package is already present in the local cache.

---

### `getCachePath(): string`
Returns the root cache directory used by this installer.

---

### `getLogger(): ILogger`
Returns the logger instance used by this installer.

---

### `getPackageDirPath(packageId: string | PackageIdentifier): Promise<string>`
Returns the path to a specific package folder in the cache.

---

## CLI

In addition to its programmatic API, FHIR Package Installer also provides a fully featured Command Line Interface (CLI) for installing, managing, and inspecting FHIR packages directly from the terminal.

This is especially useful for:
- Tooling pipelines (e.g., CI/CD)
- Scripted validators and snapshot generators
- Developers who prefer using the CLI over importing the library

### Usage

```
fpi [options] [command]
```

### Global Options

| Option                  | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `-r`, `--registry-url`  | URL of the FHIR package registry                 |
| `-c`, `--cache-path`    | Path to the FHIR package cache directory         |
| `-s`, `--skip-examples` | Skip dependency installation of example packages |
| `-V`, `--version`       | Output the version number                        |
| `-h`, `--help`          | Display help for command                         |

### Commands

| Command                              | Description                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `install`, `i <packageId>`           | Download and install a package and all its dependencies                        |
| `download`, `dl <packageId>`         | Download a package tarball and optionally extract it to a destination          |
| `install-local`, `il <src>`          | Install a package from a local file or directory                               |
| `get-manifest`, `gm <packageId>`     | Print the `package.json` manifest of an installed package                      |
| `get-index`, `gi <packageId>`        | Print the `.fpi.index.json` content for the package. Auto-generates if missing |
| `get-dependencies`, `gd <packageId>` | Parse and list dependencies from the `package.json`                            |
| `to-package-object`, `tpo <id>`      | Parse `name`, `name@version`, or `name#version` into `{ id, version }`         |
| `is-installed`, `is <packageId>`     | Check if a package exists in the local cache                                   |
| `get-cache`, `gc`                    | Print the root cache directory path                                            |
| `get-package-path`, `gp <id>`        | Print the path to a specific cached package                                    |
| `help [command]`                     | Display help for a specific command                                            |


---

## Package Cache Directory

### Location

Location of the default global package cache differs per operating system.

Windows: 
```
c:\users\<username>\.fhir\packages
```

Unix/Linux: 
```
/~/.fhir/packages
```

### For system services (daemons):

Windows: 
```
C:\Windows\System32\config\systemprofile\.fhir\packages
```
Unix/Linux: 
```
/var/lib/.fhir/packages
```  

### Folder Structure
The package cache root folder contains a folder per package where the folder name is the package name, a pound and the package version:

- `package-cache-folder`
  - `hl7.fhir.us.core#0.1.1`
  - `hl7.fhir.r4.core#4.0.1`
  - `hl7.fhir.uv.sdc#3.0.0`

---

## JFrog Artifactory & Private Registry Support

FHIR Package Installer supports JFrog Artifactory and other private NPM registries that act as secure proxies or mirrors of the public FHIR Package Registry. Artifactory is commonly used by enterprises to provide cached, controlled access to FHIR packages through their internal infrastructure, along with other solutions like Nexus Repository and Azure DevOps Artifacts.

### Artifactory Configuration

```ts
import { FhirPackageInstaller } from 'fhir-package-installer';

const artifactoryFpi = new FhirPackageInstaller({
  registryUrl: 'https://your-artifactory.example.com/artifactory/api/npm/fhir-npm-remote',
  registryToken: 'cmVmdGtuOjAxOjE3ODQ5Nzc0OTI6NU83WE9JTkFrOVJtVWxxSmpzcXZsYWVaeHpL', // Do not include 'Bearer' prefix
  cachePath: './custom-cache'
});

// Install public FHIR packages through your Artifactory registry
await artifactoryFpi.install('hl7.fhir.r4.core@4.0.1');
await artifactoryFpi.install('hl7.fhir.us.core@6.1.0');
```

### JFrog Artifactory Setup Requirements

⚠️ **Critical Configuration**: When setting up your JFrog Artifactory repository for FHIR packages, you must:

1. **Repository Type**: Create an **npm** remote repository (not generic)
2. **Remote URL**: Set to `https://packages.simplifier.net`
   - ⚠️ Use Simplifier URL, not `packages.fhir.org` (which is just an alias)
   - The actual package metadata and tarball URLs always reference Simplifier
3. in **Advanced Settings**: ✅ **Check "Bypass HEAD Request"** option
   - This is essential because the FHIR Package Registry doesn't fully comply with npm protocol expectations
   - Without this setting, package installation will fail

**Why this matters**: The FHIR Package Registry behaves differently from standard npm registries. The "Bypass HEAD Request" option tells Artifactory to skip certain npm protocol checks that would otherwise cause failures when proxying FHIR packages.

### Supported Private Registry Solutions

- **JFrog Artifactory**: npm remote repositories (most common enterprise solution)
- **Sonatype Nexus**: npm proxy repositories  
- **Azure DevOps Artifacts**: npm feeds
- **GitHub Packages**: npm package registry
- **Custom npm registries**: Any npm-compatible registry with Bearer token authentication

---

## Index Format: `.fpi.index.json`

Each installed package is scanned for JSON files in the `package/` subdirectory (excluding `package.json` and any `[*].index.json` files). A generated index is written to:
```bash
<packagePath>/package/.fpi.index.json
```

Sample structure:
```json
{
  "index-version": 2,
  "files": [
    {
      "filename": "StructureDefinition-something.json",
      "resourceType": "StructureDefinition",
      "id": "something",
      "url": "http://...",
      "kind": "resource",
      "name": "Something",
      "version": "1.0.0",
      "type": "Observation",
      "supplements": "http://...",
      "content": "complete",
      "baseDefinition": "http://...",
      "derivation": "constraint",
      "date": "2020-01-01"
    }
  ]
}
```

**Notes:**
- All fields are optional and, with the exception of `filename`, populated directly from the original JSON resource.
- This index is an enhanced alternative to the [`.index.json`](https://hl7.org/fhir/packages.html#2.1.10.4) format in the FHIR NPM spec.
- Intended to optimize access to key metadata for tools like validators and template generators.

---

## License
MIT  
© Outburn Ltd. 2022–2025. All Rights Reserved.

---

## Disclaimer
This project is part of the [FUME](https://github.com/Outburn-IL/fume-community) open-source initiative and intended for use in FHIR tooling and development environments.

