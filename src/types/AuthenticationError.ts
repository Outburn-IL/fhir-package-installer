/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

/**
 * Error class representing authentication or authorization failures when accessing a resource.
 */
export class AuthenticationError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: 401 | 403) {
    super(message || 'Authentication or authorization failed');
    this.name = 'AuthenticationError';
    this.statusCode = statusCode;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthenticationError);
    }
  }
}