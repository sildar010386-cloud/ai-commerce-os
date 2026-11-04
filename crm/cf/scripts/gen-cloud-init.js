// Regenerates src/connector_script.js from ../../connector/cloud-init.template.sh (the single source of truth).
// Run: node scripts/gen-cloud-init.js   (test/connector.test.js fails when the generated file is stale)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../../connector/cloud-init.template.sh'), 'utf8');
const out = '// GENERATED from connector/cloud-init.template.sh by scripts/gen-cloud-init.js. Do not edit by hand.\n' +
  'export const CLOUD_INIT_TEMPLATE = ' + JSON.stringify(src) + ';\n';
fs.writeFileSync(path.join(__dirname, '../src/connector_script.js'), out);
console.log('src/connector_script.js written (' + src.length + ' chars)');
