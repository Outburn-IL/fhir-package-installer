import http from 'http';
import https from 'https';
import { URL } from 'url';

interface PackageVersion {
  dist?: {
    tarball?: string;
  };
}

/**
 * Mock JFrog Artifactory server that simulates:
 * 1. Authentication with Bearer tokens
 * 2. HTTP redirects (302) for tarball downloads
 * 3. npm registry API responses
 * 4. Proxying to the real Simplifier registry
 */
export class MockArtifactoryServer {
  private server: http.Server;
  private port: number;
  private readonly validToken = 'test-token';

  constructor(port: number = 3333) {
    this.port = port;
    this.server = this.createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`Mock Artifactory server running on port ${this.port}`);
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Mock Artifactory server stopped');
        resolve();
      });
    });
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  getValidToken(): string {
    return this.validToken;
  }

  private createServer(): http.Server {
    return http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Check authentication
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const token = authHeader.substring('Bearer '.length);
      if (token !== this.validToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      const url = new URL(req.url!, `http://localhost:${this.port}`);
      
      // Debug logging
      console.log(`Mock server received request: ${req.method} ${url.pathname}`);
      
      try {
        if (url.pathname.includes('/-/')) {
          // Tarball download request - simulate redirect
          await this.handleTarballDownload(req, res, url);
        } else if (url.pathname.includes('/artifactory/api/npm/')) {
          // Artifactory API request - extract package name and handle as metadata
          await this.handleArtifactoryRequest(req, res, url);
        } else if (url.pathname.endsWith('/')) {
          // Package metadata request
          await this.handlePackageMetadata(req, res, url);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }

  private async handleArtifactoryRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    // Extract package name from Artifactory URL pattern: /artifactory/api/npm/repo-name/package-name/
    const pathParts = url.pathname.split('/').filter(p => p);
    const packageName = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
    
    if (!packageName) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Package not found' }));
      return;
    }

    // Use the existing metadata handler logic but with extracted package name
    try {
      const simplifierUrl = `https://packages.fhir.org/${packageName}/`;
      const packageData = await this.fetchFromSimplifier(simplifierUrl);
      
      // Modify tarball URLs to point to our mock server
      const modifiedResponse = this.modifyTarballUrls(packageData.data);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modifiedResponse));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Package not found' }));
    }
  }

  private async handlePackageMetadata(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    // Extract package name from URL path
    const packageName = url.pathname.split('/').filter(p => p)[0];
    
    if (!packageName) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Package not found' }));
      return;
    }

    try {
      const simplifierUrl = `https://packages.fhir.org/${packageName}/`;
      const packageData = await this.fetchFromSimplifier(simplifierUrl);
      
      // Modify tarball URLs to point to our mock server
      const modifiedResponse = this.modifyTarballUrls(packageData.data);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(modifiedResponse));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Package not found' }));
    }
  }

  private async handleTarballDownload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    // Extract package info from tarball URL
    const pathParts = url.pathname.split('/');
    const tgzFile = pathParts[pathParts.length - 1];
    const packageName = pathParts[pathParts.length - 3];
    
    // Simulate redirect to Simplifier
    const simplifierTarballUrl = `https://packages.simplifier.net/${packageName}/-/${tgzFile}`;
    
    res.writeHead(302, { 
      'Location': simplifierTarballUrl,
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({ message: 'Redirecting to Simplifier' }));
  }

  private async fetchFromSimplifier(url: string): Promise<{ statusCode: number; data: string }> {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode || 500,
              data: data
            });
          } catch (error) {
            reject(error);
          }
        });
      }).on('error', reject);
    });
  }

  private modifyTarballUrls(responseData: string): unknown {
    try {
      const parsed = JSON.parse(responseData);
      
      if (parsed.versions) {
        for (const version of Object.values(parsed.versions) as PackageVersion[]) {
          if (version.dist && version.dist.tarball) {
            // Replace Simplifier URL with our mock server URL
            const originalUrl = new URL(version.dist.tarball);
            const pathParts = originalUrl.pathname.split('/');
            const packageName = pathParts[1];
            const tgzFile = pathParts[3];
            
            version.dist.tarball = `http://localhost:${this.port}/${packageName}/-/${tgzFile}`;
          }
        }
      }
      
      return parsed;
    } catch {
      return responseData;
    }
  }
}
