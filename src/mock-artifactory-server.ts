import http from 'http';
import https from 'https';
import { URL } from 'url';

/**
 * TEST-ONLY: Minimal in-memory mock of a subset of the JFrog Artifactory npm API surface
 * tailored to fhir-package-installer integration testing.
 *
 * Features:
 * 1. Bearer token auth (single fixed token) -> 401 if missing, 403 if invalid.
 * 2. Package metadata proxying to the real Simplifier / packages.fhir.org endpoint.
 * 3. Tarball URL rewriting so downstream code exercises redirect logic.
 * 4. Tarball request simulation via 302 redirect to the real Simplifier tarball.
 *
 * NOT FOR PRODUCTION USE. Surface is intentionally small; breaking changes unlikely but
 * additions may occur in minor versions. Kept here so downstream libraries can reuse
 * without duplicating test utilities.
 */
export interface MockArtifactoryServerApi {
  /** Starts listening. If port was 0, a random available port will be selected. */
  start(): Promise<void>;
  /** Gracefully stops the server. */
  stop(): Promise<void>;
  /** Base URL (http://localhost:port). */
  getBaseUrl(): string;
  /** Returns the static valid bearer token you must send under Authorization header. */
  getValidToken(): string;
}

interface PackageVersionMeta {
  dist?: { tarball?: string };
  [k: string]: unknown;
}

class InternalMockArtifactoryServer implements MockArtifactoryServerApi {
  private server: http.Server;
  private port: number;
  private readonly validToken = 'test-token';

  constructor(port: number) {
    this.port = port;
    this.server = this.createServer();
  }

  async start(): Promise<void> {
    if (this.server.listening) return; // idempotent
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => resolve());
    });
    // If ephemeral port requested (0), update to the actual assigned port.
    const addr = this.server.address();
    if (typeof addr === 'object' && addr && 'port' in addr) this.port = addr.port;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return; // idempotent
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  getBaseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getValidToken(): string {
    return this.validToken;
  }

  // ---- Internal implementation ----
  private createServer(): http.Server {
    return http.createServer(async (req, res) => {
      // Basic CORS for convenience
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(200); res.end(); return;
      }

      // Auth checks
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Unauthorized' });
        return;
      }
      const token = authHeader.substring('Bearer '.length);
      if (token !== this.validToken) {
        this.json(res, 403, { error: 'Forbidden' });
        return;
      }

      const url = new URL(req.url || '/', this.getBaseUrl());

      try {
        if (url.pathname.includes('/-/')) {
          this.handleTarballRedirect(res, url);
          return;
        }
        if (url.pathname.includes('/artifactory/api/npm/')) {
          await this.handleArtifactoryMetadata(res, url);
          return;
        }
        if (url.pathname.endsWith('/')) {
          await this.handleSimplifierMetadata(res, url);
          return;
        }
        this.json(res, 404, { error: 'Not found' });
      } catch {
        this.json(res, 500, { error: 'Internal server error' });
      }
    });
  }

  private async handleArtifactoryMetadata(res: http.ServerResponse, url: URL) {
    // /artifactory/api/npm/<repo>/<package>/
    const segments = url.pathname.split('/').filter(Boolean);
    const packageName = segments.at(-1) || segments.at(-2);
    if (!packageName) { this.json(res, 404, { error: 'Package not found' }); return; }
    await this.fetchAndRewrite(packageName, res);
  }

  private async handleSimplifierMetadata(res: http.ServerResponse, url: URL) {
    // /hl7.fhir.uv.sdc/ style path
    const packageName = url.pathname.split('/').filter(Boolean)[0];
    if (!packageName) { this.json(res, 404, { error: 'Package not found' }); return; }
    await this.fetchAndRewrite(packageName, res);
  }

  private handleTarballRedirect(res: http.ServerResponse, url: URL) {
    const parts = url.pathname.split('/').filter(Boolean);
    // pattern: <package>/-/<file.tgz>
    const tgzFile = parts.at(-1);
    const packageName = parts.at(-3); // <package>/-/<file>
    if (!tgzFile || !packageName) { this.json(res, 404, { error: 'Tarball not found' }); return; }
    const redirectUrl = `https://packages.simplifier.net/${packageName}/-/${tgzFile}`;
    res.writeHead(302, { Location: redirectUrl, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Redirecting to Simplifier' }));
  }

  private async fetchAndRewrite(packageName: string, res: http.ServerResponse) {
    try {
      const sourceUrl = `https://packages.fhir.org/${packageName}/`;
      const { data } = await this.fetchRaw(sourceUrl);
      const modified = this.rewriteTarballs(data);
      this.json(res, 200, modified);
    } catch {
      this.json(res, 404, { error: 'Package not found' });
    }
  }

  private fetchRaw(url: string): Promise<{ statusCode: number; data: string }> {
    return new Promise((resolve, reject) => {
      https.get(url, (resp) => {
        let acc = '';
        resp.on('data', (chunk) => acc += chunk);
        resp.on('end', () => resolve({ statusCode: resp.statusCode || 0, data: acc }));
      }).on('error', reject);
    });
  }

  private rewriteTarballs(raw: string): unknown {
    try {
      const json = JSON.parse(raw);
      if (json.versions) {
        for (const v of Object.values(json.versions) as PackageVersionMeta[]) {
          if (v.dist?.tarball) {
            const original = new URL(v.dist.tarball);
            const parts = original.pathname.split('/').filter(Boolean); // <package>/-/<file>
            const packageName = parts[0];
            const tgzFile = parts.at(-1);
            if (packageName && tgzFile) {
              v.dist.tarball = `${this.getBaseUrl()}/${packageName}/-/${tgzFile}`;
            }
          }
        }
      }
      return json;
    } catch {
      return raw; // fall back to raw string
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
}

/** Factory to create a new mock Artifactory server instance.
 * @param port Optional port. Pass 0 for ephemeral.
 */
export function createMockArtifactoryServer(port: number = 3333): MockArtifactoryServerApi {
  return new InternalMockArtifactoryServer(port);
}

export const MOCK_ARTIFACTORY_VALID_TOKEN = 'test-token';
