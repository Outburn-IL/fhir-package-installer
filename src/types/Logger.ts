/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */
export interface ILogger {
  info: (msg: any) => void
  warn: (msg: any) => void
  error: (msg: any) => void
};
