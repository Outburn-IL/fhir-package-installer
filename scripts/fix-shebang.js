import { readFileSync, writeFileSync } from 'fs';

const cliPath = 'cli/index.js';
const content = readFileSync(cliPath, 'utf8');

// Fix shebang line - ensure proper newline after #!/usr/bin/env node
// ncc incorrectly concatenates the shebang with the first import
const fixed = content.replace(/^#!\/usr\/bin\/env node\r?import/, '#!/usr/bin/env node\r\nimport');

writeFileSync(cliPath, fixed, 'utf8');
console.log('Fixed shebang in cli/index.js');