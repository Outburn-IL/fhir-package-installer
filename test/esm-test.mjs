// ESM smoke test for fhir-package-installer
import { FhirPackageInstaller } from 'fhir-package-installer';

console.log('Running ESM import smoke test');
const fpi = new FhirPackageInstaller({ allowHttp: true, skipExamples: true });
console.log('Created FhirPackageInstaller instance (ESM). Cache path:', fpi.getCachePath());
