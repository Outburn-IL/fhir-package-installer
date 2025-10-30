// Minimal ESM import verification for mock-artifactory-server subpath
import { createMockArtifactoryServer, MOCK_ARTIFACTORY_VALID_TOKEN } from 'fhir-package-installer/mock-artifactory-server';

if (typeof createMockArtifactoryServer !== 'function') {
  console.error('Factory was not a function');
  process.exit(1);
}

const server = createMockArtifactoryServer(0);
await server.start();
if (!server.getBaseUrl().startsWith('http://localhost:')) {
  console.error('Base URL incorrect');
  process.exit(1);
}
if (server.getValidToken() !== MOCK_ARTIFACTORY_VALID_TOKEN) {
  console.error('Token mismatch');
  process.exit(1);
}
await server.stop();
console.log('ESM mock-artifactory import test succeeded');
