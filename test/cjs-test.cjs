// CommonJS smoke test for fhir-package-installer
/* eslint-disable */
const { FhirPackageInstaller } = require('fhir-package-installer');

console.log('CJS require keys:', Object.keys(require('fhir-package-installer')));
const fpi = new FhirPackageInstaller({ allowHttp: true, skipExamples: true });
console.log('Created FhirPackageInstaller instance (CJS). Cache path:', fpi.getCachePath());
