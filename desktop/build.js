#!/usr/bin/env node
'use strict';
// Builds only generated artifacts. No provider directories or user settings are read.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('The macOS app must be built on macOS with Xcode Command Line Tools.');
const root = path.resolve(__dirname, '..'), build = path.join(root, 'build');
// Build the signed bundle outside cloud-synced Documents folders. File providers
// otherwise attach FinderInfo while signing and invalidate the resource envelope.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-app-'));
const app = path.join(staging, 'CodexOffice.app'), contents = path.join(app, 'Contents');
fs.mkdirSync(build, { recursive: true });
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
const resource = path.join(contents, 'Resources'), office = path.join(resource, 'office');
fs.mkdirSync(path.join(office, 'desktop'), { recursive: true });
fs.mkdirSync(path.join(office, 'lib'));
for (const name of ['server.js','office.html','package.json','LICENSE','THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(office, name));
for (const name of fs.readdirSync(path.join(root, 'lib'))) if (name.endsWith('.js')) fs.copyFileSync(path.join(root, 'lib', name), path.join(office, 'lib', name));
fs.copyFileSync(path.join(__dirname, 'server-host.js'), path.join(office, 'desktop', 'server-host.js'));
const run = (file, args) => execFileSync(file, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(build, 'ModuleCache') } });
for (const arch of ['arm64', 'x86_64']) {
  run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${arch}-apple-macos13.0`, '-module-cache-path', path.join(build, 'ModuleCache'), '-framework', 'AppKit', '-framework', 'WebKit', path.join(__dirname, 'CodexOffice.swift'), '-o', path.join(build, `CodexOffice-${arch}`)]);
}
run('/usr/bin/lipo', ['-create', path.join(build, 'CodexOffice-arm64'), path.join(build, 'CodexOffice-x86_64'), '-output', path.join(contents, 'MacOS', 'CodexOffice')]);
fs.chmodSync(path.join(contents, 'MacOS', 'CodexOffice'), 0o755);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.prestigekim.codexoffice</string>
<key>CFBundleExecutable</key><string>CodexOffice</string>
<key>CFBundleName</key><string>CodexOffice</string>
<key>CFBundleDisplayName</key><string>코덱스 오피스</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticTermination</key><false/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`);
const iconset = path.join(build, 'AppIcon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
run('/usr/bin/xcrun', ['swift', '-module-cache-path', path.join(build, 'ModuleCache'), path.join(__dirname, 'Icon.swift'), iconset]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resource, 'AppIcon.icns')]);
// File-provider folders can attach FinderInfo to newly generated .app bundles.
// Remove only that signing-incompatible metadata; leave security/quarantine attributes alone.
const attributes = execFileSync('/usr/bin/xattr', [app], { encoding: 'utf8' }).split('\n');
if (attributes.includes('com.apple.FinderInfo')) run('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', app]);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
const zip = path.join(root, 'docs', 'CodexOffice.app.zip');
fs.rmSync(zip, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
fs.writeFileSync(path.join(build, 'app-path.txt'), app + '\n');
console.log(`Built ${app}\nPackaged ${zip}`);
