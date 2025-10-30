/* eslint-disable @typescript-eslint/no-require-imports */
// Minimal CJS import verification for mock-artifactory-server subpath
// Runs after build/dist-to-module to emulate installed package shape.
const assert = require('assert');
const { createMockArtifactoryServer, MOCK_ARTIFACTORY_VALID_TOKEN } = require('fhir-package-installer/mock-artifactory-server');

assert.strictEqual(typeof createMockArtifactoryServer, 'function', 'Factory should be a function');
assert.strictEqual(typeof MOCK_ARTIFACTORY_VALID_TOKEN, 'string', 'Token constant should be exported');

const server = createMockArtifactoryServer(0);
server.start().then(() => {
  assert.ok(server.getBaseUrl().startsWith('http://localhost:'), 'Base URL should be localhost');
  assert.strictEqual(server.getValidToken(), MOCK_ARTIFACTORY_VALID_TOKEN, 'Valid token matches constant');
  return server.stop();
}).catch(err => {
  console.error('CJS mock-artifactory import test failed', err);
  process.exit(1);
}).then(() => {
  console.log('CJS mock-artifactory import test succeeded');
});
