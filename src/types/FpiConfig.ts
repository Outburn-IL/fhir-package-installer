/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import { ILogger } from './Logger';

/**
 * The structure of the FPI constructor config object.
 */
export interface FpiConfig {
    logger?: ILogger
    registryUrl?: string
    registryToken?: string
    cachePath?: string
    skipExamples?: boolean // skip dependency installation of example packages
    allowHttp?: boolean // allow HTTP URLs for testing (default: false)
  }
  