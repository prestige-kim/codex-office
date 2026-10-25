#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-package-check-'));
const run = (tool, args) => execFileSync(tool, args, { stdio: 'inherit' });
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try {
  run('/usr/bin/ditto', ['-x', '-k', path.join(root, 'docs/CodexOffice.app.zip'), dir]);
  const app = path.join(dir, 'CodexOffice.app'), office = path.join(app, 'Contents/Resources/office');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run('/usr/bin/lipo', [path.join(app, 'Contents/MacOS/CodexOffice'), '-verify_arch', 'arm64', 'x86_64']);
  const expected = ['server.js','office.html','package.json','LICENSE','THIRD_PARTY_NOTICES.md','desktop/server-host.js',...fs.readdirSync(path.join(root,'lib')).filter(x => x.endsWith('.js')).map(x => 'lib/' + x)];
  for (const file of expected) if (digest(path.join(root, file)) !== digest(path.join(office, file))) throw new Error('Packaged source differs: ' + file);
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (/\.jsonl$|^data$|^auth\.json$|^launcher\.json$|^view-preferences\.json$|^node_modules$/.test(e.name)) throw new Error('Private/runtime file in app: ' + e.name);
    if (e.isDirectory()) walk(path.join(d, e.name));
  } }; walk(app);
  console.log('App ZIP verified: signatures, both CPU architectures, current sources, no runtime/private files.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
