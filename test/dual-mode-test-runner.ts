import { FhirPackageInstaller } from 'fhir-package-installer';
import type { ILogger } from 'fhir-package-installer';
import { MockArtifactoryServer } from './mock-artifactory-server.js';

interface FpiConfig {
  logger?: ILogger;
  registryUrl?: string;
  registryToken?: string;
  cachePath?: string;
  skipExamples?: boolean;
}

export interface TestContext {
  fpi: FhirPackageInstaller;
  mode: 'direct' | 'artifactory';
  mockServer?: MockArtifactoryServer;
}

/**
 * Test runner that executes tests in both direct and Artifactory modes
 */
export class DualModeTestRunner {
  private static mockServer: MockArtifactoryServer;
  private static readonly MOCK_PORT = 3333;

  /**
   * Sets up mock Artifactory server for testing
   */
  static async setupMockServer(): Promise<MockArtifactoryServer> {
    if (!this.mockServer) {
      this.mockServer = new MockArtifactoryServer(this.MOCK_PORT);
      await this.mockServer.start();
    }
    return this.mockServer;
  }

  /**
   * Tears down mock Artifactory server
   */
  static async teardownMockServer(): Promise<void> {
    if (this.mockServer) {
      await this.mockServer.stop();
    }
  }

  /**
   * Creates test contexts for both direct and Artifactory modes
   */
  static createTestContexts(
    baseConfig: Partial<FpiConfig> = {},
    logger?: ILogger
  ): TestContext[] {
    const directContext: TestContext = {
      fpi: new FhirPackageInstaller({
        ...baseConfig,
        logger,
      }),
      mode: 'direct'
    };

    const artifactoryContext: TestContext = {
      fpi: new FhirPackageInstaller({
        ...baseConfig,
        registryUrl: this.mockServer?.getUrl() || `http://localhost:${this.MOCK_PORT}/artifactory/api/npm/fhir-npm-remote`,
        registryToken: this.mockServer?.getValidToken() || 'test-token-123',
        allowHttp: true, // Enable HTTP for testing
        logger,
      }),
      mode: 'artifactory',
      mockServer: this.mockServer
    };

    return [directContext, artifactoryContext];
  }

  /**
   * Runs a test function in both direct and Artifactory modes
   */
  static async runInBothModes<T>(
    testFn: (context: TestContext) => Promise<T>,
    baseConfig: Partial<FpiConfig> = {},
    logger?: ILogger
  ): Promise<{ direct: T; artifactory: T }> {
    const contexts = this.createTestContexts(baseConfig, logger);
    
    const directResult = await testFn(contexts[0]);
    const artifactoryResult = await testFn(contexts[1]);

    return {
      direct: directResult,
      artifactory: artifactoryResult
    };
  }

  /**
   * Helper to get the mock server instance
   */
  static getMockServer(): MockArtifactoryServer | undefined {
    return this.mockServer;
  }
}

/**
 * Vitest helper function to create parametrized tests for both modes
 */
export function createDualModeTests(
  testName: string,
  testFn: (context: TestContext) => Promise<void>,
  baseConfig: Partial<FpiConfig> = {},
  logger?: ILogger,
  options: { timeout?: number; skip?: boolean } = {}
) {
  const contexts = DualModeTestRunner.createTestContexts(baseConfig, logger);
  
  return contexts.map(context => ({
    name: `${testName} (${context.mode})`,
    fn: () => testFn(context),
    timeout: options.timeout,
    skip: options.skip
  }));
}

export default DualModeTestRunner;
