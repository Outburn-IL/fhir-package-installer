import path from 'path';
import temp from 'temp';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ILogger } from 'fhir-package-installer';
import { DualModeTestRunner, type TestContext } from './dual-mode-test-runner.js';

const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const debugLogger: ILogger = {
  info: (msg) => console.log('[INFO]', msg),
  warn: (msg) => console.warn('[WARN]', msg),
  error: (msg) => console.error('[ERROR]', msg)
};

temp.track();

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('FHIR Package Installer - Dual Mode Tests (Direct + Artifactory)', () => {
  const testPkg = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };
  const customCachePath = path.join(path.resolve('.'), 'test', '.dual-mode-cache');

  beforeAll(async () => {
    // Setup mock Artifactory server
    await DualModeTestRunner.setupMockServer();
    
    // Cleanup and recreate cache directories
    await fs.remove(customCachePath);
    await fs.ensureDir(customCachePath);
  }, 30000);

  afterAll(async () => {
    // Teardown mock server
    await DualModeTestRunner.teardownMockServer();
  }, 10000);

  describe('Authentication Tests', () => {
    it('should handle valid authentication correctly', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // This should work for both direct (no auth needed) and Artifactory (valid token)
          const latest = await context.fpi.checkLatestPackageDist('hl7.fhir.uv.sdc');
          expect(latest).toBe('3.0.0');
          return { success: true, latest };
        },
        { 
          cachePath: path.join(customCachePath, 'auth-test'),
          logger: noopLogger 
        }
      );

      expect(results.direct.success).toBe(true);
      expect(results.artifactory.success).toBe(true);
      expect(results.direct.latest).toBe('3.0.0');
      expect(results.artifactory.latest).toBe('3.0.0');
    }, TIMEOUT);

    it('should fail with invalid token (Artifactory only)', async () => {
      // Test invalid authentication - this should only affect Artifactory mode
      const invalidConfig = {
        cachePath: path.join(customCachePath, 'invalid-auth'),
        registryUrl: `${DualModeTestRunner.getMockServer()?.getUrl()}/artifactory/api/npm/fhir-npm-remote`,
        registryToken: 'invalid-token-xyz',
        allowHttp: true, // Enable HTTP for testing
        logger: noopLogger
      };

      const { FhirPackageInstaller } = await import('fhir-package-installer');
      const invalidFpi = new FhirPackageInstaller(invalidConfig);

      await expect(invalidFpi.checkLatestPackageDist('hl7.fhir.uv.sdc'))
        .rejects.toThrow(/Package not found/);
    }, TIMEOUT);
  });

  describe('Package Installation Tests', () => {
    it('should install packages successfully in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          const result = await context.fpi.install(testPkg);
          const isInstalled = await context.fpi.isInstalled(testPkg);
          
          expect(result).toBe(true);
          expect(isInstalled).toBe(true);
          
          return { installed: true, mode: context.mode };
        },
        { 
          cachePath: path.join(customCachePath, 'install-test'),
          skipExamples: true,
          logger: noopLogger 
        }
      );

      expect(results.direct.installed).toBe(true);
      expect(results.artifactory.installed).toBe(true);
      expect(results.direct.mode).toBe('direct');
      expect(results.artifactory.mode).toBe('artifactory');
    }, TIMEOUT);

    it('should handle package metadata correctly in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // First install the package
          await context.fpi.install(testPkg);
          
          const manifest = await context.fpi.getManifest(testPkg);
          const dependencies = await context.fpi.getDependencies(testPkg);
          
          expect(manifest.name).toBe(testPkg.id);
          expect(manifest.version).toBe(testPkg.version);
          expect(dependencies).toMatchObject({
            'hl7.fhir.r4.core': '4.0.1',
            'hl7.fhir.r4.examples': '4.0.1'
          });
          
          return { manifest, dependencies };
        },
        { 
          cachePath: path.join(customCachePath, 'metadata-test'),
          skipExamples: true,
          logger: noopLogger 
        }
      );

      // Both modes should return identical metadata
      expect(results.direct.manifest).toEqual(results.artifactory.manifest);
      expect(results.direct.dependencies).toEqual(results.artifactory.dependencies);
    }, TIMEOUT);
  });

  describe('Redirect Handling Tests', () => {
    it('should handle redirects properly (mainly for Artifactory)', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // Download package which tests redirect handling
          const tempDir = temp.mkdirSync();
          const downloadPath = await context.fpi.downloadPackage(
            testPkg, 
            { destination: tempDir, extract: false }
          );
          
          expect(fs.existsSync(downloadPath)).toBe(true);
          
          // Cleanup
          await fs.remove(tempDir);
          
          return { downloadSuccessful: true, path: downloadPath };
        },
        { 
          cachePath: path.join(customCachePath, 'redirect-test'),
          logger: debugLogger // Use debug logger to see redirect messages
        }
      );

      expect(results.direct.downloadSuccessful).toBe(true);
      expect(results.artifactory.downloadSuccessful).toBe(true);
    }, TIMEOUT);
  });

  describe('Error Handling Tests', () => {
    it('should handle non-existent packages consistently', async () => {
      const fakePackage = { id: 'non.existent.package', version: '1.0.0' };
      
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          let errorMessage = '';
          try {
            await context.fpi.install(fakePackage);
          } catch (error) {
            errorMessage = (error as Error).message;
          }
          
          expect(errorMessage).toContain('not found');
          return { errorHandled: true, errorMessage };
        },
        { 
          cachePath: path.join(customCachePath, 'error-test'),
          logger: noopLogger 
        }
      );

      expect(results.direct.errorHandled).toBe(true);
      expect(results.artifactory.errorHandled).toBe(true);
      // Both should contain similar error messages
      expect(results.direct.errorMessage).toContain('not found');
      expect(results.artifactory.errorMessage).toContain('not found');
    }, TIMEOUT);
  });

  describe('Package Index Tests', () => {
    it('should generate identical package indexes in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // First install the package
          await context.fpi.install(testPkg);
          
          const index = await context.fpi.getPackageIndexFile(testPkg);
          
          expect(index).toMatchObject({
            'index-version': 2,
          });
          expect(Array.isArray(index.files)).toBe(true);
          expect(index.files.length).toBeGreaterThan(0);
          
          return { 
            indexVersion: index['index-version'],
            fileCount: index.files.length,
            firstFile: index.files[0]
          };
        },
        { 
          cachePath: path.join(customCachePath, 'index-test'),
          skipExamples: true,
          logger: noopLogger 
        }
      );

      // Indexes should be identical
      expect(results.direct.indexVersion).toBe(results.artifactory.indexVersion);
      expect(results.direct.fileCount).toBe(results.artifactory.fileCount);
      expect(results.direct.firstFile).toEqual(results.artifactory.firstFile);
    }, TIMEOUT);
  });
});
