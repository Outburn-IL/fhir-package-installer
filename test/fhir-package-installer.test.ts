/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process';
import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import { FhirPackageInstaller } from 'fhir-package-installer';
import type { FileInPackageIndex } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';
import { createTempDir } from './temp-dir';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Helper to sort index entries by 'filename'
function sortIndexEntries(entries: FileInPackageIndex[]): FileInPackageIndex[] {
  return entries.slice().sort((a, b) => a.filename.localeCompare(b.filename));
}

type ConcurrentInstallWorkerPayload = {
  workerId: string;
  ok?: boolean;
  message?: string;
  stack?: string | null;
};

type ConcurrentInstallWorkerResult = {
  workerId: number;
  code: number | null;
  stdout: string;
  stderr: string;
  payload: ConcurrentInstallWorkerPayload | null;
};

function parseWorkerPayload(output: string): ConcurrentInstallWorkerPayload | null {
  const lines = output
    .trim()
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(lines[lines.length - 1]) as ConcurrentInstallWorkerPayload;
  } catch {
    return null;
  }
}

async function runConcurrentInstallWorkers(args: {
  packageId: string;
  cachePath: string;
  registryUrl: string;
  workerCount?: number;
  loggerMode?: 'noop' | 'debug';
}): Promise<ConcurrentInstallWorkerResult[]> {
  const workerCount = args.workerCount ?? 3;
  const moduleUrl = pathToFileURL(path.resolve('.', 'dist', 'index.mjs')).href;
  const startBarrierDir = path.join(args.cachePath, '.test-worker-start-barrier');
  const workerCode = `
const fs = await import('node:fs/promises');
const path = await import('node:path');
const makeLogger = () => {
  if (process.env.SESSION4_LOGGER_MODE !== 'debug') {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    debug: (message) => console.log('[debug]', message),
    info: (message) => console.log('[info]', message),
    warn: () => {},
    error: () => {},
  };
};
const { FhirPackageInstaller } = await import(process.env.SESSION4_FPI_MODULE_URL);
const installer = new FhirPackageInstaller({
  cachePath: process.env.SESSION4_CACHE_PATH,
  registryUrl: process.env.SESSION4_REGISTRY_URL,
  allowHttp: true,
  skipExamples: true,
  logger: makeLogger(),
});
const workerId = process.env.SESSION4_WORKER_ID;

const waitForStartBarrier = async () => {
  const barrierDir = process.env.SESSION4_START_BARRIER_DIR;
  const expectedWorkers = Number(process.env.SESSION4_START_BARRIER_COUNT ?? '1');
  if (!barrierDir || expectedWorkers <= 1) {
    return;
  }

  const timeoutMs = Number(process.env.SESSION4_START_BARRIER_TIMEOUT_MS ?? '10000');
  const settleMs = Number(process.env.SESSION4_START_BARRIER_SETTLE_MS ?? '100');
  const startedAt = Date.now();
  await fs.mkdir(barrierDir, { recursive: true });
  await fs.writeFile(path.join(barrierDir, String(workerId) + '.ready'), 'ready', 'utf8');

  while (true) {
    const readyFiles = (await fs.readdir(barrierDir)).filter((filename) => filename.endsWith('.ready'));
    if (readyFiles.length >= expectedWorkers) {
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for ' + expectedWorkers + ' concurrent test workers to reach the start barrier.');
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

try {
  await waitForStartBarrier();
  const ok = await installer.install(process.env.SESSION4_PACKAGE_ID);
  console.log(JSON.stringify({ workerId, ok }));
} catch (error) {
  console.error(JSON.stringify({
    workerId,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  }));
  process.exit(1);
}
`;

  const runWorker = async (workerId: number): Promise<ConcurrentInstallWorkerResult> => {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SESSION4_FPI_MODULE_URL: moduleUrl,
          SESSION4_CACHE_PATH: args.cachePath,
          SESSION4_REGISTRY_URL: args.registryUrl,
          SESSION4_PACKAGE_ID: args.packageId,
          SESSION4_WORKER_ID: String(workerId),
          SESSION4_LOGGER_MODE: args.loggerMode ?? 'noop',
          SESSION4_START_BARRIER_DIR: startBarrierDir,
          SESSION4_START_BARRIER_COUNT: String(workerCount),
          SESSION4_START_BARRIER_TIMEOUT_MS: '10000',
          SESSION4_START_BARRIER_SETTLE_MS: '100',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => {
        resolve({
          workerId,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          payload: parseWorkerPayload(stdout || stderr),
        });
      });
    });
  };

  return await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
}

async function expectMaterializedPackage(cachePath: string, packageId: { id: string; version: string }, expectedFiles: string[]): Promise<void> {
  const packageDir = path.join(cachePath, `${packageId.id}#${packageId.version}`, 'package');
  const indexPath = path.join(packageDir, '.fpi.index.json');
  const index = await fs.readJSON(indexPath, { encoding: 'utf8' }) as { files: Array<{ filename: string }> };

  expect(Array.isArray(index.files)).toBe(true);
  expect(sortIndexEntries(index.files as FileInPackageIndex[]).map((file) => file.filename)).toEqual([...expectedFiles].sort());
  for (const filename of expectedFiles) {
    expect(await fs.exists(path.join(packageDir, filename))).toBe(true);
  }
}

// Keep this for quickly toggling a few edge-case tests while iterating locally.
const skip = false;

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('fhir-package-installer module', () => {
  const fakePackage = { id: 'fake-package', version: '1.0.0' };
  const testPkg = { id: 'test.pkg', version: '1.0.0' };
  const depPkg = { id: 'dep.pkg', version: '1.0.0' };
  const rootPkg = { id: 'root.pkg', version: '1.0.0' };
  const branchDepAPkg = { id: 'branch.dep.a', version: '1.0.0' };
  const branchDepBPkg = { id: 'branch.dep.b', version: '1.0.0' };
  const branchRootPkg = { id: 'branch.root.pkg', version: '1.0.0' };
  const fshGeneratedPkg = { id: 'fsh.test.pkg', version: '0.1.0' };
  const tstPkgHash = `${testPkg.id}#${testPkg.version}`;
  const tstPkgAt = `${testPkg.id}@${testPkg.version}`;

  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache');

  const registryPackages = {
    [testPkg.id]: {
      latest: testPkg.version,
      versions: {
        [testPkg.version]: {
          tgz: Buffer.alloc(0) as any,
        },
      },
    },
    [depPkg.id]: {
      latest: depPkg.version,
      versions: {
        [depPkg.version]: {
          tgz: Buffer.alloc(0) as any,
        },
      },
    },
    [rootPkg.id]: {
      latest: rootPkg.version,
      versions: {
        [rootPkg.version]: {
          tgz: Buffer.alloc(0) as any,
          dependencies: { [depPkg.id]: depPkg.version },
        },
      },
    },
    [branchDepAPkg.id]: {
      latest: branchDepAPkg.version,
      versions: {
        [branchDepAPkg.version]: {
          tgz: Buffer.alloc(0) as any,
          tarballDelayMs: 1500,
        },
      },
    },
    [branchDepBPkg.id]: {
      latest: branchDepBPkg.version,
      versions: {
        [branchDepBPkg.version]: {
          tgz: Buffer.alloc(0) as any,
          tarballDelayMs: 1500,
        },
      },
    },
    [branchRootPkg.id]: {
      latest: branchRootPkg.version,
      versions: {
        [branchRootPkg.version]: {
          tgz: Buffer.alloc(0) as any,
          dependencies: {
            [branchDepAPkg.id]: branchDepAPkg.version,
            [branchDepBPkg.id]: branchDepBPkg.version,
          },
        },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  const silentFpi = new FhirPackageInstaller({ logger: noopLogger });

  let customCacheFpi!: FhirPackageInstaller;
  let testFpi!: FhirPackageInstaller;

  const downloadedPackagesPath = path.join('.', 'test', 'downloaded-packages');
  const resolvedDownloadedPackagesPath = path.resolve(downloadedPackagesPath);
  const fshGeneratedPath = path.join(path.resolve('.'), 'test', 'fsh-generated');

  beforeAll(async () => {
    await registry.start();

    // Create tiny package tarballs for local registry server
    const testTgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: testPkg.id, version: testPkg.version, dependencies: {} }),
      'package/ValueSet-test.json': JSON.stringify({ resourceType: 'ValueSet', id: 'test', url: 'http://example.org/ValueSet/test', name: 'TestVS', version: '1.0.0' }),
      'package/CodeSystem-test.json': JSON.stringify({ resourceType: 'CodeSystem', id: 'test', url: 'http://example.org/CodeSystem/test', name: 'TestCS', version: '1.0.0', content: 'complete' }),
    });
    const depTgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: depPkg.id, version: depPkg.version, dependencies: {} }),
      'package/StructureDefinition-dep.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'dep', url: 'http://example.org/StructureDefinition/dep', name: 'Dep', version: '1.0.0', kind: 'resource', type: 'Patient' }),
    });
    const rootTgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: rootPkg.id, version: rootPkg.version, dependencies: { [depPkg.id]: depPkg.version } }),
      'package/StructureDefinition-root.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'root', url: 'http://example.org/StructureDefinition/root', name: 'Root', version: '1.0.0', kind: 'resource', type: 'Patient' }),
    });
    const branchDepATgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: branchDepAPkg.id, version: branchDepAPkg.version, dependencies: {} }),
      'package/StructureDefinition-branch-a.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'branch-a', url: 'http://example.org/StructureDefinition/branch-a', name: 'BranchA', version: '1.0.0', kind: 'resource', type: 'Patient' }),
    });
    const branchDepBTgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: branchDepBPkg.id, version: branchDepBPkg.version, dependencies: {} }),
      'package/StructureDefinition-branch-b.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'branch-b', url: 'http://example.org/StructureDefinition/branch-b', name: 'BranchB', version: '1.0.0', kind: 'resource', type: 'Patient' }),
    });
    const branchRootTgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: branchRootPkg.id,
        version: branchRootPkg.version,
        dependencies: {
          [branchDepAPkg.id]: branchDepAPkg.version,
          [branchDepBPkg.id]: branchDepBPkg.version,
        },
      }),
      'package/StructureDefinition-branch-root.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'branch-root', url: 'http://example.org/StructureDefinition/branch-root', name: 'BranchRoot', version: '1.0.0', kind: 'resource', type: 'Patient' }),
    });

    // Mutate the captured packages object by reference.
    registryPackages[testPkg.id].versions[testPkg.version].tgz = testTgz;
    registryPackages[depPkg.id].versions[depPkg.version].tgz = depTgz;
    registryPackages[rootPkg.id].versions[rootPkg.version].tgz = rootTgz;
    registryPackages[branchDepAPkg.id].versions[branchDepAPkg.version].tgz = branchDepATgz;
    registryPackages[branchDepBPkg.id].versions[branchDepBPkg.version].tgz = branchDepBTgz;
    registryPackages[branchRootPkg.id].versions[branchRootPkg.version].tgz = branchRootTgz;

    customCacheFpi = new FhirPackageInstaller({
      cachePath: customCachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });

    testFpi = new FhirPackageInstaller({
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });

    // cleanup before running tests
    await fs.remove(customCachePath);
    await fs.remove(resolvedDownloadedPackagesPath);
  }, 20000);

  afterAll(async () => {
    await registry.stop();
  }, 20000);

  it('should return correct fake package directory path (default cache)', async () => {
    const expectedPath = path.join(testFpi.getCachePath(), 'fake-package#1.0.0');
    expect(await testFpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should return correct package directory path (custom cache)', async () => {
    const expectedPath = path.join(customCachePath, 'fake-package#1.0.0');
    expect(await customCacheFpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should throw ENOENT on getPackageIndexFile for fake package', async () => {
    await expect(silentFpi.getPackageIndexFile(fakePackage))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should return false for isInstalled on fake package', async () => {
    expect(await testFpi.isInstalled(fakePackage)).toBe(false);
  });

  it('should return false for isInstalled on deleted real package', async () => {
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgHash)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgAt)).toBe(false);
  });

  it('should correctly detect latest available version of test package', async () => {
    // Use the custom-cache instance to keep disk cache writes inside test workspace.
    const latest = await customCacheFpi.checkLatestPackageDist(testPkg.id);
    expect(latest).toBe(testPkg.version);
  });

  it('should install the test package successfully', async () => {
    const result = await customCacheFpi.install(testPkg);
    expect(result).toBe(true);
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(true);
  }, TIMEOUT);

  it('should repair incomplete visible package directories before treating them as installed', async () => {
    const repairCachePath = createTempDir();
    const repairFpi = new FhirPackageInstaller({
      cachePath: repairCachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });

    const packageDir = path.join(repairCachePath, `${testPkg.id}#${testPkg.version}`, 'package');
    await fs.ensureDir(packageDir);
    await fs.writeJSON(path.join(packageDir, 'package.json'), {
      name: testPkg.id,
      version: testPkg.version,
      dependencies: {},
    });
    await fs.writeJSON(path.join(packageDir, '.fpi.index.json'), {
      'index-version': 2,
      files: [{
        filename: 'ValueSet-test.json',
        resourceType: 'ValueSet',
        id: 'test',
        url: 'http://example.org/ValueSet/test',
        name: 'TestVS',
        version: '1.0.0',
      }],
    });

    try {
      expect(await repairFpi.isInstalled(testPkg, { deep: false })).toBe(false);

      const result = await repairFpi.install(testPkg);
      expect(result).toBe(true);
      expect(await repairFpi.isInstalled(testPkg)).toBe(true);
      expect(await fs.exists(path.join(packageDir, 'ValueSet-test.json'))).toBe(true);
      expect(await fs.exists(path.join(packageDir, 'CodeSystem-test.json'))).toBe(true);

      const repairedIndex = await repairFpi.getPackageIndexFile(testPkg);
      expect(repairedIndex.files).toHaveLength(2);
    } finally {
      await fs.remove(repairCachePath);
    }
  }, TIMEOUT);

  it('should generate .fpi.index.json in place for legacy-complete packages without reinstalling', async () => {
    const compatibilityCachePath = createTempDir();
    const compatibilityFpi = new FhirPackageInstaller({
      cachePath: compatibilityCachePath,
      skipExamples: true,
      registryUrl: 'n/a',
      logger: noopLogger,
    });

    const packageDir = path.join(compatibilityCachePath, `${testPkg.id}#${testPkg.version}`, 'package');
    const legacyIndexPath = path.join(packageDir, '.index.json');
    const fpiIndexPath = path.join(packageDir, '.fpi.index.json');
    const sentinelPath = path.join(packageDir, 'compatibility-sentinel.txt');

    await fs.ensureDir(packageDir);
    await fs.writeJSON(path.join(packageDir, 'package.json'), {
      name: testPkg.id,
      version: testPkg.version,
      dependencies: {},
    });
    await fs.writeJSON(path.join(packageDir, 'ValueSet-test.json'), {
      resourceType: 'ValueSet',
      id: 'test',
      url: 'http://example.org/ValueSet/test',
      name: 'TestVS',
      version: '1.0.0',
    });
    await fs.writeJSON(path.join(packageDir, 'CodeSystem-test.json'), {
      resourceType: 'CodeSystem',
      id: 'test',
      url: 'http://example.org/CodeSystem/test',
      name: 'TestCS',
      version: '1.0.0',
      content: 'complete',
    });
    await fs.writeJSON(legacyIndexPath, {
      'index-version': 2,
      files: [
        {
          filename: 'ValueSet-test.json',
          resourceType: 'ValueSet',
          id: 'test',
          url: 'http://example.org/ValueSet/test',
          name: 'TestVS',
          version: '1.0.0',
        },
        {
          filename: 'CodeSystem-test.json',
          resourceType: 'CodeSystem',
          id: 'test',
          url: 'http://example.org/CodeSystem/test',
          name: 'TestCS',
          version: '1.0.0',
          content: 'complete',
        },
      ],
    });
    await fs.writeFile(sentinelPath, 'keep-me');

    try {
      expect(await fs.exists(fpiIndexPath)).toBe(false);
      expect(await compatibilityFpi.isInstalled(testPkg, { deep: false })).toBe(true);
      expect(await fs.exists(fpiIndexPath)).toBe(true);

      const result = await compatibilityFpi.install(testPkg);
      expect(result).toBe(true);
      expect(await fs.readFile(sentinelPath, 'utf8')).toBe('keep-me');
      expect(await compatibilityFpi.isInstalled(testPkg)).toBe(true);

      const generatedIndex = await fs.readJSON(fpiIndexPath, { encoding: 'utf8' });
      expect(generatedIndex.files).toHaveLength(2);
    } finally {
      await fs.remove(compatibilityCachePath);
    }
  }, TIMEOUT);

  it('should reuse a persisted materialization marker across installer instances after the first strict check', async () => {
    const materializationCachePath = createTempDir();
    const packageRoot = path.join(materializationCachePath, `${testPkg.id}#${testPkg.version}`);
    const packageDir = path.join(packageRoot, 'package');
    const markerPath = path.join(packageRoot, '.fpi.materialized');
    const fileCount = 200;

    await fs.ensureDir(packageDir);
    await fs.writeJSON(path.join(packageDir, 'package.json'), {
      name: testPkg.id,
      version: testPkg.version,
      dependencies: {},
    });

    const files = Array.from({ length: fileCount }, (_, index) => `ValueSet-${index}.json`);
    for (const filename of files) {
      await fs.writeJSON(path.join(packageDir, filename), {
        resourceType: 'ValueSet',
        id: filename,
        url: `http://example.org/${filename}`,
        name: filename,
        version: '1.0.0',
      });
    }

    await fs.writeJSON(path.join(packageDir, '.fpi.index.json'), {
      'index-version': 2,
      files: files.map((filename) => ({
        filename,
        resourceType: 'ValueSet',
        id: filename,
        url: `http://example.org/${filename}`,
        name: filename,
        version: '1.0.0',
      })),
    });

    const firstInstaller = new FhirPackageInstaller({ cachePath: materializationCachePath, registryUrl: 'n/a', logger: noopLogger });
    const secondInstaller = new FhirPackageInstaller({ cachePath: materializationCachePath, registryUrl: 'n/a', logger: noopLogger });
    const readdirSpy = vi.spyOn(fs, 'readdir');

    try {
      expect(await firstInstaller.isInstalled(testPkg, { deep: false })).toBe(true);
      expect(await fs.exists(markerPath)).toBe(true);

      const firstReaddirCount = readdirSpy.mock.calls.length;
      readdirSpy.mockClear();

      expect(await secondInstaller.isInstalled(testPkg, { deep: false })).toBe(true);
      const secondReaddirCount = readdirSpy.mock.calls.length;

      expect(firstReaddirCount).toBe(1);
      expect(secondReaddirCount).toBe(0);
    } finally {
      readdirSpy.mockRestore();
      await fs.remove(materializationCachePath);
    }
  }, TIMEOUT);

  it('should fall back to a full inspection when a persisted materialization marker becomes stale', async () => {
    const materializationCachePath = createTempDir();
    const packageRoot = path.join(materializationCachePath, `${testPkg.id}#${testPkg.version}`);
    const packageDir = path.join(packageRoot, 'package');
    const missingFilename = 'ValueSet-missing.json';

    await fs.ensureDir(packageDir);
    await fs.writeJSON(path.join(packageDir, 'package.json'), {
      name: testPkg.id,
      version: testPkg.version,
      dependencies: {},
    });
    await fs.writeJSON(path.join(packageDir, missingFilename), {
      resourceType: 'ValueSet',
      id: 'missing',
      url: 'http://example.org/missing',
      name: 'missing',
      version: '1.0.0',
    });
    await fs.writeJSON(path.join(packageDir, '.fpi.index.json'), {
      'index-version': 2,
      files: [{
        filename: missingFilename,
        resourceType: 'ValueSet',
        id: 'missing',
        url: 'http://example.org/missing',
        name: 'missing',
        version: '1.0.0',
      }],
    });

    const firstInstaller = new FhirPackageInstaller({ cachePath: materializationCachePath, registryUrl: 'n/a', logger: noopLogger });
    const secondInstaller = new FhirPackageInstaller({ cachePath: materializationCachePath, registryUrl: 'n/a', logger: noopLogger });

    try {
      expect(await firstInstaller.isInstalled(testPkg, { deep: false })).toBe(true);

      await fs.remove(path.join(packageDir, missingFilename));

      expect(await secondInstaller.isInstalled(testPkg, { deep: false })).toBe(false);
    } finally {
      await fs.remove(materializationCachePath);
    }
  }, TIMEOUT);

  it('should install the same package concurrently across processes into one shared cache', async () => {
    const sharedCachePath = createTempDir();

    try {
      const results = await runConcurrentInstallWorkers({
        packageId: tstPkgAt,
        cachePath: sharedCachePath,
        registryUrl: registry.getBaseUrl(),
      });

      for (const result of results) {
        expect(result.code).toBe(0);
        expect(result.payload).toMatchObject({ workerId: String(result.workerId), ok: true });
      }

      await expectMaterializedPackage(sharedCachePath, testPkg, [
        'CodeSystem-test.json',
        'ValueSet-test.json',
      ]);
    } finally {
      await fs.remove(sharedCachePath);
    }
  }, TIMEOUT);

  it('should log package-install lock contention and wait-state checks at debug level', async () => {
    const sharedCachePath = createTempDir();
    const debugMessages: string[] = [];
    const debugLogger: Logger = {
      debug: (message) => debugMessages.push(String(message)),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const debugFpi = new FhirPackageInstaller({
      cachePath: sharedCachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: debugLogger,
    });

    try {
      const debugFpiAny = debugFpi as any;
      const locksDir = await debugFpiAny.ensureDiskCacheSubdir('locks');
      const lockKey = debugFpiAny.getPackageInstallLockKey(testPkg);
      const lockPath = path.join(locksDir, `${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`);
      await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });

      const packageDir = path.join(sharedCachePath, `${testPkg.id}#${testPkg.version}`, 'package');
      const materializeWhileWaiting = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fs.ensureDir(packageDir);
        await fs.writeJSON(path.join(packageDir, 'package.json'), {
          name: testPkg.id,
          version: testPkg.version,
          dependencies: {},
        });
        await fs.writeJSON(path.join(packageDir, 'ValueSet-test.json'), {
          resourceType: 'ValueSet',
          id: 'test',
          url: 'http://example.org/ValueSet/test',
          name: 'TestVS',
          version: '1.0.0',
        });
        await fs.writeJSON(path.join(packageDir, '.fpi.index.json'), {
          'index-version': 2,
          files: [
            {
              filename: 'ValueSet-test.json',
              resourceType: 'ValueSet',
              id: 'test',
              url: 'http://example.org/ValueSet/test',
              name: 'TestVS',
              version: '1.0.0',
            },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await fs.remove(lockPath).catch(() => undefined);
      })();

      await expect(debugFpi.install(testPkg)).resolves.toBe(true);
      await materializeWhileWaiting;

      const joinedLogs = debugMessages.join('\n');
      expect(joinedLogs).toContain('Another process holds package install test.pkg@1.0.0; entering wait loop.');
      expect(joinedLogs).toContain('Current materialization state: materialization=incomplete reason=package-root-missing.');
      expect(joinedLogs).toContain('Still waiting for package install test.pkg@1.0.0');
      expect(joinedLogs).toContain('Package test.pkg@1.0.0 was materialized while waiting for the package install lock; skipping download and using the shared cache entry.');
    } finally {
      await fs.remove(sharedCachePath);
    }
  }, TIMEOUT);

  it('should install a dependency chain concurrently across processes into one shared cache', async () => {
    const sharedCachePath = createTempDir();

    try {
      const results = await runConcurrentInstallWorkers({
        packageId: `${rootPkg.id}@${rootPkg.version}`,
        cachePath: sharedCachePath,
        registryUrl: registry.getBaseUrl(),
      });

      for (const result of results) {
        expect(result.code).toBe(0);
        expect(result.payload).toMatchObject({ workerId: String(result.workerId), ok: true });
      }

      await expectMaterializedPackage(sharedCachePath, rootPkg, ['StructureDefinition-root.json']);
      await expectMaterializedPackage(sharedCachePath, depPkg, ['StructureDefinition-dep.json']);
    } finally {
      await fs.remove(sharedCachePath);
    }
  }, TIMEOUT);

  it('should distribute sibling dependency installs across concurrent workers', async () => {
    const sharedCachePath = createTempDir();

    try {
      const results = await runConcurrentInstallWorkers({
        packageId: `${branchRootPkg.id}@${branchRootPkg.version}`,
        cachePath: sharedCachePath,
        registryUrl: registry.getBaseUrl(),
        workerCount: 2,
        loggerMode: 'debug',
      });

      for (const result of results) {
        expect(result.code).toBe(0);
        expect(result.payload).toMatchObject({ workerId: String(result.workerId), ok: true });
      }

      await expectMaterializedPackage(sharedCachePath, branchRootPkg, ['StructureDefinition-branch-root.json']);
      await expectMaterializedPackage(sharedCachePath, branchDepAPkg, ['StructureDefinition-branch-a.json']);
      await expectMaterializedPackage(sharedCachePath, branchDepBPkg, ['StructureDefinition-branch-b.json']);

      const depAWorkerIds = results
        .filter((result) => result.stdout.includes(`Installed ${branchDepAPkg.id}@${branchDepAPkg.version} in the FHIR package cache`))
        .map((result) => result.workerId);
      const depBWorkerIds = results
        .filter((result) => result.stdout.includes(`Installed ${branchDepBPkg.id}@${branchDepBPkg.version} in the FHIR package cache`))
        .map((result) => result.workerId);

      expect(depAWorkerIds).toHaveLength(1);
      expect(depBWorkerIds).toHaveLength(1);
      expect(depAWorkerIds[0]).not.toBe(depBWorkerIds[0]);
    } finally {
      await fs.remove(sharedCachePath);
    }
  }, TIMEOUT);

  it('should get a valid package index file after install', async () => {
    await customCacheFpi.install(testPkg);
    const index = await customCacheFpi.getPackageIndexFile(tstPkgAt);
    expect(index).toMatchObject({ 'index-version': 2 });
    expect(index.files.length).toBeGreaterThan(0);
  });

  it('should get a valid manifest file after install', async () => {
    await customCacheFpi.install(testPkg);
    const manifest = await customCacheFpi.getManifest(tstPkgHash);
    expect(manifest.name).toBe(testPkg.id);
    expect(manifest.version).toBe(testPkg.version);
  });

  it('should parse a package string to a valid FhirPackageIdentifier object', async () => {
    const obj = await testFpi.toPackageObject('pkg.name@1.0.0');
    expect(obj).toEqual({ id: 'pkg.name', version: '1.0.0' });
  });

  it('should get valid dependencies from local fixtures', async () => {
    await customCacheFpi.install(testPkg);
    await customCacheFpi.install(rootPkg);

    expect(await customCacheFpi.getDependencies(testPkg)).toEqual({});
    expect(await customCacheFpi.getDependencies(rootPkg)).toMatchObject({
      [depPkg.id]: depPkg.version,
    });
  });

  it('should install dependency packages transitively (tiny local fixtures)', async () => {
    const result = await customCacheFpi.install(rootPkg);
    expect(result).toBe(true);
    expect(await customCacheFpi.isInstalled(rootPkg)).toBe(true);
    expect(await customCacheFpi.isInstalled(depPkg)).toBe(true);

    const deps = await customCacheFpi.getDependencies(rootPkg);
    expect(deps).toMatchObject({
      [depPkg.id]: depPkg.version,
    });
  }, TIMEOUT);

  it('should generate a stable index for the tiny test package', async () => {
    const generatedIndex = await customCacheFpi.getPackageIndexFile(tstPkgAt);
    expect(generatedIndex['index-version']).toBe(2);

    const sorted = sortIndexEntries(generatedIndex.files);
    expect(sorted).toEqual(
      sortIndexEntries([
        {
          filename: 'CodeSystem-test.json',
          resourceType: 'CodeSystem',
          id: 'test',
          url: 'http://example.org/CodeSystem/test',
          name: 'TestCS',
          version: '1.0.0',
          content: 'complete',
        },
        {
          filename: 'ValueSet-test.json',
          resourceType: 'ValueSet',
          id: 'test',
          url: 'http://example.org/ValueSet/test',
          name: 'TestVS',
          version: '1.0.0',
        },
      ] as any)
    );
  });


  it('should correctly re-generate index for tiny test package', async () => {
    const pkgDir = await customCacheFpi.getPackageDirPath(tstPkgHash);
    const indexToDelete = path.join(pkgDir, 'package', '.fpi.index.json');
    expect(fs.existsSync(indexToDelete)).toBe(true);
    fs.removeSync(indexToDelete);
    expect(fs.existsSync(indexToDelete)).toBe(false);
    const generatedIndex = await customCacheFpi.getPackageIndexFile(tstPkgAt);
    expect(generatedIndex['index-version']).toBe(2);
    expect(generatedIndex.files.length).toBeGreaterThan(0);
  });


  // Test downloadPackage function
  describe('downloadPackage', () => {
    it('download only - default path', { timeout: TIMEOUT }, async () => {
      const downloadedPath = await testFpi.downloadPackage(testPkg, { destination: downloadedPackagesPath });
      expect(downloadedPath).toBe(path.join(resolvedDownloadedPackagesPath, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    const customPath = path.join(downloadedPackagesPath, 'custom-path');
    const resolvedCustomPath = path.resolve(customPath);

    it('download only - custom path - relative', { timeout: TIMEOUT }, async () => {
      const downloadedPath = await testFpi.downloadPackage(testPkg, { destination: customPath });
      expect(downloadedPath).toBe(path.join(resolvedCustomPath, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download only - custom path - fail to override', { timeout: TIMEOUT }, async () => {
      const action = testFpi.downloadPackage(testPkg, { destination: customPath });
      await expect(action).rejects.toThrow('dest already exists.');
    });

    it('download only - custom path - override', { timeout: TIMEOUT }, async () => {
      const action = testFpi.downloadPackage(testPkg, { destination: customPath, overwrite: true });
      await expect(action).resolves.toBeDefined();
    });
    
    it('download only - custom path - absolute', { timeout: TIMEOUT }, async () => {
      const tempDirectory = createTempDir();
      const downloadedPath = await testFpi.downloadPackage(testPkg, { destination: tempDirectory });
      expect(downloadedPath).toBe(path.join(tempDirectory, `${testPkg.id}-${testPkg.version}.tgz`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
      // Clean up
      await fs.remove(tempDirectory);
    });

    it('download and extract - default path', { timeout: TIMEOUT }, async () => {
      const downloadedPath = await testFpi.downloadPackage(testPkg, { destination: downloadedPackagesPath, extract: true });
      expect(downloadedPath).toBe(path.join(resolvedDownloadedPackagesPath, `${testPkg.id}#${testPkg.version}`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download and extract - custom path', { timeout: TIMEOUT }, async () => {
      const downloadedPath = await testFpi.downloadPackage(testPkg, { destination: customPath, extract: true });
      expect(downloadedPath).toBe(path.join(resolvedCustomPath, `${testPkg.id}#${testPkg.version}`));
      expect(fs.existsSync(downloadedPath)).toBe(true);
    });

    it('download and extract - custom path - fail to override', { timeout: TIMEOUT }, async () => {
      const action = testFpi.downloadPackage(testPkg, { destination: customPath, extract: true });
      await expect(action).rejects.toThrow('dest already exists.');
    });

    it('download and extract - custom path - override', { timeout: TIMEOUT }, async () => {
      const action = testFpi.downloadPackage(testPkg, { destination: customPath, extract: true, overwrite: true });
      await expect(action).resolves.toBeDefined();
    });

    it('logs tarball download path separately from extracted folder path', { timeout: TIMEOUT }, async () => {
      const info = vi.fn();
      const logger: Logger = {
        info,
        warn: () => {},
        error: () => {},
      };
      const loggingFpi = new FhirPackageInstaller({
        allowHttp: true,
        registryUrl: registry.getBaseUrl(),
        logger,
      });
      const logDestination = path.join(downloadedPackagesPath, 'log-paths');
      const resolvedLogDestination = path.resolve(logDestination);
      const expectedDownloadPath = path.join(resolvedLogDestination, `${testPkg.id}-${testPkg.version}.tgz`);
      const expectedExtractedPath = path.join(resolvedLogDestination, `${testPkg.id}#${testPkg.version}`);

      const downloadedPath = await loggingFpi.downloadPackage(testPkg, { destination: logDestination, extract: true, overwrite: true });

      expect(downloadedPath).toBe(expectedExtractedPath);
      expect(info).toHaveBeenCalledWith(`Downloading ${testPkg.id}@${testPkg.version} to: ${expectedDownloadPath}`);
      expect(info).toHaveBeenCalledWith(`Downloaded ${testPkg.id}@${testPkg.version} to: ${expectedDownloadPath}`);
      expect(info).toHaveBeenCalledWith(`Extracted ${testPkg.id}@${testPkg.version} to: ${expectedExtractedPath}`);
    });

    it.each([
      `${testPkg.id}@${testPkg.version}`,
      `${rootPkg.id}#${rootPkg.version}`
    ])('should install package: %s', 
      { timeout: TIMEOUT, skip }, 
      async (pkg) => {
        const result = await customCacheFpi.install(pkg);
        expect(result).toBe(true);
        expect(await customCacheFpi.isInstalled(pkg)).toBe(true);
      }
    );
  }); // end of downloadPackage tests

  describe('install local package', () => {
    beforeAll(async () => {
      await fs.remove(customCachePath);
    }, TIMEOUT);

    it('should fail when src is empty', async () => {
      const action = customCacheFpi.installLocalPackage('');
      await expect(action).rejects.toThrow('Invalid path');
    });

    it('should fail when src does not exist', async () => {
      const fakePath = path.join(path.resolve('.'), 'test', 'fake-path');
      const action = customCacheFpi.installLocalPackage(fakePath);
      await  expect(action).rejects.toThrow('Invalid path');
    });

    it('should fail when src folder does not contain package/package.json', async () => {
      // arrange: temporary rename package.json to package.json.del
      const originalJsonPath = path.join(fshGeneratedPath, 'package.json');
      const newJsonPath = path.join(path.dirname(originalJsonPath), 'package.json.del');
      await fs.rename(originalJsonPath, newJsonPath);
      // act
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath);
      // assert
      await expect(action).rejects.toThrow();
      // cleanup: rename back to package.json
      await fs.rename(newJsonPath, originalJsonPath);
    });

    it('should fail when src tgz file fails to extract', async () => {
      const fakeTgzPath = path.join(fshGeneratedPath, 'fake.tgz');
      await fs.writeFile(fakeTgzPath, 'fake content');
      const action = customCacheFpi.installLocalPackage(fakeTgzPath);
      await expect(action).rejects.toThrow();
      await fs.remove(fakeTgzPath);
    });

    it('should successfully install from local folder', async () => {
      await expect(customCacheFpi.installLocalPackage(fshGeneratedPath, { installDependencies: false })).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg, { deep: false })).resolves.toBe(true);
      const pkgPath = await customCacheFpi.getPackageDirPath(fshGeneratedPkg);
      const indexPath = path.join(pkgPath, 'package', '.fpi.index.json');
      const indexExists = await fs.exists(indexPath);
      expect(indexExists).toBe(true);
    }, TIMEOUT);

    it('should return false when package is already installed', async () => {
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath, { installDependencies: false });
      await expect(action).resolves.toBe(false);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg, { deep: false })).resolves.toBe(true);
    });

    it('should return true when package is already installed and override=true', async () => {
      const action = customCacheFpi.installLocalPackage(fshGeneratedPath, { override: true, installDependencies: false });
      await expect(action).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fshGeneratedPkg, { deep: false })).resolves.toBe(true);
    });

    it('should successfully install from local folder with a custom package id', async () => {
      await expect(customCacheFpi.installLocalPackage(fshGeneratedPath, { packageId: fakePackage, installDependencies: false })).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(fakePackage, { deep: false })).resolves.toBe(true);
    }, TIMEOUT);

    it('should successfully install from local tgz file', { timeout: 1000 * 60 * 10 }, async () => {
      const testPkgPath = await customCacheFpi.getPackageDirPath(testPkg);
      const testPkgSrcPath = path.join(resolvedDownloadedPackagesPath, `${testPkg.id}-${testPkg.version}.tgz`);
      const indexPath = path.join(testPkgPath, 'package', '.fpi.index.json');
      await fs.remove(testPkgPath);
      await expect(customCacheFpi.isInstalled(testPkg)).resolves.toBe(false);
      await expect(customCacheFpi.installLocalPackage(testPkgSrcPath, { installDependencies: false })).resolves.toBe(true);
      await expect(customCacheFpi.isInstalled(testPkg)).resolves.toBe(true);
      await expect(fs.exists(indexPath)).resolves.toBe(true);
    });

    // end of install local package tests
  });
});
