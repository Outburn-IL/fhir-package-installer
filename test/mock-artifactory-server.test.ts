import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockArtifactoryServer } from 'fhir-package-installer/mock-artifactory-server';
import https from 'https';
import http from 'http';

describe('Mock Artifactory Server', () => {
  let mockServer: ReturnType<typeof createMockArtifactoryServer>;
  const port = 3334;

  beforeAll(async () => {
    mockServer = createMockArtifactoryServer(port);
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('should reject requests without authorization', async () => {
    const response = await makeRequest(`http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/hl7.fhir.uv.sdc/`);
    expect(response.statusCode).toBe(401);
  });

  it('should reject requests with invalid token', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/hl7.fhir.uv.sdc/`,
      'Bearer invalid-token'
    );
    expect(response.statusCode).toBe(403);
  });

  it('should accept requests with valid token and proxy to Simplifier', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/hl7.fhir.uv.sdc/`,
      'Bearer test-token'
    );
    expect(response.statusCode).toBe(200);
    
    const data = JSON.parse(response.data);
    expect(data.name).toBe('hl7.fhir.uv.sdc');
    expect(data.versions).toBeDefined();
    
    // Check that tarball URLs have been modified to point to our mock server
    const version = Object.keys(data.versions)[0];
    const tarballUrl = data.versions[version].dist.tarball;
    expect(tarballUrl).toContain(`localhost:${port}`);
  }, 30000);

  it('should handle tarball download requests with redirects', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/hl7.fhir.uv.sdc/-/hl7.fhir.uv.sdc-3.0.0.tgz`,
      'Bearer test-token'
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('packages.simplifier.net');
  });
});

function makeRequest(url: string, authorization?: string): Promise<{
  statusCode: number;
  data: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: authorization ? { 'Authorization': authorization } : {}
    };

    const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          data,
          headers: res.headers as Record<string, string>
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}
