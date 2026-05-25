/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import https from 'https';
import http from 'http';
import fs from 'fs-extra';
import pLimit from 'p-limit';
import path from 'path';
import { Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import * as zlib from 'zlib';
import os from 'os';
import semver from 'semver';
import crypto from 'crypto';
 

import type {
  FileInPackageIndex,
  PackageIndex,
  PackageManifest
} from '@outburn/types';

import type {
  FpiConfig,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions
} from './types';
import { Logger, FhirPackageIdentifier } from '@outburn/types';

const tempDirs = new Set<string>();
let tempCleanupRegistered = false;

const registerTempCleanup = (): void => {
  if (tempCleanupRegistered) return;
  tempCleanupRegistered = true;
  process.once('exit', () => {
    for (const dir of tempDirs) {
      try {
        fs.removeSync(dir);
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.clear();
  });
};

const createTempDir = (baseDir?: string): string => {
  registerTempCleanup();
  const parentDir = baseDir ?? os.tmpdir();
  fs.ensureDirSync(parentDir);
  const dir = fs.mkdtempSync(path.join(parentDir, 'fhir-package-installer-'));
  tempDirs.add(dir);
  return dir;
};

// NOTE: This is injected at build time via tsup `define` (see tsup.config.ts).
// It must NOT be read from package.json at runtime (supports SEA/bundling scenarios).
declare const __FPI_VERSION__: string | undefined;
const FPI_VERSION = typeof __FPI_VERSION__ === 'string' && __FPI_VERSION__.trim().length > 0
  ? __FPI_VERSION__
  : '0.0.0';
const FPI_INDEX_CACHE_VERSION = (() => {
  const v = semver.parse(FPI_VERSION);
  if (!v) return '0.0';
  return `${v.major}.${v.minor}`;
})();
const FPI_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FPI_MATERIALIZATION_MARKER = '.fpi.materialized';
const DEPENDENCY_CLAIM_WAIT_MS = 1000;
const DEPENDENCY_POST_CLAIM_YIELD_MS = 500;
const DEPENDENCY_WAIT_LOG_INTERVAL_MS = 5000;
const PACKAGE_INSTALL_WAIT_LOG_INTERVAL_MS = 5000;
const DEPENDENCY_PEER_HANDOFF_WAIT_MS = 3000;
const DEPENDENCY_PEER_DISCOVERY_GRACE_MS = 300;

/**
 * Mapping from core FHIR packages to their implicit dependencies
 * Based on https://chat.fhir.org/#narrow/stream/179239-tooling/topic/New.20Implicit.20Package/near/325318949
 */
const IMPLICIT_DEPENDENCIES_MAP: Record<string, string[]> = {
  'hl7.fhir.r3.core': [
    'hl7.terminology.r3', 
    'hl7.fhir.uv.extensions.r3'
  ],
  'hl7.fhir.r4.core': [
    'hl7.terminology.r4',
    'hl7.fhir.uv.extensions.r4'
  ],
  'hl7.fhir.r5.core': [
    'hl7.terminology.r5',
    'hl7.fhir.uv.extensions.r5'
  ]
};

const IMPLICIT_PACKAGE_IDS = (() => {
  const s = new Set<string>();
  for (const ids of Object.values(IMPLICIT_DEPENDENCIES_MAP)) {
    for (const id of ids) s.add(id);
  }
  return s;
})();

// TTL for cached registry lookups (stored under `cachePath`)
const DEFAULT_REGISTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Process-wide in-memory cache sizing
const MEM_CACHE_MAX_ENTRIES = 500;

type BoundedTtlEntry<V> = {
  value: V;
  expiresAt: number;
};

type GetDependenciesOptions = {
  rootPackage?: string | FhirPackageIdentifier;
  explicitImplicitVersions?: ReadonlyMap<string, string>;
  includePlanningFallbacks?: boolean;
};

// Lightweight bounded TTL cache with LRU-ish behavior via Map insertion order.
class BoundedTtlCache<K, V> {
  private readonly maxEntries: number;
  private readonly map = new Map<K, BoundedTtlEntry<V>>();

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Touch for LRU-ish behavior.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    const expiresAt = Date.now() + ttlMs;
    const entry: BoundedTtlEntry<V> = { value, expiresAt };

    // Touch for LRU-ish behavior.
    this.map.delete(key);
    this.map.set(key, entry);

    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value as K | undefined;
      if (firstKey === undefined) break;
      this.map.delete(firstKey);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }
}

// ---- Module-level (process-wide) single-flight maps ----
// These are intentionally module-scoped so multiple FhirPackageInstaller instances within
// the same Node process coordinate and don't duplicate work.
const inFlightJson = new Map<string, Promise<any>>();
const inFlightTarball = new Map<string, Promise<string>>();
const inFlightIndex = new Map<string, Promise<PackageIndex>>();
const inFlightImplicitEffectiveVersion = new Map<string, Promise<string>>();

// Process-wide cache for implicit package effective versions.
// Keyed by {registryUrl, cachePath, packageId} so different installer configs don't bleed into each other.
const implicitEffectiveVersionCache = new BoundedTtlCache<string, string>(MEM_CACHE_MAX_ENTRIES);

// Process-wide cache for implicit package resolution failures.
// Keyed the same way as the winner cache so repeated downstream calls can surface a stable error.
const implicitResolutionFailureCache = new BoundedTtlCache<string, Error>(MEM_CACHE_MAX_ENTRIES);

class ImplicitPackageResolutionError extends Error {
  public readonly packageId: string;
  public readonly attemptedVersions: string[];
  public readonly registryUrl: string;
  public readonly cachePath: string;
  public readonly causes: string[];

  constructor(args: {
    packageId: string;
    attemptedVersions: string[];
    registryUrl: string;
    cachePath: string;
    causes?: string[];
  }) {
    const attempted = args.attemptedVersions.length > 0 ? args.attemptedVersions.join(', ') : '(none)';
    const prefix = `Failed to resolve implicit package ${args.packageId}`;
    const meta = `attemptedVersions=[${attempted}] registryUrl=${args.registryUrl} cachePath=${args.cachePath}`;
    const causeText = (args.causes && args.causes.length > 0)
      ? ` causes=[${args.causes.join(' | ')}]`
      : '';
    super(`${prefix}. ${meta}.${causeText}`);
    this.name = 'ImplicitPackageResolutionError';
    this.packageId = args.packageId;
    this.attemptedVersions = args.attemptedVersions;
    this.registryUrl = args.registryUrl;
    this.cachePath = args.cachePath;
    this.causes = args.causes ?? [];
  }
}

type FhirPackageInstallStep =
  | 'download-tarball'
  | 'extract-tarball'
  | 'cache-package'
  | 'generate-index';

class FhirPackageInstallError extends Error {
  public readonly packageId: string;
  public readonly version: string;
  public readonly registryUrl: string;
  public readonly cachePath: string;
  public readonly step: FhirPackageInstallStep;
  public readonly tarballUrl?: string;

  constructor(args: {
    packageId: string;
    version: string;
    registryUrl: string;
    cachePath: string;
    step: FhirPackageInstallStep;
    tarballUrl?: string;
    cause?: unknown;
  }) {
    const safe = (v: unknown): string => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.message;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };

    const pkg = `${args.packageId}@${args.version}`;
    const meta = `step=${args.step} registryUrl=${args.registryUrl} cachePath=${args.cachePath}`;
    const tarball = args.tarballUrl ? ` tarballUrl=${args.tarballUrl}` : '';
    const causeText = args.cause ? ` Cause: ${safe(args.cause)}` : '';
    super(`Failed to install ${pkg}. ${meta}.${tarball}${causeText}`, { cause: args.cause });
    this.name = 'FhirPackageInstallError';
    this.packageId = args.packageId;
    this.version = args.version;
    this.registryUrl = args.registryUrl;
    this.cachePath = args.cachePath;
    this.step = args.step;
    this.tarballUrl = args.tarballUrl;
  }
}

const withSingleFlight = async <T>(
  map: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> => {
  const existing = map.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      return await fn();
    } finally {
      map.delete(key);
    }
  })();

  map.set(key, p);
  return p;
};

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

type DiskCacheEnvelope<T> = {
  expiresAt: number;
  data: T;
};

type MemCacheEnvelope<T> = {
  expiresAt?: number;
  value: T;
};

// ---- Module-level (process-wide) TTL memory cache ----
// Shared across all FhirPackageInstaller instances in the same Node process.
const memCache = new Map<string, MemCacheEnvelope<any>>();

const memGet = <T>(key: string): T | null => {
  const e = memCache.get(key);
  if (!e) return null;
  if (typeof e.expiresAt === 'number') {
    if (Date.now() >= e.expiresAt) {
      memCache.delete(key);
      return null;
    }
  }
  return e.value as T;
};

const memSet = <T>(key: string, value: T, ttlMs: number): void => {
  const expiresAt = Date.now() + ttlMs;
  // Update insertion order for LRU-ish behavior.
  memCache.delete(key);
  memCache.set(key, { expiresAt, value });
  while (memCache.size > MEM_CACHE_MAX_ENTRIES) {
    const firstKey = memCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    memCache.delete(firstKey);
  }
};

const memSetNoTtl = <T>(key: string, value: T): void => {
  // Update insertion order for LRU-ish behavior.
  memCache.delete(key);
  memCache.set(key, { value });
  while (memCache.size > MEM_CACHE_MAX_ENTRIES) {
    const firstKey = memCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    memCache.delete(firstKey);
  }
};

/**
 * Default logger is a no-op.
 *
 * This is a library module: it should not write to stdout/stderr unless the caller
 * explicitly provides a logger (e.g. a console-mapped logger in CLI apps).
 */
const defaultLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * Max number of concurrent file operations (read / write))
 */
// Cap concurrency to reduce risk of EMFILE/too-many-open-files on Windows.
const limit = pLimit(Math.max(4, Math.min(32, os.cpus().length)));

/**
 * Generates an index entry for the package resource
 * @param filename resource filename
 * @param content resource content
 * @returns FileInPackageIndex object 
 */
const extractResourceIndexEntry = (filename: string, content: PackageResource): FileInPackageIndex => {
  const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
  const indexEntry: FileInPackageIndex = {
    filename,
    resourceType: content.resourceType,
    id: content.id,
    url: evalAttribute(content.url),
    name: evalAttribute(content.name),
    version: evalAttribute(content.version),
    kind: evalAttribute(content.kind),
    type: evalAttribute(content.type),
    supplements: evalAttribute(content.supplements),
    content: evalAttribute(content.content),
    baseDefinition: evalAttribute(content.baseDefinition),
    derivation: evalAttribute(content.derivation),
    date: evalAttribute(content.date)
  };
  return indexEntry;
};

export class FhirPackageInstaller {
  private logger: Logger = defaultLogger;
  private registryUrl = 'https://packages.fhir.org';
  private registryDisabled = false;
  private registryToken?: string; // optional token for private registries
  private requestTimeoutMs = 90000; // 90 seconds
  private extractTimeoutMs = 60000; // 60 seconds
  private registryTtlMs = DEFAULT_REGISTRY_TTL_MS;
  /**
   * Path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * Default location follows FHIR spec:
   * - User apps: ~/.fhir/packages (Windows: C:\Users\<user>\.fhir\packages)
   * - System services: /var/lib/.fhir/packages (Windows: %ProgramData%\.fhir\packages)
   */
  private cachePath!: string;
  private skipExamples = false; // skip dependency installation of example packages
  private allowHttp = false; // allow HTTP URLs for testing
  private resolvingImplicitDeps = new Set<string>();
  private installingPackages = new Set<string>();

  private formatPackageForDebug(packageObject: FhirPackageIdentifier): string {
    return `${packageObject.id}@${packageObject.version}`;
  }

  private formatMaterializationStatusForDebug(status: {
    complete: boolean;
    reason: string;
    missingFiles: string[];
  }): string {
    const missingPreview = status.missingFiles.length > 0
      ? ` missingFiles=${status.missingFiles.slice(0, 3).join(',')}${status.missingFiles.length > 3 ? ',...' : ''}`
      : '';
    return `materialization=${status.complete ? 'complete' : 'incomplete'} reason=${status.reason}${missingPreview}`;
  }

  private async describePackageInstallWaitState(packageObject: FhirPackageIdentifier): Promise<string> {
    try {
      const status = await this.getPackageMaterializationStatus(packageObject, { emitTiming: true });
      return this.formatMaterializationStatusForDebug(status);
    } catch (error) {
      return `materialization-check-error=${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private formatElapsedMs(startedAtNs: bigint): string {
    return (Number(process.hrtime.bigint() - startedAtNs) / 1_000_000).toFixed(1);
  }

  private async withDebugTiming<T>(
    label: string,
    action: () => Promise<T>,
    describeResult?: (result: T) => string
  ): Promise<T> {
    if (!this.logger.debug || typeof this.logger.debug !== 'function') {
      return await action();
    }

    const startedAtNs = process.hrtime.bigint();
    try {
      const result = await action();
      const resultText = describeResult ? ` ${describeResult(result)}` : '';
      this.logger.debug(`[timing] ${label} completed in ${this.formatElapsedMs(startedAtNs)}ms.${resultText}`);
      return result;
    } catch (error) {
      this.logger.debug(
        `[timing] ${label} failed in ${this.formatElapsedMs(startedAtNs)}ms: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  private getPackageKey(packageObject: FhirPackageIdentifier): string {
    return `${packageObject.id}#${packageObject.version}`;
  }

  private normalizeDependencies(dependencies: Record<string, string>): Record<string, string> {
    if (dependencies['hl7.fhir.r4.core'] === '4.0.0') {
      return {
        ...dependencies,
        'hl7.fhir.r4.core': '4.0.1',
      };
    }
    return dependencies;
  }
  
  constructor(config?: FpiConfig) {
    const {
      logger,
      registryUrl,
      registryToken,
      cachePath,
      skipExamples,
      allowHttp,
      requestTimeoutMs,
      extractTimeoutMs,
      registryTtlMs
    } = config || {} as FpiConfig;

    // Set logger first so getDefaultCachePath() can use it for warnings
    if (logger) {
      this.logger = logger;
    }

    const normalizedCachePath = ((): string | undefined => {
      if (cachePath == null) {
        return undefined;
      }
      if (typeof cachePath !== 'string') {
        this.logger.warn?.(
          `Non-string cachePath provided (${typeof cachePath}); falling back to FHIR spec default cache path.`
        );
        return undefined;
      }
      const trimmed = cachePath.trim();
      if (trimmed === '' || trimmed.toLowerCase() === 'n/a') {
        this.logger.warn?.(
          'Non-usable cachePath provided (empty/whitespace or "n/a"); falling back to FHIR spec default cache path.'
        );
        return undefined;
      }
      return trimmed;
    })();

    this.cachePath = normalizedCachePath ?? this.getDefaultCachePath();

    if (registryUrl) {
      const normalized = registryUrl.trim();
      this.registryUrl = registryUrl;
      if (normalized.toLowerCase() === 'n/a') {
        this.registryUrl = 'n/a';
        this.registryDisabled = true;
      }
    }
    if (registryToken) {
      this.registryToken = registryToken;
    }
    if (allowHttp) {
      this.allowHttp = allowHttp;
    }

    if (typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      this.requestTimeoutMs = requestTimeoutMs;
    }
    if (typeof extractTimeoutMs === 'number' && Number.isFinite(extractTimeoutMs) && extractTimeoutMs > 0) {
      this.extractTimeoutMs = extractTimeoutMs;
    }
    // Unify registry TTL config.
    const effectiveRegistryTtlMs =
      (typeof registryTtlMs === 'number' && Number.isFinite(registryTtlMs) && registryTtlMs > 0)
        ? registryTtlMs
        : undefined;
    if (typeof effectiveRegistryTtlMs === 'number') {
      this.registryTtlMs = effectiveRegistryTtlMs;
    }
    if (skipExamples) {
      this.skipExamples = skipExamples;
    }
  }

  /**
   * Determines the default FHIR package cache path based on FHIR specifications:
   * https://confluence.hl7.org/display/FHIR/FHIR+Package+Cache
   * 
   * For user applications:
   * - Windows: C:\Users\<username>\.fhir\packages
   * - Unix/Linux: ~/.fhir/packages
   * 
   * For system services (daemons):
   * - Windows: %ProgramData%\.fhir\packages (typically C:\ProgramData\.fhir\packages)
   * - Unix/Linux: /var/lib/.fhir/packages
   * 
   * Behavior can be overridden via the FHIR_PACKAGE_CACHE_MODE environment variable:
   * - FHIR_PACKAGE_CACHE_MODE=system -> always use system service paths
   * - FHIR_PACKAGE_CACHE_MODE=user   -> always use user paths
   */
  private getDefaultCachePath(): string {
    const isWindows = process.platform === 'win32';
    const homeDir = os.homedir();

    // Allow explicit override of cache mode via environment variable
    const cacheMode = process.env.FHIR_PACKAGE_CACHE_MODE?.toLowerCase();
    let isSystemService: boolean;

    if (cacheMode === 'system') {
      isSystemService = true;
    } else if (cacheMode === 'user') {
      isSystemService = false;
    } else {
      // Detect if running as a system service/daemon
      // On Windows: Check if homedir ends with the SYSTEM profile path (no real user home)
      // Using path.normalize() handles mixed separators and ensures consistent comparison
      // On Unix: Prefer a "daemon-like" heuristic rather than only checking for root:
      //   - running as root (uid 0)
      //   - not invoked via sudo (no SUDO_USER)
      //   - missing common interactive-session variables (DISPLAY, SSH_CONNECTION, TERM)
      if (isWindows) {
        const normalizedHome = path.normalize(homeDir).toLowerCase();
        const systemProfileSuffix = path
          .normalize(path.join('Windows', 'System32', 'config', 'systemprofile'))
          .toLowerCase();
        isSystemService = normalizedHome.endsWith(systemProfileSuffix);
      } else {
        const isRoot = process.getuid?.() === 0;
        const isSudo = !!process.env.SUDO_USER;
        const hasDisplay = !!process.env.DISPLAY;
        const hasSshConnection = !!process.env.SSH_CONNECTION;
        const hasTerm = !!process.env.TERM;

        isSystemService = Boolean(
          isRoot &&
          !isSudo &&
          !hasDisplay &&
          !hasSshConnection &&
          !hasTerm
        );
      }
    }

    if (isSystemService) {
      if (isWindows) {
        // Use ProgramData environment variable as per FHIR spec.
        // If ProgramData is not set, fall back to "C:\\ProgramData" if it exists and is writable;
        // otherwise fall back to user home directory.
        let programData = process.env.ProgramData;

        if (!programData || programData.trim() === '') {
          const fallbackProgramData = 'C:\\ProgramData';
          try {
            if (fs.pathExistsSync(fallbackProgramData)) {
              fs.accessSync(fallbackProgramData, fs.constants.W_OK);
              this.logger.warn(
                'ProgramData environment variable is not set; ' +
                'using fallback "C:\\ProgramData" for system service cache directory.'
              );
              programData = fallbackProgramData;
            } else {
              this.logger.warn(
                'ProgramData environment variable is not set and ' +
                'fallback "C:\\ProgramData" does not exist. Falling back to user cache directory.'
              );
            }
          } catch {
            this.logger.warn(
              'ProgramData environment variable is not set and ' +
              'fallback "C:\\ProgramData" is not writable. Falling back to user cache directory.'
            );
          }
        }

        if (programData) {
          return path.join(programData, '.fhir', 'packages');
        }
        // ProgramData unavailable or not writable - use user home
        return path.join(homeDir, '.fhir', 'packages');
      } else {
        // Unix/Linux daemon location
        return '/var/lib/.fhir/packages';
      }
    }

    // Standard user location
    return path.join(homeDir, '.fhir', 'packages');
  }

  private async withDiskLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    options?: {
      debugLabel?: string;
      describeWaitState?: () => Promise<string>;
      waitLogIntervalMs?: number;
      proceedWithoutLockAfterTimeout?: boolean;
    }
  ): Promise<T> {
    // Lock files live under cachePath so we never write outside user-controlled boundaries.
    const locksDir = await this.ensureDiskCacheSubdir('locks');
    const lockPath = path.join(locksDir, `${sha256Hex(lockKey)}.lock`);

    const start = Date.now();
    const maxWaitMs = Math.max(1000, this.requestTimeoutMs);
    const staleMs = Math.max(2 * 60 * 1000, maxWaitMs * 2);
    const debugLabel = options?.debugLabel?.trim();
    const debugEnabled = Boolean(debugLabel) && typeof this.logger.debug === 'function';
    const waitLogIntervalMs = Math.max(250, options?.waitLogIntervalMs ?? PACKAGE_INSTALL_WAIT_LOG_INTERVAL_MS);
    const proceedWithoutLockAfterTimeout = options?.proceedWithoutLockAfterTimeout ?? true;
    let contentionObserved = false;
    let lastWaitLogAt = 0;

    const readWaitState = async (): Promise<string | null> => {
      if (!debugEnabled || !options?.describeWaitState) {
        return null;
      }
      try {
        return await options.describeWaitState();
      } catch (error) {
        return `wait-state-error=${error instanceof Error ? error.message : String(error)}`;
      }
    };

    while (true) {
      try {
        await fs.ensureDir(path.dirname(lockPath));
        await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
        if (debugEnabled) {
          const waitedMs = Date.now() - start;
          this.logger.debug?.(
            contentionObserved
              ? `Claimed ${debugLabel} after waiting ${waitedMs}ms.`
              : `Claimed ${debugLabel}.`
          );
        }
        const heartbeat = setInterval(() => {
          // Keep mtime fresh so waiters can distinguish live vs stale locks.
          fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, 1000);
        (heartbeat as any).unref?.();
        try {
          return await fn();
        } finally {
          clearInterval(heartbeat);
          await fs.remove(lockPath).catch(() => undefined);
          if (debugEnabled) {
            this.logger.debug?.(`Released ${debugLabel}.`);
          }
        }
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          // If locking fails for other reasons, don't break functionality.
          if (debugEnabled) {
            this.logger.debug?.(
              `Skipping ${debugLabel} because the lock could not be created (${e?.code || e?.message || String(e)}); proceeding without the lock.`
            );
          }
          return await fn();
        }

        const elapsedMs = Date.now() - start;
        let lockAgeMs: number | null = null;
        let waitState: string | null = null;

        if (!contentionObserved && debugEnabled) {
          waitState = await readWaitState();
          this.logger.debug?.(
            `Another process holds ${debugLabel}; entering wait loop.` +
            `${waitState ? ` Current materialization state: ${waitState}.` : ''}`
          );
        }
        contentionObserved = true;

        // If the lock looks stale, attempt to break it.
        try {
          const stat = await fs.stat(lockPath);
          lockAgeMs = Date.now() - stat.mtimeMs;
          if (lockAgeMs > staleMs) {
            if (debugEnabled) {
              waitState ??= await readWaitState();
              this.logger.debug?.(
                `Breaking stale ${debugLabel} after waiting ${elapsedMs}ms (lockAgeMs=${Math.round(lockAgeMs)}).` +
                `${waitState ? ` Current materialization state: ${waitState}.` : ''}`
              );
            }
            await fs.remove(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          // ignore
        }

        if (Date.now() - start > maxWaitMs) {
          if (proceedWithoutLockAfterTimeout) {
            // Avoid deadlocks: proceed without the lock after waiting.
            if (debugEnabled) {
              waitState ??= await readWaitState();
              this.logger.debug?.(
                `Waited ${elapsedMs}ms for ${debugLabel}, exceeding maxWaitMs=${maxWaitMs}; proceeding without the lock.` +
                `${waitState ? ` Current materialization state: ${waitState}.` : ''}`
              );
            }
            return await fn();
          }

          if (debugEnabled && (Date.now() - lastWaitLogAt >= waitLogIntervalMs)) {
            waitState ??= await readWaitState();
            this.logger.debug?.(
              `Waited ${elapsedMs}ms for ${debugLabel}, exceeding maxWaitMs=${maxWaitMs}; continuing to wait for the live lock holder.` +
              `${waitState ? ` Current materialization state: ${waitState}.` : ''}`
            );
            lastWaitLogAt = Date.now();
          }
        }

        if (debugEnabled && (Date.now() - lastWaitLogAt >= waitLogIntervalMs)) {
          waitState ??= await readWaitState();
          const lockAgeText = typeof lockAgeMs === 'number' ? ` lockAgeMs=${Math.round(lockAgeMs)}.` : '';
          this.logger.debug?.(
            `Still waiting for ${debugLabel} after ${elapsedMs}ms.${lockAgeText}` +
            `${waitState ? ` Current materialization state: ${waitState}.` : ''}`
          );
          lastWaitLogAt = Date.now();
        }

        await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
      }
    }
  }

  private async tryWithDiskLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    options?: {
      debugLabel?: string;
    }
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const locksDir = await this.ensureDiskCacheSubdir('locks');
    const lockPath = path.join(locksDir, `${sha256Hex(lockKey)}.lock`);
    const debugLabel = options?.debugLabel?.trim();
    const debugEnabled = Boolean(debugLabel) && typeof this.logger.debug === 'function';

    try {
      await fs.ensureDir(path.dirname(lockPath));
      await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
      if (debugEnabled) {
        this.logger.debug?.(`Claimed ${debugLabel}.`);
      }
      const heartbeat = setInterval(() => {
        fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
      }, 1000);
      (heartbeat as any).unref?.();
      try {
        return { acquired: true, result: await fn() };
      } finally {
        clearInterval(heartbeat);
        await fs.remove(lockPath).catch(() => undefined);
        if (debugEnabled) {
          this.logger.debug?.(`Released ${debugLabel}.`);
        }
      }
    } catch (e: any) {
      if (e?.code === 'EEXIST') {
        return { acquired: false };
      }
      if (debugEnabled) {
        this.logger.debug?.(
          `Skipping ${debugLabel} because the lock could not be created (${e?.code || e?.message || String(e)}); proceeding without the lock.`
        );
      }
      return { acquired: true, result: await fn() };
    }
  }

  // ---- Per-cachePath persistent cache helpers ----
  private async ensureDiskCacheSubdir(name: string): Promise<string> {
    const dir = path.join(this.cachePath, '.fpi.cache', name);
    await fs.ensureDir(dir);
    return dir;
  }

  private async createWorkingTempDir(options?: { preferCache?: boolean }): Promise<string> {
    if (options?.preferCache !== false) {
      try {
        const cacheTempRoot = await this.ensureDiskCacheSubdir('tmp');
        return createTempDir(cacheTempRoot);
      } catch {
        // Fall back to the process temp directory if the cache-local temp root is unavailable.
      }
    }

    return createTempDir();
  }

  private getPackageInstallLockKey(packageObject: FhirPackageIdentifier): string {
    return `package-install|${packageObject.id}#${packageObject.version}`;
  }

  private async getInstallParticipantDir(packageObject: FhirPackageIdentifier): Promise<string> {
    const participantsRoot = await this.ensureDiskCacheSubdir('installers');
    return path.join(participantsRoot, sha256Hex(`install-participants|${this.getPackageKey(packageObject)}`));
  }

  private async withInstallParticipant<T>(packageObject: FhirPackageIdentifier, fn: () => Promise<T>): Promise<T> {
    const participantsDir = await this.getInstallParticipantDir(packageObject);
    const participantPath = path.join(
      participantsDir,
      `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.participant`
    );

    await fs.ensureDir(participantsDir);
    await fs.writeFile(participantPath, `${process.pid}\n${Date.now()}\n`, 'utf8');

    const heartbeat = setInterval(() => {
      fs.utimes(participantPath, new Date(), new Date()).catch(() => undefined);
    }, 1000);
    (heartbeat as any).unref?.();

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await fs.remove(participantPath).catch(() => undefined);
    }
  }

  private async countActiveInstallParticipants(packageObject: FhirPackageIdentifier): Promise<number> {
    const participantsDir = await this.getInstallParticipantDir(packageObject);
    if (!await fs.exists(participantsDir)) {
      return 0;
    }

    const staleMs = Math.max(2 * 60 * 1000, this.requestTimeoutMs * 2);
    const now = Date.now();
    const entries = await fs.readdir(participantsDir);
    let activeCount = 0;

    for (const entry of entries) {
      const entryPath = path.join(participantsDir, entry);
      try {
        const stat = await fs.stat(entryPath);
        if (now - stat.mtimeMs <= staleMs) {
          activeCount += 1;
        } else {
          await fs.remove(entryPath).catch(() => undefined);
        }
      } catch {
        // Ignore disappearing or unreadable participant entries.
      }
    }

    return activeCount;
  }

  private async isPackageInstallLockHeld(packageObject: FhirPackageIdentifier): Promise<boolean> {
    const locksDir = await this.ensureDiskCacheSubdir('locks');
    const lockPath = path.join(locksDir, `${sha256Hex(this.getPackageInstallLockKey(packageObject))}.lock`);
    return await fs.exists(lockPath);
  }

  private async waitForPeerDependencyHandoff(
    rootPackage: FhirPackageIdentifier,
    pendingDependencies: FhirPackageIdentifier[]
  ): Promise<void> {
    if (pendingDependencies.length === 0) {
      return;
    }

    const startedAt = Date.now();
    let peerDiscoveryGraceApplied = false;
    while (Date.now() - startedAt < DEPENDENCY_PEER_HANDOFF_WAIT_MS) {
      for (const dependency of pendingDependencies) {
        if (await this.isStrictlyMaterialized(dependency) || await this.isPackageInstallLockHeld(dependency)) {
          return;
        }
      }

      if (await this.countActiveInstallParticipants(rootPackage) <= 1) {
        if (!peerDiscoveryGraceApplied) {
          peerDiscoveryGraceApplied = true;
          await new Promise((resolve) => setTimeout(resolve, DEPENDENCY_PEER_DISCOVERY_GRACE_MS));
          continue;
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async withPackageInstallLock<T>(
    packageObject: FhirPackageIdentifier,
    fn: () => Promise<T>
  ): Promise<T> {
    const lockKey = this.getPackageInstallLockKey(packageObject);
    return await this.withDiskLock(lockKey, async () => {
      return await fn();
    }, {
      debugLabel: `package install ${this.formatPackageForDebug(packageObject)}`,
      describeWaitState: async () => await this.describePackageInstallWaitState(packageObject),
      proceedWithoutLockAfterTimeout: false,
    });
  }

  private async tryWithPackageInstallLock<T>(
    packageObject: FhirPackageIdentifier,
    fn: () => Promise<T>
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    return await this.tryWithDiskLock(this.getPackageInstallLockKey(packageObject), fn, {
      debugLabel: `package install ${this.formatPackageForDebug(packageObject)}`,
    });
  }

  private async getStagingPath(): Promise<string> {
    return await this.ensureDiskCacheSubdir('staging');
  }

  private async cleanupStaleStagingDirectories(maxAgeMs: number = FPI_STAGING_MAX_AGE_MS): Promise<void> {
    try {
      const stagingPath = await this.getStagingPath();
      const entries = await fs.readdir(stagingPath);
      const now = Date.now();
      for (const entry of entries) {
        const entryPath = path.join(stagingPath, entry);
        try {
          const stats = await fs.stat(entryPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            await fs.remove(entryPath);
          }
        } catch {
          // best-effort cleanup
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  private async createStagingDirectory(packageObject: FhirPackageIdentifier): Promise<string> {
    await this.cleanupStaleStagingDirectories();
    const stagingPath = await this.getStagingPath();
    const dirName = `${await this.toDirName(packageObject)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const fullPath = path.join(stagingPath, dirName);
    await fs.ensureDir(fullPath);
    return fullPath;
  }

  private async buildPackageIndexFromPackageDir(packageDir: string): Promise<PackageIndex> {
    return await this.withDebugTiming(
      `build-package-index packageDir=${packageDir}`,
      async () => {
        const discoverStartedAtNs = process.hrtime.bigint();
        const fileList = await fs.readdir(packageDir);
        const candidateFiles = fileList.filter(
          file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
        );
        this.logger.debug?.(
          `[index] Discovered ${candidateFiles.length} candidate JSON resources in ${packageDir} ` +
          `in ${this.formatElapsedMs(discoverStartedAtNs)}ms.`
        );

        const parseStartedAtNs = process.hrtime.bigint();
        const files = await Promise.all(
          candidateFiles.map(
            file => limit(
              async () => {
                const contentText = await fs.readFile(path.join(packageDir, file), { encoding: 'utf8' });
                const content = JSON.parse(contentText) as PackageResource;
                return extractResourceIndexEntry(file, content);
              }
            )
          )
        );

        this.logger.debug?.(
          `[index] Parsed ${files.length} resource entries from ${packageDir} ` +
          `in ${this.formatElapsedMs(parseStartedAtNs)}ms.`
        );

        return {
          'index-version': 2,
          files,
        };
      },
      (indexJson) => `fileCount=${indexJson.files.length}`
    );
  }

  private normalizeIndexEntry(entry: Record<string, unknown>): FileInPackageIndex | null {
    const filename = typeof entry.filename === 'string' ? entry.filename : null;
    const resourceType = typeof entry.resourceType === 'string' ? entry.resourceType : null;
    const id = typeof entry.id === 'string' ? entry.id : null;
    if (!filename) {
      return null;
    }
    if (!resourceType || !id) {
      return null;
    }

    const readOptionalString = (key: keyof FileInPackageIndex): string | undefined => {
      const value = entry[key as string];
      return typeof value === 'string' ? value : undefined;
    };

    return {
      filename,
      resourceType,
      id,
      url: readOptionalString('url'),
      name: readOptionalString('name'),
      version: readOptionalString('version'),
      kind: readOptionalString('kind'),
      type: readOptionalString('type'),
      supplements: readOptionalString('supplements'),
      content: readOptionalString('content'),
      baseDefinition: readOptionalString('baseDefinition'),
      derivation: readOptionalString('derivation'),
      date: readOptionalString('date'),
    };
  }

  private normalizePackageIndex(raw: unknown): PackageIndex | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const candidate = raw as { files?: unknown };
    if (!Array.isArray(candidate.files)) {
      return null;
    }

    const files: FileInPackageIndex[] = [];
    for (const file of candidate.files) {
      if (!file || typeof file !== 'object') {
        return null;
      }
      const normalized = this.normalizeIndexEntry(file as Record<string, unknown>);
      if (!normalized) {
        return null;
      }
      files.push(normalized);
    }

    return {
      'index-version': 2,
      files,
    };
  }

  private async persistMaterializedPackageIndex(
    packageObject: FhirPackageIdentifier,
    packageDir: string,
    indexJson: PackageIndex
  ): Promise<PackageIndex> {
    const indexPath = path.join(packageDir, '.fpi.index.json');
    await fs.writeJSON(indexPath, indexJson);

    const memKey = this.getIndexMemKey(packageObject);
    memSetNoTtl(memKey, indexJson);
    try {
      const diskPath = this.getDiskIndexCachePath(packageObject);
      await this.ensureDiskCacheSubdir('indexes');
      await this.writeDiskCacheJsonNoTtl(diskPath, indexJson);
    } catch {
      // ignore
    }

    return indexJson;
  }

  private async tryMaterializeLegacyPackageIndex(
    packageObject: FhirPackageIdentifier,
    packageDir: string
  ): Promise<PackageIndex | null> {
    const legacyIndexPath = path.join(packageDir, '.index.json');
    if (!await fs.exists(legacyIndexPath)) {
      return null;
    }

    return await this.withDiskLock(this.getIndexDiskLockKey(packageObject), async () => {
      const fpiIndexPath = path.join(packageDir, '.fpi.index.json');
      if (await fs.exists(fpiIndexPath)) {
        const current = await fs.readJSON(fpiIndexPath, { encoding: 'utf8' }) as unknown;
        return this.normalizePackageIndex(current);
      }

      const legacyRaw = await fs.readJSON(legacyIndexPath, { encoding: 'utf8' }) as unknown;
      const legacyIndex = this.normalizePackageIndex(legacyRaw);
      if (!legacyIndex) {
        return null;
      }

      for (const file of legacyIndex.files) {
        if (!await fs.exists(path.join(packageDir, file.filename))) {
          return null;
        }
      }

      return await this.persistMaterializedPackageIndex(packageObject, packageDir, legacyIndex);
    }, {
      proceedWithoutLockAfterTimeout: false,
    });
  }

  private async materializePackageIndex(
    packageObject: FhirPackageIdentifier,
    packageDir: string
  ): Promise<PackageIndex> {
    return await this.withDebugTiming(
      `materialize-package-index ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const memKey = this.getIndexMemKey(packageObject);
        const memHit = memGet<PackageIndex>(memKey);
        if (memHit) {
          return await this.persistMaterializedPackageIndex(packageObject, packageDir, memHit);
        }

        return await this.withDiskLock(this.getIndexDiskLockKey(packageObject), async () => {
          const memHit2 = memGet<PackageIndex>(memKey);
          if (memHit2) {
            return await this.persistMaterializedPackageIndex(packageObject, packageDir, memHit2);
          }

          const diskPath = this.getDiskIndexCachePath(packageObject);
          const diskHit = await withSingleFlight(inFlightIndex, `disk-${memKey}`, async () => {
            await this.ensureDiskCacheSubdir('indexes');
            return await this.readDiskCacheJson<PackageIndex>(diskPath);
          });
          if (diskHit) {
            return await this.persistMaterializedPackageIndex(packageObject, packageDir, diskHit);
          }

          const indexJson = await this.buildPackageIndexFromPackageDir(packageDir);
          return await this.persistMaterializedPackageIndex(packageObject, packageDir, indexJson);
        }, {
          proceedWithoutLockAfterTimeout: false,
        });
      },
      (indexJson) => `fileCount=${indexJson.files.length}`
    );
  }

  private async getPackageMaterializationStatus(
    packageObject: FhirPackageIdentifier,
    options?: { emitTiming?: boolean }
  ): Promise<{
    complete: boolean;
    reason:
      | 'package-root-missing'
      | 'package-dir-missing'
      | 'manifest-missing'
      | 'manifest-invalid'
      | 'index-missing'
      | 'index-invalid'
      | 'complete'
      | 'indexed-files-missing';
    missingFiles: string[];
  }> {
    const computeStatus = async (): Promise<{
      complete: boolean;
      reason:
        | 'package-root-missing'
        | 'package-dir-missing'
        | 'manifest-missing'
        | 'manifest-invalid'
        | 'index-missing'
        | 'index-invalid'
        | 'complete'
        | 'indexed-files-missing';
      missingFiles: string[];
    }> => {
        const packageRoot = await this.getPackageDirPath(packageObject);
        if (!await fs.exists(packageRoot)) {
          return { complete: false, reason: 'package-root-missing', missingFiles: [] };
        }

        const packageDir = path.join(packageRoot, 'package');
        if (!await fs.exists(packageDir)) {
          return { complete: false, reason: 'package-dir-missing', missingFiles: [] };
        }

        const manifestPath = path.join(packageDir, 'package.json');
        if (!await fs.exists(manifestPath)) {
          return { complete: false, reason: 'manifest-missing', missingFiles: [] };
        }

        try {
          await fs.readJSON(manifestPath, { encoding: 'utf8' });
        } catch {
          return { complete: false, reason: 'manifest-invalid', missingFiles: [] };
        }

        const indexPath = path.join(packageDir, '.fpi.index.json');
        if (!await fs.exists(indexPath)) {
          const legacyMaterializedIndex = await this.tryMaterializeLegacyPackageIndex(packageObject, packageDir);
          if (!legacyMaterializedIndex) {
            try {
              await this.materializePackageIndex(packageObject, packageDir);
            } catch {
              return { complete: false, reason: 'index-missing', missingFiles: [] };
            }
            if (!await fs.exists(indexPath)) {
              return { complete: false, reason: 'index-missing', missingFiles: [] };
            }
          }
        }

        if (await this.hasFreshMaterializationMarker(packageRoot, packageDir, manifestPath, indexPath)) {
          return { complete: true, reason: 'complete', missingFiles: [] };
        }

        let indexJson: Partial<PackageIndex>;
        try {
          indexJson = await fs.readJSON(indexPath, { encoding: 'utf8' }) as Partial<PackageIndex>;
        } catch {
          return { complete: false, reason: 'index-invalid', missingFiles: [] };
        }

        if (!Array.isArray(indexJson.files)) {
          return { complete: false, reason: 'index-invalid', missingFiles: [] };
        }

        const packageDirEntries = new Set(await fs.readdir(packageDir));
        const missingFiles: string[] = [];
        for (const file of indexJson.files) {
          const filename = typeof file?.filename === 'string' ? file.filename : null;
          if (!filename) {
            return { complete: false, reason: 'index-invalid', missingFiles: [] };
          }
          const canUseDirectoryListing = !filename.includes('/') && !filename.includes('\\');
          if (canUseDirectoryListing ? !packageDirEntries.has(filename) : !await fs.exists(path.join(packageDir, filename))) {
            missingFiles.push(filename);
          }
        }

        if (missingFiles.length > 0) {
          return { complete: false, reason: 'indexed-files-missing', missingFiles };
        }

        await this.writeMaterializationMarker(packageRoot, packageDir, manifestPath, indexPath);

        return { complete: true, reason: 'complete', missingFiles: [] };
    };

    if (!options?.emitTiming) {
      return await computeStatus();
    }

    return await this.withDebugTiming(
      `materialization-status ${this.formatPackageForDebug(packageObject)}`,
      computeStatus,
      (status) => this.formatMaterializationStatusForDebug(status)
    );
  }

  private async stagePackageForPublish(
    packageObject: FhirPackageIdentifier,
    src: string,
    move: boolean
  ): Promise<string> {
    return await this.withDebugTiming(
      `stage-package-for-publish ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const stagingRoot = await this.createStagingDirectory(packageObject);
        const sourcePackageDir = await fs.exists(path.join(src, 'package')) ? path.join(src, 'package') : src;
        const stagingPackageDir = path.join(stagingRoot, 'package');
        const packageLabel = this.formatPackageForDebug(packageObject);

        try {
          const action = move ? fs.move : fs.copy;
          const copyOrMoveStartedAtNs = process.hrtime.bigint();
          await action(sourcePackageDir, stagingPackageDir, { overwrite: false });
          this.logger.debug?.(
            `[publish] ${move ? 'Moved' : 'Copied'} staged contents for ${packageLabel} ` +
            `from ${sourcePackageDir} to ${stagingPackageDir} in ${this.formatElapsedMs(copyOrMoveStartedAtNs)}ms.`
          );
          if (move && sourcePackageDir !== src) {
            const cleanupStartedAtNs = process.hrtime.bigint();
            await fs.remove(src).catch(() => undefined);
            this.logger.debug?.(
              `[publish] Removed extraction root ${src} after staging ${packageLabel} ` +
              `in ${this.formatElapsedMs(cleanupStartedAtNs)}ms.`
            );
          }
          const materializeIndexStartedAtNs = process.hrtime.bigint();
          const materializedIndex = await this.materializePackageIndex(packageObject, stagingPackageDir);
          this.logger.debug?.(
            `[publish] Materialized package index for ${packageLabel} in staging ` +
            `in ${this.formatElapsedMs(materializeIndexStartedAtNs)}ms (fileCount=${materializedIndex.files.length}).`
          );
          const markerStartedAtNs = process.hrtime.bigint();
          await this.writeMaterializationMarker(
            stagingRoot,
            stagingPackageDir,
            path.join(stagingPackageDir, 'package.json'),
            path.join(stagingPackageDir, '.fpi.index.json')
          );
          this.logger.debug?.(
            `[publish] Wrote materialization marker for ${packageLabel} ` +
            `in ${this.formatElapsedMs(markerStartedAtNs)}ms.`
          );
          return stagingRoot;
        } catch (error) {
          await fs.remove(stagingRoot).catch(() => undefined);
          throw error;
        }
      }
    );
  }

  private isAlreadyExistsError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: string; message?: string };
    return candidate.code === 'EEXIST'
      || candidate.code === 'ENOTEMPTY'
      || /dest already exists/i.test(candidate.message ?? '');
  }

  private isRetryableStagePublishError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: string };
    return candidate.code === 'EACCES'
      || candidate.code === 'EPERM'
      || candidate.code === 'EBUSY';
  }

  private getDiskCacheKeyPrefix(): string {
    // Avoid accidental cross-registry pollution for metadata/tarballs.
    return `${this.registryUrl}`;
  }

  private async readDiskCacheJson<T>(filePath: string): Promise<T | null> {
    try {
      if (!await fs.exists(filePath)) return null;
      const raw = await fs.readJSON(filePath, { encoding: 'utf8' }) as any;
      if (!raw || typeof raw !== 'object') return null;

      // TTL envelope format: { expiresAt: number, data: T }
      if (typeof raw.expiresAt === 'number' && 'data' in raw) {
        if (Date.now() >= raw.expiresAt) {
          // Lazy eviction
          await fs.remove(filePath).catch(() => undefined);
          return null;
        }
        return raw.data as T;
      }

      // Non-TTL format: just the raw data.
      return raw as T;
    } catch {
      return null;
    }
  }

  private async writeDiskCacheJson<T>(filePath: string, data: T, ttlMs: number): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(filePath));
      const expiresAt = Date.now() + ttlMs;
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmp, { expiresAt, data } satisfies DiskCacheEnvelope<T>);
      await fs.move(tmp, filePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private async writeDiskCacheJsonNoTtl<T>(filePath: string, data: T): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(filePath));
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmp, data);
      await fs.move(tmp, filePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private getDiskRegistryMetadataCachePath(packageName: string): string {
    const key = `registry-meta|${this.getDiskCacheKeyPrefix()}|${packageName}`;
    return path.join(this.cachePath, '.fpi.cache', 'metadata', `${sha256Hex(key)}.json`);
  }

  private getDiskIndexCachePath(packageObject: FhirPackageIdentifier): string {
    const key = `index|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
    return path.join(this.cachePath, '.fpi.cache', 'indexes', `${sha256Hex(key)}.json`);
  }

  private getDiskTarballCacheKey(packageObject: FhirPackageIdentifier): string {
    return `tarball|${this.getDiskCacheKeyPrefix()}|${packageObject.id}#${packageObject.version}`;
  }

  private async getDiskTarballCachePaths(packageObject: FhirPackageIdentifier): Promise<{ tgzPath: string; donePath: string }> {
    const tarDir = await this.ensureDiskCacheSubdir('tarballs');
    const tgzPath = path.join(tarDir, `${sha256Hex(this.getDiskTarballCacheKey(packageObject))}.tgz`);
    const donePath = `${tgzPath}.done`;
    return { tgzPath, donePath };
  }

  private async readDiskTarballCache(packageObject: FhirPackageIdentifier): Promise<string | null> {
    try {
      const { tgzPath, donePath } = await this.getDiskTarballCachePaths(packageObject);
      if (!await fs.exists(tgzPath)) return null;

      // We treat tarballs as immutable when keyed by id+version.
      // Use a done marker to avoid using a partially-written tgz after a crash.
      if (!await fs.exists(donePath)) {
        await fs.remove(tgzPath).catch(() => undefined);
        return null;
      }
      return tgzPath;
    } catch {
      return null;
    }
  }

  private async writeDiskTarballDoneMarker(donePath: string): Promise<void> {
    try {
      const tmp = `${donePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, 'ok');
      await fs.move(tmp, donePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private getIndexMemKey(packageObject: FhirPackageIdentifier): string {
    // Indexes are keyed only by immutable identity (package id+version) plus FPI minor version.
    // Do not include cachePath here: different installer instances in the same process should share.
    return `index|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
  }

  private getIndexDiskLockKey(packageObject: FhirPackageIdentifier): string {
    return `index-cache|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
  }

  private getMaterializationMarkerPath(packageRoot: string): string {
    return path.join(packageRoot, FPI_MATERIALIZATION_MARKER);
  }

  private async writeMaterializationMarker(
    packageRoot: string,
    packageDir: string,
    manifestPath: string,
    indexPath: string
  ): Promise<void> {
    const markerPath = this.getMaterializationMarkerPath(packageRoot);
    const tmpPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const [packageDirStat, manifestStat, indexStat] = await Promise.all([
        fs.stat(packageDir),
        fs.stat(manifestPath),
        fs.stat(indexPath),
      ]);
      await fs.writeJSON(tmpPath, {
        packageDirMtimeMs: packageDirStat.mtimeMs,
        packageDirCtimeMs: packageDirStat.ctimeMs,
        manifestMtimeMs: manifestStat.mtimeMs,
        manifestCtimeMs: manifestStat.ctimeMs,
        indexMtimeMs: indexStat.mtimeMs,
        indexCtimeMs: indexStat.ctimeMs,
      });
      await fs.move(tmpPath, markerPath, { overwrite: true });
    } catch {
      // best-effort cache hint
    } finally {
      await fs.remove(tmpPath).catch(() => undefined);
    }
  }

  private async hasFreshMaterializationMarker(
    packageRoot: string,
    packageDir: string,
    manifestPath: string,
    indexPath: string
  ): Promise<boolean> {
    const markerPath = this.getMaterializationMarkerPath(packageRoot);
    try {
      const [marker, packageDirStat, manifestStat, indexStat] = await Promise.all([
        fs.readJSON(markerPath, { encoding: 'utf8' }) as Promise<{
          packageDirMtimeMs: number;
          packageDirCtimeMs: number;
          manifestMtimeMs: number;
          manifestCtimeMs: number;
          indexMtimeMs: number;
          indexCtimeMs: number;
        }>,
        fs.stat(packageDir),
        fs.stat(manifestPath),
        fs.stat(indexPath),
      ]);
      return marker.packageDirMtimeMs === packageDirStat.mtimeMs
        && marker.packageDirCtimeMs === packageDirStat.ctimeMs
        && marker.manifestMtimeMs === manifestStat.mtimeMs
        && marker.manifestCtimeMs === manifestStat.ctimeMs
        && marker.indexMtimeMs === indexStat.mtimeMs
        && marker.indexCtimeMs === indexStat.ctimeMs;
    } catch {
      return false;
    }
  }

  private isRegistryDisabled(): boolean {
    return this.registryDisabled;
  }

  private formatRegistryDisabledMessage(detail: string): string {
    return `FHIR package registry is disabled (registryUrl=n/a). ${detail}`;
  }

  private async hasShallowInstalledPackage(packageObject: FhirPackageIdentifier): Promise<boolean> {
    const packageRoot = await this.getPackageDirPath(packageObject);
    if (!await fs.exists(packageRoot)) {
      return false;
    }

    const packageDir = path.join(packageRoot, 'package');
    if (!await fs.exists(packageDir)) {
      return false;
    }

    const manifestPath = path.join(packageDir, 'package.json');
    if (!await fs.exists(manifestPath)) {
      return false;
    }

    const indexPath = path.join(packageDir, '.fpi.index.json');
    if (await fs.exists(indexPath)) {
      return await this.isStrictlyMaterialized(packageObject);
    }

    const legacyIndexPath = path.join(packageDir, '.index.json');
    if (await fs.exists(legacyIndexPath)) {
      return (await this.tryMaterializeLegacyPackageIndex(packageObject, packageDir)) !== null;
    }

    return true;
  }

  private async isStrictlyMaterialized(packageObject: FhirPackageIdentifier): Promise<boolean> {
    const materialization = await this.getPackageMaterializationStatus(packageObject);
    return materialization.complete;
  }

  private async hasReadableManifest(packageObject: FhirPackageIdentifier): Promise<boolean> {
    try {
      await this.getManifest(packageObject);
      return true;
    } catch {
      return false;
    }
  }

  private async collectMissingPackages(
    root: FhirPackageIdentifier,
    options?: { requireStrictMaterialization?: boolean }
  ): Promise<string[]> {
    const missing: string[] = [];
    const visited = new Set<string>();
    const { explicitImplicitVersions } = await this.collectExplicitDependencyClosure(root);
    const requireStrictMaterialization = options?.requireStrictMaterialization === true;

    const visit = async (pkg: FhirPackageIdentifier) => {
      const key = `${pkg.id}#${pkg.version}`;
      if (visited.has(key)) return;
      visited.add(key);

      const isInstalled = requireStrictMaterialization
        ? await this.isStrictlyMaterialized(pkg)
        : await this.isInstalled(pkg, { deep: false });
      if (!isInstalled) {
        missing.push(key);
        return;
      }

      const deps = await this.getDependencies(pkg, { explicitImplicitVersions });
      for (const [depId, depVersion] of Object.entries(deps || {})) {
        if (this.skipExamples && depId.includes('examples')) continue;
        await visit({ id: depId, version: depVersion });
      }
    };

    await visit(root);
    return missing;
  }

  private async collectPlannedDependencyClosure(
    root: FhirPackageIdentifier,
    seedExplicitImplicitVersions?: ReadonlyMap<string, string>
  ): Promise<Map<string, FhirPackageIdentifier>> {
    return await this.withDebugTiming(
      `collect-planned-dependency-closure ${this.formatPackageForDebug(root)}`,
      async () => {
        const { closure, explicitImplicitVersions: localExplicitImplicitVersions } = await this.collectExplicitDependencyClosure(root);
        const explicitImplicitVersions = new Map(seedExplicitImplicitVersions ?? []);
        for (const [packageId, version] of localExplicitImplicitVersions.entries()) {
          if (!explicitImplicitVersions.has(packageId)) {
            explicitImplicitVersions.set(packageId, version);
          }
        }
        const expanded = new Set<string>();
        const queue: FhirPackageIdentifier[] = [root, ...Array.from(closure.values())];

        while (queue.length > 0) {
          const current = queue.shift() as FhirPackageIdentifier;
          const currentKey = this.getPackageKey(current);
          if (expanded.has(currentKey)) {
            continue;
          }
          expanded.add(currentKey);

          const dependencies = await this.getDependenciesForPlanning(current, explicitImplicitVersions);
          for (const [depId, depVersion] of Object.entries(dependencies)) {
            if (this.skipExamples && depId.includes('examples')) {
              continue;
            }

            const dependency = { id: depId, version: depVersion };
            const dependencyKey = this.getPackageKey(dependency);
            if (!closure.has(dependencyKey)) {
              closure.set(dependencyKey, dependency);
            }
            if (!expanded.has(dependencyKey)) {
              queue.push(dependency);
            }
          }
        }

        return closure;
      },
      (closure) => `plannedPackages=${closure.size}`
    );
  }

  private async withRetries<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 5000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const isTemporary =
          err.code === 'EAI_AGAIN' ||
          err.code === 'ENOTFOUND' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNABORTED' ||
          err.message === 'aborted';
  
        if (!isTemporary || attempt === retries) {
          throw err;
        }
  
        this.logger.warn(
          `⚠️ Attempt ${attempt} failed (${err.code || err.message}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  /**
   * Takes a FhirPackageIdentifier Object and returns the corresponding directory name of the package
   * @param packageObject A PackageObject with both name and version keys
   * @returns (string) Directory name in the standard format `name#version`
   */
  private async toDirName(packageId: FhirPackageIdentifier | string): Promise<string> {
    const packageObj = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    return packageObj.id + '#' + packageObj.version;
  }

  /**
   * Takes a FhirPackageIdentifier Object and returns the path to the package folder in the cache
   * @param packageObject A FhirPackageIdentifier Object with both name and version keys
   * @returns The full path to the package directory
   */
  public async getPackageDirPath(packageId: FhirPackageIdentifier | string): Promise<string> {
    return path.join(this.cachePath, await this.toDirName(packageId));
  }

  /**
   * Get the full path to the .fpi.index.json file in the package folder
   * @param packageObject A FhirPackageIdentifier Object with both name and version keys
   * @returns (string) The path to the package index file
   */
  private async getPackageIndexPath(packageId: FhirPackageIdentifier | string): Promise<string> {
    return path.join(await this.getPackageDirPath(packageId), 'package', '.fpi.index.json');
  }


  /**
   * Scans a package folder and generates a new `.fpi.index.json` file
   * @param packageObject The package identifier object
   * @returns PackageIndex
   */
  private async generatePackageIndex(packageId: FhirPackageIdentifier | string): Promise<PackageIndex> {
    const pckIdObj = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    return await this.withDebugTiming(
      `generate-package-index ${this.formatPackageForDebug(pckIdObj)}`,
      async () => {
        this.logger.debug?.(`Generating new .fpi.index.json file for package ${pckIdObj.id}@${pckIdObj.version}...`);
        const packagePath = await this.getPackageDirPath(pckIdObj);
        return await this.materializePackageIndex(pckIdObj, path.join(packagePath, 'package'));
      },
      (indexJson) => `fileCount=${indexJson.files.length}`
    );
  }

  /**
   * Generates HTTP options including authorization header for registry requests
   * @param url The URL being requested
   * @returns HTTP options object with headers if needed
   */
  private getHttpOptions(url: string): https.RequestOptions {
    const options: https.RequestOptions = {};
    
    // Add authorization header for requests to the configured registry
    // or any URL that contains the same hostname (to handle redirects within the same registry)
    if (this.registryToken && !this.isRegistryDisabled()) {
      try {
        const registryHostname = new URL(this.registryUrl).hostname;
        const urlHostname = new URL(url).hostname;
        if (url.startsWith(this.registryUrl) || urlHostname === registryHostname) {
          options.headers = {
            'Authorization': `Bearer ${this.registryToken}`
          };
        }
      } catch (err: any) {
        // If registryUrl isn't a valid URL, skip auth headers.
        // However, log a warning so misconfiguration is visible.
        const normalizedRegistryUrl = (this.registryUrl || '').trim().toLowerCase();
        if (normalizedRegistryUrl !== 'n/a') {
          const displayUrl = url.length > 128 ? `${url.substring(0, 128)}...` : url;
          this.logger.warn(
            `Failed to parse URL(s) for auth header (registryUrl='${this.registryUrl}', url='${displayUrl}'); proceeding without auth header. ` +
            `Error: ${err?.message || String(err)}`
          );
        }
      }
    }
    
    return options;
  }

  private fetchJson(url: string, redirectCount = 0): Promise<any> {
    const maxRedirects = 5;
    
    return this.withRetries(() => new Promise((resolve, reject) => {
      const options = this.getHttpOptions(url);
      const isHttps = url.startsWith('https:');
      const isHttp = url.startsWith('http:');
      
      // Check if HTTP is allowed for testing
      if (isHttp && !this.allowHttp) {
        reject(new Error('HTTP URLs not allowed. Use HTTPS or enable allowHttp for testing.'));
        return;
      }
      
      const client = isHttps ? https : http;
      const req = client.get(url, options, (res) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects (${maxRedirects}) when fetching ${url}`));
            return;
          }
          
          const redirectTarget = res.headers.location;
          const displayUrl = redirectTarget.length > 64 
            ? `${redirectTarget.substring(0, 64)}...` 
            : redirectTarget;
          this.logger.debug?.(`Following redirect from ${url} to ${displayUrl}`);
          // Recursively follow the redirect
          this.fetchJson(res.headers.location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        // Apply a per-request inactivity timeout while reading the response
        res.setTimeout(this.requestTimeoutMs, () => {
          const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
          timeoutErr.code = 'ETIMEDOUT';
          res.destroy(timeoutErr);
        });

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          // Check for HTTP error status codes
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const errorData = JSON.parse(data);
              const errorMsg = errorData.error || errorData.message || data;
              
              // Convert authentication/authorization errors to "not found" for consistency
              if (res.statusCode === 403 || res.statusCode === 401) {
                reject(new Error('Package not found in the registry (authentication failed)'));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${errorMsg}`));
              }
            } catch {
              if (res.statusCode === 403 || res.statusCode === 401) {
                reject(new Error('Package not found in the registry (authentication failed)'));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${data || 'Unknown error'}`));
              }
            }
            return;
          }
          
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
        timeoutErr.code = 'ETIMEDOUT';
        req.destroy(timeoutErr);
      });

      req.on('error', reject);
    }));
  }  

  private fetchStream(url: string, redirectCount = 0): Promise<Readable> {
    const maxRedirects = 5;
    
    return this.withRetries(() => new Promise((resolve, reject) => {
      const options = this.getHttpOptions(url);
      const isHttps = url.startsWith('https:');
      const isHttp = url.startsWith('http:');
      
      // Check if HTTP is allowed for testing
      if (isHttp && !this.allowHttp) {
        reject(new Error('HTTP URLs not allowed. Use HTTPS or enable allowHttp for testing.'));
        return;
      }
      
      const client = isHttps ? https : http;
      const req = client.get(url, options, (res) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects (${maxRedirects}) when fetching ${url}`));
            return;
          }
          
          const redirectTarget = res.headers.location;
          const displayUrl = redirectTarget.length > 64 
            ? `${redirectTarget.substring(0, 64)}...` 
            : redirectTarget;
          this.logger.debug?.(`Following redirect from ${url} to ${displayUrl}`);
          // Recursively follow the redirect
          this.fetchStream(res.headers.location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        if (res.statusCode === 200) {
          res.setTimeout(this.requestTimeoutMs, () => {
            const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
            timeoutErr.code = 'ETIMEDOUT';
            res.destroy(timeoutErr);
          });
          resolve(res);
        } else {
          const code = res.statusCode ?? 0;
          if (code === 404) {
            reject(new Error(`Failed to fetch ${url} (status 404): not found`));
          } else {
            reject(new Error(`Failed to fetch ${url} (status ${code})`));
          }
        }
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
        timeoutErr.code = 'ETIMEDOUT';
        req.destroy(timeoutErr);
      });

      req.on('error', reject);
    }));
  }  

  private async getPackageDataFromRegistry(packageName: string): Promise<Record<string, any>> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(`Cannot query registry for package metadata (${packageName}).`));
    }

    const url = `${this.registryUrl}/${packageName}/`;
    const cacheKey = `fetch-json|${url}`;

    // Layer 1: memory
    const memKey = `registry-meta|${this.registryUrl}|${packageName}`;
    const memHit = memGet<Record<string, any>>(memKey);
    if (memHit) return memHit;

    // Layer 2: per-cachePath disk
    const diskPath = this.getDiskRegistryMetadataCachePath(packageName);

    return await withSingleFlight(inFlightJson, cacheKey, async () => {
      const memHit2 = memGet<Record<string, any>>(memKey);
      if (memHit2) return memHit2;

      return await this.withDiskLock(`registry-meta|${this.getDiskCacheKeyPrefix()}|${packageName}`, async () => {
        const memHit3 = memGet<Record<string, any>>(memKey);
        if (memHit3) return memHit3;

        try {
          await this.ensureDiskCacheSubdir('metadata');
          const diskHit = await this.readDiskCacheJson<Record<string, any>>(diskPath);
          if (diskHit) {
            memSet(memKey, diskHit, this.registryTtlMs);
            return diskHit;
          }
        } catch {
          // ignore disk cache read errors
        }

        // Only log when we are about to perform a real registry request.
        // Cache hits (memory/disk) should remain silent to avoid console clutter.
        this.logger.debug?.(`Fetching registry metadata for FHIR package ${packageName} from ${this.registryUrl}`);
        const data = await this.fetchJson(url);
        memSet(memKey, data, this.registryTtlMs);
        await this.writeDiskCacheJson(diskPath, data, this.registryTtlMs);
        return data;
      });
    });
  }

  private async getTarballUrl(packageObject: FhirPackageIdentifier): Promise<string> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(
        `Cannot download ${packageObject.id}@${packageObject.version}. Required packages must already exist in the package cache (${this.cachePath}).`
      ));
    }

    if (!packageObject.version || packageObject.version.trim().length === 0) {
      throw new Error(`Invalid package version for ${packageObject.id}`);
    }

    // A specific package version is immutable. Prefer a deterministic tarball URL.
    // This avoids extra registry metadata calls, reducing rate-limit pressure.
    const isPrivateRegistry = this.registryUrl !== 'https://packages.fhir.org';
    
    // For private registries, construct the URL using the registry base (don't trust provided tarball URLs)
    if (isPrivateRegistry) {
      return `${this.registryUrl}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }

    // Default registry (packages.fhir.org) also supports the standard npm-style tarball URL format.
    return `${this.registryUrl}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    const tarballStream = await this.fetchStream(url);
    const fileStream = fs.createWriteStream(destination);
    await finished(tarballStream.pipe(fileStream));
  }

  private async downloadTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const tempDirectory = createTempDir();
    const tarballPath = path.join(tempDirectory, `${packageObject.id}-${packageObject.version}.tgz`);

    const cached = await this.getOrDownloadDiskCachedTarball(packageObject);
    await fs.copy(cached, tarballPath, { overwrite: true });
    return tarballPath;
  }

  private async getOrDownloadDiskCachedTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const key = this.getDiskTarballCacheKey(packageObject);
    const memKey = `tarball|${this.cachePath}|${key}`;

    const memHit = memGet<string>(memKey);
    if (memHit && await fs.exists(memHit)) return memHit;

    return await withSingleFlight(inFlightTarball, memKey, async () => {
      const memHit2 = memGet<string>(memKey);
      if (memHit2 && await fs.exists(memHit2)) return memHit2;

      return await this.withDiskLock(this.getDiskTarballCacheKey(packageObject), async () => {
        const diskHit = await this.readDiskTarballCache(packageObject);
        if (diskHit) {
          memSetNoTtl(memKey, diskHit);
          return diskHit;
        }

        const { tgzPath, donePath } = await this.getDiskTarballCachePaths(packageObject);
        const tarballUrl = await this.getTarballUrl(packageObject);
        this.logger.debug?.(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);

        const tmp = `${tgzPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          await this.downloadFile(tarballUrl, tmp);
        } catch (e: any) {
          await fs.remove(tmp).catch(() => undefined);
          if (e instanceof FhirPackageInstallError) throw e;
          throw new FhirPackageInstallError({
            packageId: packageObject.id,
            version: packageObject.version ?? 'unknown',
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            step: 'download-tarball',
            tarballUrl,
            cause: e,
          });
        }

        try {
          await fs.move(tmp, tgzPath, { overwrite: false });
        } catch (e: any) {
          // Another process may have won the race. Prefer the existing file.
          if (e?.code !== 'EEXIST') {
            await fs.remove(tmp).catch(() => undefined);
            throw e;
          }
          await fs.remove(tmp).catch(() => undefined);
        }

        // Mark completion so crashes don't leave a half-written cache entry.
        await this.writeDiskTarballDoneMarker(donePath);

        memSetNoTtl(memKey, tgzPath);
        return tgzPath;
      });
    });
  }

  /**
   * Extracts a tarball to a temporary directory and generates a new `.fpi.index.json` file.
   * The tarball can be a file path or a stream.
   * @param src The source tarball, either a file path or a Readable stream.
   * @returns The path to the temporary directory where the package was extracted.
   */
  private async extractTarball(
    src: string | Readable,
    options?: { packageObject?: FhirPackageIdentifier; packageLabel?: string }
  ): Promise<string> {
    const tarballStream: Readable = typeof src === 'string' ? fs.createReadStream(src) : src;

    const pkgObj = options?.packageObject;
    const packageLabel = pkgObj
      ? this.formatPackageForDebug(pkgObj)
      : options?.packageLabel?.trim() || 'unknown package';
    const extractionStartedAtNs = process.hrtime.bigint();
    let cachedIndex: PackageIndex | null = null;
    if (pkgObj?.id && pkgObj?.version) {
      try {
        const memKey = this.getIndexMemKey(pkgObj);
        cachedIndex = memGet<PackageIndex>(memKey);
        if (!cachedIndex) {
          const diskPath = this.getDiskIndexCachePath(pkgObj);
          await this.ensureDiskCacheSubdir('indexes');
          cachedIndex = await this.readDiskCacheJson<PackageIndex>(diskPath);
          if (cachedIndex) {
            memSetNoTtl(memKey, cachedIndex);
          }
        }
      } catch {
        cachedIndex = null;
      }
    }
    const shouldParseForIndex = !cachedIndex;

    const indexEntries: FileInPackageIndex[] = [];
    const handleEntryPromises: Promise<void>[] = [];

    const tempDirectory = await this.createWorkingTempDir({ preferCache: Boolean(pkgObj) });
    this.logger.debug?.(`Extracting package ${packageLabel} to ${tempDirectory}`);
    const extract = tar.extract();

    // Inactivity timeout: reset whenever we see extraction progress (data or entry completion).
    // This avoids timing out on very large packages (e.g., *examples*) that can legitimately take a long time.
    let timeoutHandle: NodeJS.Timeout | undefined;
    let rejectTimeout: ((err: any) => void) | undefined;
    const armInactivityTimeout = () => {
      if (!Number.isFinite(this.extractTimeoutMs) || this.extractTimeoutMs <= 0) {
        return;
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      timeoutHandle = setTimeout(() => {
        try {
          try {
            tarballStream.destroy(new Error('Tarball extraction timeout'));
          } catch {
            // ignore
          }
          try {
            extract.destroy(new Error('Tarball extraction timeout'));
          } catch {
            // ignore
          }
        } finally {
          const err: any = new Error(`Tarball extraction made no progress for ${this.extractTimeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          rejectTimeout?.(err);
        }
      }, this.extractTimeoutMs);
    };
    const touchProgress = () => armInactivityTimeout();

    // Start the inactivity timer immediately and keep it alive while bytes flow.
    armInactivityTimeout();
    tarballStream.on('data', touchProgress);
    tarballStream.on('error', touchProgress);

    // Progress logs for very large packages (e.g., *examples*)
    let completedEntries = 0;
    const progressLogIntervalMs = 30000;
    const progressLogHandle = setInterval(() => {
      this.logger.debug?.(`Extracting package ${packageLabel}... completed ${completedEntries} entries so far`);
    }, progressLogIntervalMs);
    // Don't keep the process alive only for progress logging
    (progressLogHandle as any).unref?.();
  
    extract.on('entry', (header, stream, next) => {
      const fullPath = path.join(tempDirectory, header.name);
      const folderInTarball = path.dirname(header.name);
      const fileName = path.basename(header.name);

      touchProgress();
  
      try {
        if (header.type === 'directory') {
          fs.ensureDirSync(fullPath);
          touchProgress();
          stream.resume();
          stream.on('end', () => {
            completedEntries++;
            touchProgress();
            next();
          });
          stream.on('error', (err) => {
            extract.emit('error', err);
            next();
          });
          return;
        }

        if (header.type !== 'file') {
          // Drain unknown entry types to avoid stalling extraction
          touchProgress();
          stream.resume();
          stream.on('end', () => {
            completedEntries++;
            touchProgress();
            next();
          });
          stream.on('error', (err) => {
            extract.emit('error', err);
            next();
          });
          return;
        }

        // Always ensure directory exists
        fs.ensureDirSync(path.dirname(fullPath));

        // IMPORTANT: tar-stream requires us to fully consume the entry stream
        // before calling next(), otherwise extraction can hang.
        stream.on('data', touchProgress);
        const writePromise = pipeline(stream, fs.createWriteStream(fullPath));

        writePromise
          .then(() => {
            // Only rate-limit/parallelize the *parsing*, not the draining.
            if (
              shouldParseForIndex &&
              folderInTarball === 'package' &&
              fileName.endsWith('.json') &&
              fileName !== 'package.json' &&
              !fileName.endsWith('.index.json')
            ) {
              handleEntryPromises.push(
                limit(async () => {
                  const contentBuffer = await fs.readFile(fullPath, 'utf8');
                  try {
                    const content = JSON.parse(contentBuffer) as PackageResource;
                    const indexEntry = extractResourceIndexEntry(fileName, content);
                    indexEntries.push(indexEntry);
                  } catch (err) {
                    let errText = String(err);
                    if (!(err instanceof Error) && typeof err !== 'string') {
                      try {
                        errText = JSON.stringify(err);
                      } catch {
                        // fallback to String(err)
                      }
                    }
                    this.logger.warn(`Failed to parse ${fileName}: ${err instanceof Error ? err.message : errText}`);
                  }
                  touchProgress();
                })
              );
            }
          })
          .catch((err) => {
            extract.emit('error', err);
          })
          .finally(() => {
            completedEntries++;
            touchProgress();
            next();
          });
      } catch (err) {
        // Ensure we don't stall extraction if something throws synchronously
        try {
          stream.resume();
        } catch {
          // ignore
        }
        extract.emit('error', err);
        next();
      }
    });

    const extractionPromise = (async () => {
      const archiveExtractionStartedAtNs = process.hrtime.bigint();
      await pipeline(
        tarballStream,
        zlib.createGunzip(),
        extract
      );
      this.logger.debug?.(
        `[extract] Finished unpacking archive for ${packageLabel} into ${tempDirectory} ` +
        `in ${this.formatElapsedMs(archiveExtractionStartedAtNs)}ms (entries=${completedEntries}).`
      );

      const indexBuildStartedAtNs = process.hrtime.bigint();
      await Promise.all(handleEntryPromises);
      if (shouldParseForIndex) {
        this.logger.debug?.(
          `[extract] Built in-memory index candidates for ${packageLabel} ` +
          `in ${this.formatElapsedMs(indexBuildStartedAtNs)}ms (fileCount=${indexEntries.length}).`
        );
      } else {
        this.logger.debug?.(
          `[extract] Reused cached index for ${packageLabel} ` +
          `in ${this.formatElapsedMs(indexBuildStartedAtNs)}ms (fileCount=${cachedIndex?.files.length ?? 0}).`
        );
      }
    })();

    const inactivityTimeoutPromise = new Promise<void>((_, reject) => {
      rejectTimeout = reject;
    });

    try {
      await Promise.race([extractionPromise, inactivityTimeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      tarballStream.off('data', touchProgress);
      tarballStream.off('error', touchProgress);
      clearInterval(progressLogHandle);
    }
  
    const indexJson: PackageIndex = {
      'index-version': 2,
      files: shouldParseForIndex ? indexEntries : (cachedIndex?.files || [])
    };
    const extractedIndexWriteStartedAtNs = process.hrtime.bigint();
    await fs.writeJSON(path.join(tempDirectory, 'package', '.fpi.index.json'), indexJson);
    this.logger.debug?.(
      `[extract] Wrote extracted package index for ${packageLabel} ` +
      `in ${this.formatElapsedMs(extractedIndexWriteStartedAtNs)}ms (fileCount=${indexJson.files.length}).`
    );

    // If we computed an index for a known package version, persist to memory + per-cachePath disk (best-effort)
    if (shouldParseForIndex && pkgObj?.id && pkgObj?.version) {
      const extractedIndexCachePersistStartedAtNs = process.hrtime.bigint();
      try {
        const memKey = this.getIndexMemKey(pkgObj);
        memSetNoTtl(memKey, indexJson);
        const diskPath = this.getDiskIndexCachePath(pkgObj);
        await this.ensureDiskCacheSubdir('indexes');
        await this.writeDiskCacheJsonNoTtl(diskPath, indexJson);
        this.logger.debug?.(
          `[extract] Persisted extracted index cache for ${packageLabel} ` +
          `in ${this.formatElapsedMs(extractedIndexCachePersistStartedAtNs)}ms.`
        );
      } catch {
        // ignore
      }
    }
  
    this.logger.debug?.(
      `Extracted ${packageLabel} to temporary directory ${tempDirectory} ` +
      `in ${this.formatElapsedMs(extractionStartedAtNs)}ms.`
    );
    return tempDirectory;
  }

  private async downloadAndExtractTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    return await this.withDebugTiming(
      `download-and-extract-tarball ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const cachedTgzPath = await this.getOrDownloadDiskCachedTarball(packageObject);
        try {
          return await this.extractTarball(cachedTgzPath, { packageObject });
        } catch (e: any) {
          if (e instanceof FhirPackageInstallError) throw e;
          let tarballUrl: string | undefined;
          try {
            tarballUrl = await this.getTarballUrl(packageObject);
          } catch {
            tarballUrl = undefined;
          }
          throw new FhirPackageInstallError({
            packageId: packageObject.id,
            version: packageObject.version ?? 'unknown',
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            step: 'extract-tarball',
            tarballUrl,
            cause: e,
          });
        }
      }
    );
  }

  /**
   * Caches the package in the FHIR package cache directory.
   * If the package is already installed, it will not be reinstalled.
   * @param packageObject The package identifier object
   * @param src The source path of the package to be cached
   * @param move Whether to move the package to the cache or copy it. Defaults to **true**.
   * @returns The path to the cached package directory
   */
  private async cachePackage(packageObject: FhirPackageIdentifier, src: string, move: boolean = true): Promise<string> {
    return await this.withDebugTiming(
      `cache-package ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const finalPath = await this.getPackageDirPath(packageObject);
        const isInstalled = await this.isStrictlyMaterialized(packageObject);
        if (isInstalled) {
          return finalPath;
        }

        let stagingPath: string | null = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            stagingPath = await this.stagePackageForPublish(packageObject, src, move);
            break;
          } catch (e: any) {
            if (await this.isStrictlyMaterialized(packageObject)) {
              return finalPath;
            }

            const canRetry = this.isRetryableStagePublishError(e) && attempt < 2;
            if (!canRetry) {
              throw e;
            }

            this.logger.warn?.(
              `Retrying publish staging for ${packageObject.id}@${packageObject.version} after ${e?.code || e?.message || String(e)}.`
            );
          }
        }

        if (!stagingPath) {
          return finalPath;
        }

        try {
          const existingState = await this.getPackageMaterializationStatus(packageObject);
          if (!existingState.complete && await fs.exists(finalPath)) {
            await fs.remove(finalPath);
          }

          try {
            await fs.move(stagingPath, finalPath, { overwrite: false });
          } catch (e: any) {
            if (this.isAlreadyExistsError(e)) {
              const stateAfterCollision = await this.getPackageMaterializationStatus(packageObject);
              if (stateAfterCollision.complete) {
                this.logger.warn(`Package ${packageObject.id}@${packageObject.version} already installed by another process`);
                return finalPath;
              }

              await fs.remove(finalPath).catch(() => undefined);
              await fs.move(stagingPath, finalPath, { overwrite: false });
            } else {
              throw e;
            }
          }

          this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
          return finalPath;
        } catch (e: any) {
          if (e instanceof FhirPackageInstallError) throw e;
          throw new FhirPackageInstallError({
            packageId: packageObject.id,
            version: packageObject.version ?? 'unknown',
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            step: 'cache-package',
            cause: e,
          });
        } finally {
          await fs.remove(stagingPath).catch(() => undefined);
        }
      }
    );
  }

  /**
   * Extracts the version of the package from a raw package identifier string.
   * Supported formats: `name@version`, `name#version`, or just `name`
   * @param packageId Raw package identifier string
   * @returns The version part or 'latest' if not supplied
   */
  private getVersionFromPackageString(packageId: string): string {
    const byPound = packageId.split('#');
    const byAt = packageId.split('@');
    if (byPound.length === 2) return byPound[1];
    if (byAt.length === 2) return byAt[1];
    return 'latest';
  }

  public async isInstalled(
    packageId: FhirPackageIdentifier | string,
    options?: { deep?: boolean }
  ): Promise<boolean> {
    const deep = options?.deep !== false;

    // Avoid resolving "latest" via registry for unversioned string checks.
    if (typeof packageId === 'string') {
      const packageIdStr = packageId.trim();
      if (packageIdStr.length === 0) {
        return false;
      }
      const hasExplicitVersion = packageIdStr.includes('#') || packageIdStr.includes('@');
      if (!hasExplicitVersion) {
        const installedVersions = await this.getInstalledVersions(packageIdStr);
        if (installedVersions.length === 0) return false;
        const latestInstalled = installedVersions[0];
        return await this.isInstalled({ id: packageIdStr, version: latestInstalled }, { deep });
      }
    }

    const packageObject = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    const shallowInstalled = await this.hasShallowInstalledPackage(packageObject);
    if (!shallowInstalled) {
      return false;
    }
    if (!deep) {
      return true;
    }

    try {
      const missing = await this.collectMissingPackages(packageObject);
      return missing.length === 0;
    } catch (err: any) {
      // Deep validation errors should not be silently swallowed.
      // If we can't reliably validate dependencies due to infra / IO / parsing errors,
      // surface the failure to the caller.
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Treat common filesystem race conditions as "not installed".
        return false;
      }
      throw err;
    }
  }

  public async getPackageIndexFile(packageId: FhirPackageIdentifier | string): Promise<PackageIndex> {
    const packageObject = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    return await this.withDebugTiming(
      `get-package-index-file ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const indexPath = await this.getPackageIndexPath(packageObject);
        if (await fs.exists(indexPath)) {
          return await fs.readJSON(indexPath, { encoding: 'utf8' });
        }
        return await this.generatePackageIndex(packageObject);
      },
      (indexJson) => `fileCount=${indexJson.files.length}`
    );
  }

  public async checkLatestPackageDist(packageName: string): Promise<string> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(
        `Cannot resolve latest version for ${packageName}. Pin an explicit version in configuration.`
      ));
    }

    // Latest is derived from the cached unversioned registry metadata (package document).
    // This keeps caching policy consistent and avoids maintaining a second, redundant cache.
    try {
      const packageData = await this.getPackageDataFromRegistry(packageName);
      const latest = packageData['dist-tags']?.latest;
      if (!latest) {
        throw new Error(`Package ${packageName} not found or has no latest version tag`);
      }
      return latest;
    } catch (onlineError: any) {
      this.logger.warn(
        `Failed to fetch latest version for ${packageName} from registry: ${onlineError?.message || onlineError}`
      );

      const installedVersions = await this.getInstalledVersions(packageName);
      if (installedVersions.length === 0) {
        throw new Error(
          `Failed to resolve latest version for ${packageName} from registry (${onlineError?.message || onlineError}). ` +
          `No installed versions found in cache (${this.cachePath}).`
        );
      }

      const latestInstalled = installedVersions[0];
      this.logger.warn(`Using latest installed version for ${packageName}: ${latestInstalled}`);
      return latestInstalled;
    }
  }

  public async toPackageObject(packageId: string | FhirPackageIdentifier): Promise<FhirPackageIdentifier> {
    let packageVersion: string;
    let packageName: string;
    if (typeof packageId === 'string') {
      const packageIdStr = packageId.trim();
      if (packageIdStr.length === 0) {
        throw new Error('Invalid package identifier: empty string');
      }
      packageName = packageIdStr.split('#')[0].split('@')[0];
      packageVersion = this.getVersionFromPackageString(packageIdStr);
    } else {
      packageName = packageId.id;
      packageVersion = packageId.version || 'latest';
    }
    if (packageVersion === 'latest') {
      if (this.isRegistryDisabled()) {
        throw new Error(this.formatRegistryDisabledMessage(
          `Cannot use the "latest" version feature for ${packageName}. Pin an explicit version (e.g., ${packageName}@x.y.z).`
        ));
      }
      packageVersion = await this.checkLatestPackageDist(packageName);
    }
    return { id: packageName, version: packageVersion };
  }

  private getImplicitEffectiveCacheKey(packageId: string): string {
    return `implicit-effective|${this.registryUrl}|${this.cachePath}|${packageId}`;
  }

  private getImplicitPlanningCacheKeys(packageId: string): string[] {
    return [
      this.getImplicitEffectiveCacheKey(packageId),
      this.getImplicitEffectiveCacheKey(`${packageId}|planning`),
    ];
  }

  private async readManifestFile(packageFolder: string): Promise<PackageManifest> {
    const manifestPath = path.join(packageFolder, 'package.json');
    return await fs.readJSON(manifestPath, { encoding: 'utf8' });
  }

  private async waitForManifestDuringActiveInstall(
    packageObject: FhirPackageIdentifier,
    packageFolder: string
  ): Promise<PackageManifest | null> {
    const deadline = Date.now() + Math.max(this.requestTimeoutMs, 250);

    while (Date.now() < deadline) {
      try {
        return await this.readManifestFile(packageFolder);
      } catch (err: any) {
        const code = err?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw err;
        }
      }

      if (!await this.isPackageInstallLockHeld(packageObject)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      return await this.readManifestFile(packageFolder);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      throw err;
    }
  }

  public async getManifest(packageId: string | FhirPackageIdentifier): Promise<PackageManifest> {
    const packageObj = typeof packageId === 'string' 
      ? await this.toPackageObject(packageId)
      : packageId;

    const packageDir = await this.getPackageDirPath(packageObj);
    const packageFolder = path.join(packageDir, 'package');
    try {
      return await this.readManifestFile(packageFolder);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (await this.isPackageInstallLockHeld(packageObj)) {
          const manifest = await this.waitForManifestDuringActiveInstall(packageObj, packageFolder);
          if (manifest) {
            return manifest;
          }
        }

        if (IMPLICIT_PACKAGE_IDS.has(packageObj.id)) {
          for (const cacheKey of this.getImplicitPlanningCacheKeys(packageObj.id)) {
            const implicitFailure = implicitResolutionFailureCache.get(cacheKey);
            if (implicitFailure) throw implicitFailure;
          }
        }

        const expected = path.join(packageFolder, 'package.json');
        throw new Error(
          `Could not find package manifest for ${packageObj.id}@${packageObj.version} in cachePath=${this.cachePath} ` +
          `(expected ${expected}).`
        );
      }
      throw err;
    }
  }

  /**
   * Get the path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * @returns {string} The path to the FHIR package cache directory
   */
  public getCachePath(): string {
    return this.cachePath;
  }

  /**
   * Get the logger instance used by this FhirPackageInstaller.
  */

  public getLogger(): Logger {
    return this.logger;
  }

  /**
   * Scan cache directory for installed versions of a package
   * @param packageName Package name to search for
   * @returns Array of installed versions sorted in descending order (latest first)
   */
  private async getInstalledVersions(packageName: string): Promise<string[]> {
    try {
      const cacheDirs = await fs.readdir(this.cachePath);
      const versions: string[] = [];
      
      for (const dirName of cacheDirs) {
        if (dirName.startsWith(`${packageName}#`)) {
          const version = dirName.substring(packageName.length + 1);
          versions.push(version);
        }
      }
      
      // Sort versions in descending order (latest first) using semver
      return versions.sort((a, b) => semver.rcompare(a, b));
    } catch (e) {
      this.logger.warn(`Failed to scan cache for package ${packageName}: ${e}`);
      return [];
    }
  }

  /**
   * Resolve an implicit package dependency to an effective version that is installed and manifest-valid.
   *
   * This is the materializing resolver used by code paths that need a real readable package entry,
   * not just a plannable version candidate.
   */
  protected async resolveImplicitPackageVersionWithFallbacks(packageName: string): Promise<string> {
    const cacheKey = this.getImplicitEffectiveCacheKey(packageName);
    const cachedFailure = implicitResolutionFailureCache.get(cacheKey);
    if (cachedFailure) throw cachedFailure;

    const cached = implicitEffectiveVersionCache.get(cacheKey);
    if (cached) {
      const ok = await this.hasReadableManifest({ id: packageName, version: cached });
      if (ok) return cached;
      implicitEffectiveVersionCache.delete(cacheKey);
    }

    return await withSingleFlight(inFlightImplicitEffectiveVersion, cacheKey, async () => {
      const cachedFailure2 = implicitResolutionFailureCache.get(cacheKey);
      if (cachedFailure2) throw cachedFailure2;

      const cached2 = implicitEffectiveVersionCache.get(cacheKey);
      if (cached2) {
        const ok = await this.hasReadableManifest({ id: packageName, version: cached2 });
        if (ok) return cached2;
        implicitEffectiveVersionCache.delete(cacheKey);
      }

      try {
        const resolveFromInstalled = async (
          detail: string,
          previousAttempts?: { attemptedVersions: string[]; causes: string[] }
        ): Promise<string> => {
          this.logger.warn?.(detail);
          const installedVersions = await this.getInstalledVersions(packageName);
          const attempted = [...(previousAttempts?.attemptedVersions ?? [])];
          const causes = [...(previousAttempts?.causes ?? [])];
          for (const version of installedVersions) {
            if (!attempted.includes(version)) {
              attempted.push(version);
            }
            try {
              const ok = await this.hasReadableManifest({ id: packageName, version });
              if (ok) {
                implicitResolutionFailureCache.delete(cacheKey);
                implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
                return version;
              }
            } catch (error: any) {
              causes.push(`${version}: ${error?.message || String(error)}`);
            }
          }

          if (installedVersions.length === 0) {
            causes.push('No installed versions available for fallback.');
          }

          throw new ImplicitPackageResolutionError({
            packageId: packageName,
            attemptedVersions: attempted,
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            causes,
          });
        };

        if (this.isRegistryDisabled()) {
          return await resolveFromInstalled(
            `Registry disabled; using latest installed version for implicit package ${packageName} (if available)`
          );
        }

        let candidates: string[] = [];
        try {
          const packageData = await this.getPackageDataFromRegistry(packageName);
          const latest = packageData['dist-tags']?.latest as string | undefined;
          const versionsObj = (packageData.versions || {}) as Record<string, any>;
          const allVersions = Object.keys(versionsObj)
            .filter((version) => typeof version === 'string' && semver.valid(version))
            .sort((a, b) => semver.rcompare(a, b));

          const unique: string[] = [];
          const pushUnique = (version: string | undefined) => {
            if (!version || typeof version !== 'string') return;
            if (!unique.includes(version)) unique.push(version);
          };

          pushUnique(latest);
          for (const version of allVersions) {
            pushUnique(version);
            if (unique.length >= 3) break;
          }
          candidates = unique;
        } catch (error: any) {
          return await resolveFromInstalled(
            `Failed to fetch registry metadata for implicit package ${packageName}: ${error?.message || String(error)}. ` +
            'Falling back to latest installed version (if available).'
          );
        }

        const attemptedVersions: string[] = [];
        const causes: string[] = [];

        for (const version of candidates) {
          attemptedVersions.push(version);
          const packageObject = { id: packageName, version };

          try {
            const alreadyOk = await this.hasReadableManifest(packageObject);
            if (alreadyOk) {
              implicitResolutionFailureCache.delete(cacheKey);
              implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
              return version;
            }

            await this.install(packageObject);
            const okAfterInstall = await this.isStrictlyMaterialized(packageObject);
            if (okAfterInstall) {
              implicitResolutionFailureCache.delete(cacheKey);
              implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
              return version;
            }
            causes.push(`${version}: install completed but manifest missing`);
          } catch (error: any) {
            try {
              const materializedAfterFailure = await this.isStrictlyMaterialized(packageObject);
              if (materializedAfterFailure) {
                implicitResolutionFailureCache.delete(cacheKey);
                implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
                return version;
              }
            } catch {
              // Fall through and record the original failure.
            }
            causes.push(`${version}: ${error?.message || String(error)}`);
          }
        }

        return await resolveFromInstalled(
          `Failed to materialize implicit package ${packageName} from registry candidates. ` +
          'Falling back to latest installed version (if available).',
          { attemptedVersions, causes }
        );
      } catch (error: any) {
        if (error instanceof ImplicitPackageResolutionError) {
          implicitResolutionFailureCache.set(cacheKey, error, this.registryTtlMs);
        }
        throw error;
      }
    });
  }

  private async resolveImplicitPackageVersionForPlanning(packageName: string): Promise<string> {
    const cacheKey = this.getImplicitEffectiveCacheKey(`${packageName}|planning`);
    const cachedFailure = implicitResolutionFailureCache.get(cacheKey);
    if (cachedFailure) throw cachedFailure;

    const hasUsablePlanningVersion = async (version: string): Promise<boolean> => {
      const packageObject = { id: packageName, version };
      if (await this.hasReadableManifest(packageObject)) {
        return true;
      }
      if (this.isRegistryDisabled()) {
        return false;
      }
      try {
        await this.getOrDownloadDiskCachedTarball(packageObject);
        return true;
      } catch {
        return false;
      }
    };

    const cached = implicitEffectiveVersionCache.get(cacheKey);
    if (cached) {
      if (await hasUsablePlanningVersion(cached)) {
        return cached;
      }
      implicitEffectiveVersionCache.delete(cacheKey);
    }

    return await withSingleFlight(inFlightImplicitEffectiveVersion, cacheKey, async () => {
      const cachedFailure2 = implicitResolutionFailureCache.get(cacheKey);
      if (cachedFailure2) throw cachedFailure2;

      const cached2 = implicitEffectiveVersionCache.get(cacheKey);
      if (cached2) {
        if (await hasUsablePlanningVersion(cached2)) {
          return cached2;
        }
        implicitEffectiveVersionCache.delete(cacheKey);
      }

      const resolveFromInstalled = async (
        detail: string,
        previousAttempts?: { attemptedVersions: string[]; causes: string[] }
      ): Promise<string> => {
        this.logger.warn?.(detail);
        const installedVersions = await this.getInstalledVersions(packageName);
        const attempted = [...(previousAttempts?.attemptedVersions ?? [])];
        const causes = [...(previousAttempts?.causes ?? [])];

        for (const version of installedVersions) {
          if (!attempted.includes(version)) {
            attempted.push(version);
          }

          try {
            if (await this.hasReadableManifest({ id: packageName, version })) {
              implicitResolutionFailureCache.delete(cacheKey);
              implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
              return version;
            }
            causes.push(`${version}: installed manifest missing`);
          } catch (error: any) {
            causes.push(`${version}: ${error?.message || String(error)}`);
          }
        }

        const failure = new ImplicitPackageResolutionError({
          packageId: packageName,
          attemptedVersions: attempted,
          registryUrl: this.registryUrl,
          cachePath: this.cachePath,
          causes: causes.length > 0
            ? causes
            : ['No installed versions available for planning fallback.']
        });
        implicitResolutionFailureCache.set(cacheKey, failure, this.registryTtlMs);
        throw failure;
      };

      if (this.isRegistryDisabled()) {
        return await resolveFromInstalled(
          `Registry disabled; using latest installed version for implicit package ${packageName} during dependency planning (if available)`
        );
      }

      let candidates: string[] = [];
      try {
        const packageData = await this.getPackageDataFromRegistry(packageName);
        const latest = packageData['dist-tags']?.latest as string | undefined;
        const versionsObj = (packageData.versions || {}) as Record<string, any>;
        const allVersions = Object.keys(versionsObj)
          .filter((v) => typeof v === 'string' && semver.valid(v))
          .sort((a, b) => semver.rcompare(a, b));

        const unique: string[] = [];
        const pushUnique = (v: string | undefined) => {
          if (!v || typeof v !== 'string') return;
          if (!unique.includes(v)) unique.push(v);
        };

        pushUnique(latest);
        for (const v of allVersions) {
          pushUnique(v);
          if (unique.length >= 3) break;
        }
        candidates = unique;
      } catch (e: any) {
        return await resolveFromInstalled(
          `Failed to fetch registry metadata for implicit package ${packageName} during dependency planning: ${e?.message || String(e)}. ` +
          'Falling back to latest installed version (if available).'
        );
      }

      const attemptedVersions: string[] = [];
      const causes: string[] = [];

      for (const version of candidates) {
        attemptedVersions.push(version);
        const pkgObj = { id: packageName, version };

        try {
          const alreadyOk = await this.hasReadableManifest(pkgObj);
          if (alreadyOk) {
            implicitResolutionFailureCache.delete(cacheKey);
            implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
            return version;
          }

          await this.getOrDownloadDiskCachedTarball(pkgObj);
          implicitResolutionFailureCache.delete(cacheKey);
          implicitEffectiveVersionCache.set(cacheKey, version, this.registryTtlMs);
          return version;
        } catch (e: any) {
          causes.push(`${version}: ${e?.message || String(e)}`);
        }
      }

      return await resolveFromInstalled(
        `Failed to resolve planning candidates for implicit package ${packageName}. ` +
        'Falling back to latest installed version (if available).',
        { attemptedVersions, causes }
      );
    });
  }

  /**
   * Get implicit dependencies for a given package
   * @param packageObject The package to check for implicit dependencies
   * @returns Promise resolving to record of implicit dependencies
   */
  private async getImplicitDependencies(
    packageObject: FhirPackageIdentifier,
    explicitImplicitVersions?: ReadonlyMap<string, string>
  ): Promise<Record<string, string>> {
    const implicitDeps: Record<string, string> = {};
    
    // Prevent recursion - if we're already resolving implicit deps for this package, return empty
    const packageKey = `${packageObject.id}@${packageObject.version}`;
    if (this.resolvingImplicitDeps.has(packageKey)) {
      return implicitDeps;
    }
    
    // Check if this package triggers implicit dependencies
    const implicitPackageIds = IMPLICIT_DEPENDENCIES_MAP[packageObject.id];
    if (!implicitPackageIds || implicitPackageIds.length === 0) {
      return implicitDeps;
    }
    
    // Mark this package as being resolved to prevent recursion
    this.resolvingImplicitDeps.add(packageKey);
    
    try {
      // Resolve versions for each implicit dependency without side-effectful installs.
      // When the surrounding graph already selected explicit versions for implicit packages,
      // those pins win over the implicit latest-version fallback.
      for (const implicitPackageId of implicitPackageIds) {
        const explicitVersion = explicitImplicitVersions?.get(implicitPackageId);
        implicitDeps[implicitPackageId] = explicitVersion
          ?? await this.resolveImplicitPackageVersionForPlanning(implicitPackageId);
      }
    } finally {
      // Always remove from tracking set
      this.resolvingImplicitDeps.delete(packageKey);
    }
    
    return implicitDeps;
  }

  /**
   * Get explicit dependencies from package.json only (internal use)
   * @param packageObject The package to get explicit dependencies for
   * @returns Promise resolving to record of explicit dependencies only
   */
  private async getExplicitDependencies(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    const deps = (await this.getManifest(packageObject))?.dependencies || {};
    return this.normalizeDependencies(deps);
  }

  private async getExplicitDependenciesFromTarballManifest(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    if (this.isRegistryDisabled()) {
      return {};
    }

    try {
      const tgzPath = await this.getOrDownloadDiskCachedTarball(packageObject);
      const extract = tar.extract();
      let manifest: PackageManifest | null = null;

      extract.on('entry', (header, stream, next) => {
        const entryName = header.name.replace(/\\/g, '/');
        const isManifest = entryName === 'package/package.json' || entryName === 'package.json';
        if (!isManifest || manifest) {
          stream.on('end', next);
          stream.resume();
          return;
        }

        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        stream.on('end', () => {
          try {
            manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PackageManifest;
            next();
          } catch (error) {
            extract.destroy(error as Error);
          }
        });
        stream.resume();
      });

      await pipeline(fs.createReadStream(tgzPath), zlib.createGunzip(), extract);

      const deps = (manifest as PackageManifest | null)?.dependencies;
      if (!deps || typeof deps !== 'object') {
        return {};
      }

      return this.normalizeDependencies(deps as Record<string, string>);
    } catch (error) {
      this.logger.debug?.(
        `Failed to plan explicit dependencies for ${this.formatPackageForDebug(packageObject)} from tarball manifest: ${error instanceof Error ? error.message : String(error)}`
      );
      return {};
    }
  }

  private async getExplicitDependenciesFromRegistryMetadata(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    if (this.isRegistryDisabled()) {
      return {};
    }

    const version = packageObject.version;
    if (!version) {
      return {};
    }

    try {
      const packageData = await this.getPackageDataFromRegistry(packageObject.id);
      const versionData = packageData?.versions?.[version];
      const rawDeps = versionData?.dependencies;
      if (!rawDeps || typeof rawDeps !== 'object') {
        return {};
      }

      const deps = Object.fromEntries(
        Object.entries(rawDeps).filter(([, version]) => typeof version === 'string')
      ) as Record<string, string>;
      return this.normalizeDependencies(deps);
    } catch (error) {
      this.logger.debug?.(
        `Failed to plan explicit dependencies for ${this.formatPackageForDebug(packageObject)} from registry metadata: ${error instanceof Error ? error.message : String(error)}`
      );
      return {};
    }
  }

  private async getExplicitDependenciesForPlanning(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    const hasManifest = await this.hasReadableManifest(packageObject).catch(() => false);
    if (hasManifest) {
      return await this.getExplicitDependencies(packageObject);
    }

    const registryDeps = await this.getExplicitDependenciesFromRegistryMetadata(packageObject);
    if (Object.keys(registryDeps).length > 0) {
      return registryDeps;
    }

    return await this.getExplicitDependenciesFromTarballManifest(packageObject);
  }

  private async getDependenciesForPlanning(
    packageObject: FhirPackageIdentifier,
    explicitImplicitVersions?: ReadonlyMap<string, string>
  ): Promise<Record<string, string>> {
    return await this.getDependencies(packageObject, {
      explicitImplicitVersions,
      includePlanningFallbacks: true,
    });
  }

  private async collectExplicitDependencyClosure(root: FhirPackageIdentifier): Promise<{
    closure: Map<string, FhirPackageIdentifier>;
    explicitImplicitVersions: Map<string, string>;
  }> {
    const closure = new Map<string, FhirPackageIdentifier>();
    const explicitImplicitVersions = new Map<string, string>();
    const expanded = new Set<string>();
    const queue: FhirPackageIdentifier[] = [root];

    if (IMPLICIT_PACKAGE_IDS.has(root.id) && root.version) {
      explicitImplicitVersions.set(root.id, root.version);
    }

    while (queue.length > 0) {
      const current = queue.shift() as FhirPackageIdentifier;
      const currentKey = this.getPackageKey(current);
      if (expanded.has(currentKey)) {
        continue;
      }
      expanded.add(currentKey);

      const explicitDeps = await this.getExplicitDependenciesForPlanning(current);

      for (const [depId, rawDepVersion] of Object.entries(explicitDeps)) {
        if (this.skipExamples && depId.includes('examples')) {
          continue;
        }

        let depVersion = rawDepVersion;
        if (IMPLICIT_PACKAGE_IDS.has(depId)) {
          const selectedVersion = explicitImplicitVersions.get(depId);
          if (selectedVersion) {
            depVersion = selectedVersion;
          } else {
            explicitImplicitVersions.set(depId, depVersion);
          }
        }

        const dependency = { id: depId, version: depVersion };
        const dependencyKey = this.getPackageKey(dependency);
        if (!closure.has(dependencyKey)) {
          closure.set(dependencyKey, dependency);
        }
        if (!expanded.has(dependencyKey)) {
          queue.push(dependency);
        }
      }
    }

    return { closure, explicitImplicitVersions };
  }

  /**
   * Get all dependencies for a package, including both explicit dependencies from package.json 
   * and automatic implicit dependencies for core FHIR packages.
   * 
   * For core FHIR packages (hl7.fhir.r3.core, hl7.fhir.r4.core, hl7.fhir.r5.core), 
   * this automatically includes essential terminology and extension packages.
   * 
   * @param packageObject The package to get dependencies for
   * @param options Optional root/context information for graph-aware implicit package version selection
   * @returns Promise resolving to record of all dependencies (explicit + implicit)
   */
  public async getDependencies(
    packageObject: FhirPackageIdentifier,
    options?: GetDependenciesOptions
  ): Promise<Record<string, string>> {
    const includePlanningFallbacks = options?.includePlanningFallbacks
      ?? Boolean(options?.rootPackage);

    let explicitImplicitVersions = options?.explicitImplicitVersions;
    if (!explicitImplicitVersions && options?.rootPackage) {
      const rootPackage = typeof options.rootPackage === 'string'
        ? await this.toPackageObject(options.rootPackage)
        : options.rootPackage;
      const context = await this.collectExplicitDependencyClosure(rootPackage);
      explicitImplicitVersions = context.explicitImplicitVersions;
    }

    const explicitDeps = includePlanningFallbacks
      ? await this.getExplicitDependenciesForPlanning(packageObject)
      : await this.getExplicitDependencies(packageObject);

    const normalizedExplicitDeps = Object.fromEntries(
      Object.entries(explicitDeps).map(([depId, depVersion]) => {
        const selectedVersion = explicitImplicitVersions?.get(depId);
        return [depId, selectedVersion ?? depVersion];
      })
    ) as Record<string, string>;

    const implicitDeps = await this.getImplicitDependencies(packageObject, explicitImplicitVersions);

    return { ...implicitDeps, ...normalizedExplicitDeps };
  }

  public async install(packageId: string | FhirPackageIdentifier): Promise<boolean> {
    let packageObject: FhirPackageIdentifier;
    if (typeof packageId === 'string') {
      packageId = packageId.trim();
      if (packageId.length === 0) {
        throw new Error('Invalid package identifier: empty string');
      }
      packageObject = await this.toPackageObject(packageId);
    } else {
      packageObject = packageId;
    }

    // Registry disabled mode: never attempt downloads.
    // All required packages (including transitive + implicit deps) must already exist.
    if (this.isRegistryDisabled()) {
      const missing = await this.collectMissingPackages(packageObject, { requireStrictMaterialization: true });
      if (missing.length > 0) {
        const preview = missing.slice(0, 10).join(', ');
        const suffix = missing.length > 10 ? ` (and ${missing.length - 10} more)` : '';
        throw new Error(this.formatRegistryDisabledMessage(
          `Required packages are missing or incomplete in cache (${this.cachePath}). Missing: ${preview}${suffix}`
        ));
      }
      return true;
    }
    
    // Prevent circular installations
    const packageKey = `${packageObject.id}@${packageObject.version}`;
    if (this.installingPackages.has(packageKey)) {
      return true;
    }

    return await this.withInstallParticipant(packageObject, async () => {
      return await this.withDebugTiming(
        `install ${this.formatPackageForDebug(packageObject)}`,
        async () => {
          await this.withPackageInstallLock(packageObject, async () => {
            return await this.materializePackageWithoutDependencies(packageObject);
          });

          this.installingPackages.add(packageKey);
          try {
            await this.installPackageDependencies(packageObject);
            return true;
          } finally {
            this.installingPackages.delete(packageKey);
          }
        }
      );
    });
  }

  private async materializePackageWithoutDependencies(packageObject: FhirPackageIdentifier): Promise<boolean> {
    return await this.withDebugTiming(
      `materialize-package-without-dependencies ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        const installedShallow = await this.isStrictlyMaterialized(packageObject);
        if (installedShallow) {
          this.logger.debug?.(
            `Package ${this.formatPackageForDebug(packageObject)} was materialized while waiting for the package install lock; skipping download and using the shared cache entry.`
          );
          return false;
        }

        const dirPath = await this.getPackageDirPath(packageObject);
        if (await fs.exists(dirPath)) {
          await fs.remove(dirPath);
        }

        const tempPath = await this.downloadAndExtractTarball(packageObject);
        await this.cachePackage(packageObject, tempPath);
        return true;
      },
      (downloaded) => `downloaded=${downloaded}`
    );
  }

  private async installPackageDependencies(packageObject: FhirPackageIdentifier): Promise<void>{
    await this.withDebugTiming(
      `install-package-dependencies ${this.formatPackageForDebug(packageObject)}`,
      async () => {
        try {
          await this.getPackageIndexFile(packageObject);
        } catch (e: any) {
          if (e instanceof FhirPackageInstallError) throw e;
          throw new FhirPackageInstallError({
            packageId: packageObject.id,
            version: packageObject.version ?? 'unknown',
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            step: 'generate-index',
            cause: e,
          });
        }

        const { explicitImplicitVersions } = await this.collectExplicitDependencyClosure(packageObject);
        const dependencyQueue = await this.collectPlannedDependencyClosure(packageObject, explicitImplicitVersions);
        if (dependencyQueue.size === 0) {
          return;
        }

        this.logger.debug?.(
          `Planned dependency closure for ${this.formatPackageForDebug(packageObject)} with ${dependencyQueue.size} package(s).`
        );

        const completedLocally = new Set<string>();
        const claimedElsewhere = new Set<string>();
        let lastWaitLogAt = 0;

        while (true) {
          const pending: FhirPackageIdentifier[] = [];

          for (const [dependencyKey, dependency] of dependencyQueue) {
            const installed = completedLocally.has(dependencyKey)
              || await this.isStrictlyMaterialized(dependency)
              || (claimedElsewhere.has(dependencyKey) && await this.isStrictlyMaterialized(dependency));
            if (installed) {
              continue;
            }

            pending.push(dependency);
          }

          if (pending.length === 0) {
            return;
          }

          let claimedWork = false;
          let claimedDependencyKey: string | null = null;
          for (const dependency of pending) {
            const dependencyKey = this.getPackageKey(dependency);

            if (await this.isStrictlyMaterialized(dependency)) {
              claimedElsewhere.delete(dependencyKey);
              completedLocally.add(dependencyKey);
              continue;
            }

            const claim = await this.tryWithPackageInstallLock(dependency, async () => {
              return await this.materializePackageWithoutDependencies(dependency);
            });

            if (!claim.acquired) {
              claimedElsewhere.add(dependencyKey);
              continue;
            }

            claimedElsewhere.delete(dependencyKey);

            if (!claim.result) {
              completedLocally.add(dependencyKey);
              continue;
            }

            completedLocally.add(dependencyKey);
            this.logger.debug?.(
              `Claimed dependency work item ${this.formatPackageForDebug(dependency)} while installing ${this.formatPackageForDebug(packageObject)}.`
            );
            claimedDependencyKey = dependencyKey;
            claimedWork = true;
            break;
          }

          if (claimedWork) {
            if (pending.length > 1 && claimedDependencyKey) {
              const remainingPending = pending.filter(
                (dependency) => this.getPackageKey(dependency) !== claimedDependencyKey
              );
              await this.waitForPeerDependencyHandoff(packageObject, remainingPending);
            }
            if (pending.length > 1) {
              await new Promise((resolve) => setTimeout(resolve, DEPENDENCY_POST_CLAIM_YIELD_MS));
            }
            continue;
          }

          const now = Date.now();
          if (now - lastWaitLogAt >= DEPENDENCY_WAIT_LOG_INTERVAL_MS) {
            const preview = pending.slice(0, 5).map((dependency) => this.formatPackageForDebug(dependency)).join(', ');
            const suffix = pending.length > 5 ? `, ... (${pending.length - 5} more)` : '';
            this.logger.debug?.(
              `No immediately claimable dependency work items for ${this.formatPackageForDebug(packageObject)}; waiting ${DEPENDENCY_CLAIM_WAIT_MS}ms before retrying. Pending: ${preview}${suffix}`
            );
            lastWaitLogAt = now;
          }

          await new Promise((resolve) => setTimeout(resolve, DEPENDENCY_CLAIM_WAIT_MS));
        }
      }
    );
  }

  /**
   * Installs a package from a local file or directory.
   * The package can be a tarball file or a directory containing the package files.
   * @param src The path to the local package file or directory.
   * @param options Options for installing the package.
   * @returns A promise that resolves to true if the package was installed successfully,
   * or false if it was already installed.
   */
  public async installLocalPackage(src: string, options?: InstallPackageOptions): Promise<boolean> {
    src = src.trim();
    if (src.length === 0) {
      throw new Error('Invalid path: empty string');
    }
    if (!await fs.exists(src)) {
      throw new Error(`Invalid path: ${src} does not exist`);
    }

    const fullPath = path.isAbsolute(src) ? src : path.resolve(src);
    const isDirectory = (await fs.lstat(fullPath)).isDirectory();
    let finalPath: string;

    if (isDirectory) {
      this.logger.info(`Installing package from directory: ${fullPath}`);
      finalPath = fullPath;
    } else {
      this.logger.info(`Installing package from file: ${fullPath}`);
      finalPath = await this.extractTarball(fullPath, { packageLabel: path.basename(fullPath) });
    }
  
    let packageObject: FhirPackageIdentifier;
    if (options?.packageId) {
      packageObject = await this.toPackageObject(options.packageId);
    } else {
      const potentialPackagePath = path.join(finalPath, 'package');
      const manifestFilePath = await fs.exists(potentialPackagePath) ? potentialPackagePath : finalPath;
      const manifest = await this.readManifestFile(manifestFilePath);
      packageObject = { id: manifest.name, version: manifest.version };
    }

    return await this.withPackageInstallLock(packageObject, async () => {
      const alreadyInstalled = await this.isStrictlyMaterialized(packageObject);
      if (alreadyInstalled && !options?.override) {
        this.logger.info(`Package ${packageObject.id}@${packageObject.version} is already installed`);
        return false;
      }

      await fs.remove(await this.getPackageDirPath(packageObject));

      await this.cachePackage(packageObject, finalPath, !isDirectory); // if the source is a file, we can move the temp dir to the cache

      if (options?.installDependencies) {
        await this.installPackageDependencies(packageObject);
      }

      return true;
    });
  }

  /**
   * Downloads a package tarball and optionally extracts it to a destination directory.
   * 
   * Behavior:
   * - If `extract` is false or omitted: downloads the tarball as a .tgz file to the destination directory.
   * - If `extract` is true: downloads and extracts the package into a subdirectory of the destination path.
   *
   * @param packageId A package identifier string or a FhirPackageIdentifier object.
   * @param options Options controlling the download and extraction behavior.
   * @returns 
   * - If `extract` is false: the full path to the downloaded tarball file.
   * - If `extract` is true: the full path to the extracted package directory.
   */
  public async downloadPackage(
    packageId: string | FhirPackageIdentifier,
    options?: DownloadPackageOptions): Promise<string> 
  {
    const { destination = '.', overwrite = false, extract = false } = options || {} as DownloadPackageOptions;

    const packageObject = await this.toPackageObject(packageId);
    const packageName = `${packageObject.id}@${packageObject.version}`;

    const resolvedDestination = destination && path.isAbsolute(destination)
      ? destination
      : path.join(path.resolve(destination ||'.'));
    const downloadPath = path.join(resolvedDestination, `${packageObject.id}-${packageObject.version}.tgz`);
    let finalPath = downloadPath;
    if (extract) {
      finalPath = path.join(resolvedDestination, await this.toDirName(packageObject));
    }
    this.logger.info(`Downloading ${packageName} to: ${downloadPath}`);

    if (extract) {
      const tempDirectory = await this.downloadAndExtractTarball(packageObject);
      await fs.move(tempDirectory, finalPath, { overwrite });
    } else {
      const tempDirectory = await this.downloadTarball(packageObject);
      await fs.move(tempDirectory, finalPath, { overwrite });
    }
    this.logger.info(`Downloaded ${packageName} to: ${downloadPath}`);
    if (extract) {
      this.logger.info(`Extracted ${packageName} to: ${finalPath}`);
    }
    return finalPath;
  }
}

/**
 * Default instance export for convenience
 */
const fpi = new FhirPackageInstaller();
export default fpi;

export type {
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions,
  FpiConfig
} from './types';

export type {
  PackageIndex,
  PackageManifest,
  FileInPackageIndex
} from '@outburn/types';

