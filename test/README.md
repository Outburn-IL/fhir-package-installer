# FHIR Package Installer - Dual Mode Testing

This directory contains a comprehensive testing strategy that validates both direct FHIR registry access and JFrog Artifactory proxy scenarios.

## Testing Architecture

### Mock Artifactory Server (`mock-artifactory-server.ts`)
- Simulates JFrog Artifactory behavior including:
  - Bearer token authentication
  - HTTP 302 redirects for tarball downloads
  - npm registry API proxy to Simplifier
  - Proper URL rewriting for mock server references

### Dual Mode Test Runner (`dual-mode-test-runner.ts`)
- Utility that automatically runs tests in both modes:
  - **Direct mode**: Standard connection to `packages.fhir.org`
  - **Artifactory mode**: Connection through mock Artifactory server
- Ensures identical behavior and results across both scenarios

### Test Suites

#### 1. Mock Server Tests (`mock-artifactory-server.test.ts`)
- Validates mock server functionality
- Tests authentication scenarios
- Verifies redirect handling
- Ensures proper proxy behavior

#### 2. Dual Mode Integration Tests (`fhir-package-installer.dual-mode.test.ts`)
- Runs core package installer functionality in both modes
- Tests include:
  - Authentication (valid/invalid tokens)
  - Package installation
  - Metadata retrieval
  - Redirect handling
  - Error scenarios
  - Package indexing

## Running Tests

```bash
# Run only dual-mode tests
npm run test:dual-mode

# Run only mock server tests
npm run test:mock-server

# Run all tests (includes original tests + new dual-mode tests)
npm test
```

## Key Test Scenarios

### 1. Authentication Testing
- ✅ Valid token authentication works
- ✅ Invalid token authentication fails appropriately
- ✅ Direct mode works without authentication

### 2. Redirect Handling
- ✅ Artifactory 302 redirects are followed correctly
- ✅ Authentication headers preserved through redirects
- ✅ Tarball downloads work in both modes

### 3. Behavior Consistency
- ✅ Package metadata identical in both modes
- ✅ Package installation results identical
- ✅ Error handling consistent across modes
- ✅ Generated package indexes identical

## Benefits

1. **Regression Protection**: Locks in current Artifactory behavior
2. **No External Dependencies**: Mock server eliminates reliance on trial accounts
3. **Comprehensive Coverage**: Tests both authentication and redirect scenarios
4. **Future-Proof**: Validates that updates don't break Artifactory integration
5. **Fast Execution**: Local mock server provides quick feedback

## Mock Server Implementation Details

The mock server accurately simulates JFrog Artifactory behavior:

- **Authentication**: Validates Bearer tokens
- **Proxy Logic**: Fetches real data from Simplifier
- **URL Rewriting**: Modifies tarball URLs to point back to mock server
- **Redirect Simulation**: Returns 302 responses for tarball downloads
- **Error Scenarios**: Proper 401/403 responses for auth failures

This approach ensures comprehensive testing without external service dependencies while validating the exact scenarios that caused issues during development.
