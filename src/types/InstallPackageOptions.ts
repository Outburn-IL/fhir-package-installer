/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import { PackageIdentifier } from './PackageIdentifier';

/**
 * Options for installing a package.
 * @param packageId Specifies a custom package ID to be installed. Defaults to the package identifier from the `package.json` file.
 * @param override Whether to override the existing package if it already exists. Defaults to false.
 * @param installDependencies Whether to install dependencies of the package. Defaults to false.
 */
export interface InstallPackageOptions {
    packageId?: string | PackageIdentifier,
    override?: boolean,
    installDependencies?: boolean,
  }
  