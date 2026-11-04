// Regenerates src/connector_windows.js from ../../connector/windows/setup.template.cmd (the single source of truth).
// Run: node scripts/gen-windows-setup.js   (test/connector.test.js fails when the generated file is stale)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../../connector/windows/setup.template.cmd'), 'utf8').replace(/\r\n/g, '\n');
const out = '// GENERATED from connector/windows/setup.template.cmd by scripts/gen-windows-setup.js. Do not edit by hand.\n' +
  '// Line endings are LF here; the Worker converts to CRLF when it serves the file.\n' +
  'export const WINDOWS_SETUP_TEMPLATE = ' + JSON.stringify(src) + ';\n';
fs.writeFileSync(path.join(__dirname, '../src/connector_windows.js'), out);
console.log('src/connector_windows.js written (' + src.length + ' chars)');
