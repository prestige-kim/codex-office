'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { start } = require('../server'); const { record:r } = require('./helpers');
function request(port, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers })); }); req.on('error', reject); if (body) req.write(body); req.end(); });
}
test('HTTP/SSE stays local, settings only write office data, read-only snapshots retain source hash', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-http-')), root = path.join(dir, 'sessions'), claudeRoot = path.join(dir, 'claude', 'projects'); fs.mkdirSync(root); fs.mkdirSync(claudeRoot, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(root, 'log.jsonl'); fs.writeFileSync(log, [r('session_meta', { id: 'test', cwd: '/app' }), r('event_msg', { type: 'task_complete' })].map(JSON.stringify).join('\n') + '\n');
  const cl = path.join(claudeRoot, 'claude-session.jsonl'); fs.writeFileSync(cl, JSON.stringify({ type: 'assistant', sessionId: 'test', cwd: '/app', uuid: 'c1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: '완료' }], stop_reason: 'end_turn' } }) + '\n');
  const settings = path.join(dir, 'claude', 'settings.json'); fs.writeFileSync(settings, '{"statusLine":{"command":"keep-original"}}');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(log)).update(fs.readFileSync(cl)).update(fs.readFileSync(settings)).digest('hex'), before = hash();
  let app; const port = await new Promise((resolve, reject) => { app = start({ root, claudeRoot, dataDir: path.join(dir, 'office-data'), port: 0, onReady: s => resolve(s.address().port) }); app.server.on('error', reject); });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  const page = await request(port, '/'); assert.equal(page.status, 200); assert.ok(!page.data.includes('https://fonts.googleapis.com')); assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  const snap = JSON.parse((await request(port, '/snapshot')).data); assert.equal(snap.floors[0].sessions[0].status, 'completed');
  assert.equal(snap.floors[0].sessions.length, 2); assert.deepEqual(new Set(snap.floors[0].sessions.map(s => s.key)), new Set(['codex/test','claude/test']));
  const bad = await request(port, '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"building":"x","user":"y"}' }); assert.equal(bad.status, 403);
  const host = await request(port, '/snapshot', { headers: { Host: 'evil.example' } }); assert.equal(host.status, 403);
  const setup = await request(port, '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ building: '내 오피스', user: '대표', statusLine: true }) });
  assert.equal(JSON.parse(setup.data).ok, true); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'office-data', 'office.json'))), { building: '내 오피스', user: '대표' });
  await new Promise((resolve, reject) => { const req = http.get(`http://127.0.0.1:${port}/events`, res => { res.once('data', b => { try { assert.match(b.toString(), /event: snap/); resolve(); } catch (e) { reject(e); } req.destroy(); }); }); req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); }); });
  assert.equal(hash(), before);
});
test('configuration cannot be placed in the source tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-path-'));
  try { assert.throws(() => start({ root: dir, dataDir: path.join(dir, 'settings') }), /outside/); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('configuration cannot be placed in the Claude transcript tree or symlink into it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-office-path-')), claudeRoot = path.join(dir, 'projects'); fs.mkdirSync(claudeRoot);
  try {
    assert.throws(() => start({ root: path.join(dir, 'codex'), claudeRoot, dataDir: path.join(claudeRoot, 'settings') }), /outside/);
    fs.symlinkSync(claudeRoot, path.join(dir, 'alias'));
    assert.throws(() => start({ root: path.join(dir, 'codex'), claudeRoot, dataDir: path.join(dir, 'alias', 'settings') }), /outside/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
