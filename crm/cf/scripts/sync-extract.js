// Regenerates src/extract.js (ES module for the Worker) from the body of public/extract.js. Run: node scripts/sync-extract.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../public/extract.js'), 'utf8');
const m = src.match(/\/\*BODY-START\*\/[\s\S]*\/\*BODY-END\*\//);
if (!m) throw new Error('BODY markers not found in public/extract.js');
const out = '// GENERATED from public/extract.js by scripts/sync-extract.js: do not edit by hand.\n' +
  '// Extracts full name / city / address / postal index from chat messages (see public/extract.js).\n' + m[0] +
  '\nexport { extractOrderFields, findCity, findIndex };\n';
fs.writeFileSync(path.join(__dirname, '../src/extract.js'), out);
