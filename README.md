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
  cachePath: './my-fhir-cache'
});

await customFpi.install('hl7.fhir.r4.core');
```

### `FpiConfig` fields:
- `logger` – Optional. Custom logger implementing the `ILogger` interface.
- `registryUrl` – Optional. Custom package registry base URL.
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

