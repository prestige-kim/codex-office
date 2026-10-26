'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto'), { spawn } = require('node:child_process'), { once } = require('node:events');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-desktop-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const p of ['codex/sessions', 'claude/projects']) fs.mkdirSync(path.join(dir, p), { recursive: true });
  const log = path.join(dir, 'codex/sessions/rollout.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'session_meta', payload: { id: 'desktop-test', cwd: '/demo' } }) + '\n');
  return { dir, log, env: { ...process.env, OFFICE_DATA_DIR: path.join(dir, 'office'), CODEX_SESSIONS_DIR: path.join(dir, 'codex/sessions'), CLAUDE_PROJECTS_DIR: path.join(dir, 'claude/projects'), NO_CODEX: '', NO_CLAUDE: '' } };
}
function child(t, env) {
  const proc = spawn(process.execPath, [env.OFFICE_TEST_HOST || path.resolve(__dirname, '../desktop/server-host.js')], { env, stdio: ['pipe','pipe','pipe'] });
  t.after(() => { if (proc.exitCode == null) proc.kill('SIGKILL'); }); return proc;
}
function ready(proc) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('native child startup timeout')), 8000);
    const exit = code => { clearTimeout(timer); reject(new Error('child exited before ready: ' + code)); };
    proc.once('exit', exit);
    proc.stdout.on('data', b => { buffer += b; let i; while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.type === 'ready') { clearTimeout(timer); proc.removeListener('exit', exit); resolve(value); }
      else if (value.type === 'fatal') { clearTimeout(timer); reject(new Error(value.message)); }
    } });
  });
}
function gone(url) { return new Promise(resolve => { const req = http.get(url, res => { res.resume(); resolve(false); }); req.on('error', () => resolve(true)); req.setTimeout(1000, () => { req.destroy(); resolve(false); }); }); }
function get(url) { return new Promise((resolve, reject) => { http.get(url, res => { let data = ''; res.on('data', b => data += b); res.on('end', () => resolve(data)); }).on('error', reject); }); }
test('a checkout host reads changed screen and server code after restart without replacing the launcher', { timeout: 15000 }, async t => {
  const f = fixture(t), source = path.join(f.dir, 'source'), repo = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(source, 'desktop'), { recursive: true });
  for (const name of ['server.js', 'office.html']) fs.copyFileSync(path.join(repo, name), path.join(source, name));
  fs.cpSync(path.join(repo, 'lib'), path.join(source, 'lib'), { recursive: true });
  const host = path.join(source, 'desktop/server-host.js'); fs.copyFileSync(path.join(repo, 'desktop/server-host.js'), host);
  const beforeHost = fs.readFileSync(host), beforeLog = fs.readFileSync(f.log), env = { ...f.env, OFFICE_TEST_HOST: host };
  const first = child(t, env), one = await ready(first);
  assert.match(await get(one.url), /대표님 지시/);
  const old = JSON.parse(await get(one.url + 'snapshot')); assert.equal(old.user, '대표'); assert.equal(old.self, fs.realpathSync(source));
  const exit = once(first, 'exit'); first.stdin.write('{"type":"shutdown"}\n'); await exit; assert.ok(await gone(one.url));
  fs.appendFileSync(path.join(source, 'office.html'), '\n<!-- checkout-revision-two -->');
  const server = path.join(source, 'server.js'); fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace("building: '코덱스 오피스'", "building: '수정 반영 확인'"));
  const second = child(t, env), two = await ready(second);
  assert.match(await get(two.url), /checkout-revision-two/);
  const next = JSON.parse(await get(two.url + 'snapshot')); assert.equal(next.building, '수정 반영 확인'); assert.equal(next.self, fs.realpathSync(source));
  assert.deepEqual(fs.readFileSync(host), beforeHost); assert.deepEqual(fs.readFileSync(f.log), beforeLog);
  const done = once(second, 'exit'); second.stdin.end(); await done; assert.ok(await gone(two.url));
});
test('native host uses a private port, closes SSE and preserves records on parent shutdown', { timeout: 10000 }, async t => {
  const f = fixture(t), before = crypto.createHash('sha256').update(fs.readFileSync(f.log)).digest('hex');
  const proc = child(t, f.env), info = await ready(proc); assert.equal(info.pid, proc.pid); assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  fs.mkdirSync(f.env.OFFICE_DATA_DIR, { recursive: true });
  const state = path.join(f.env.OFFICE_DATA_DIR, 'server-state.json'); fs.writeFileSync(state, JSON.stringify({ appPid: process.pid, serverPid: proc.pid, url: info.url }));
  assert.notEqual(new URL(info.url).port, '4777');
  const stream = http.get(info.url + 'events'); stream.on('error', () => {}); t.after(() => stream.destroy());
  const exit = once(proc, 'exit'); proc.stdin.write('{"type":"shutdown"}\n'); await exit;
  assert.equal(await gone(info.url), true); assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.log)).digest('hex'), before);
  assert.equal(fs.existsSync(state), false);
});
test('native host exits on parent pipe EOF without a shutdown message', { timeout: 10000 }, async t => {
  const f = fixture(t), proc = child(t, f.env), info = await ready(proc), exit = once(proc, 'exit');
  proc.stdin.end(); await exit; assert.equal(await gone(info.url), true);
});
test('native host exits when its owning process is killed and leaves unrelated servers running', { timeout: 10000 }, async t => {
  const f = fixture(t), marker = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => marker.listen(0, '127.0.0.1', resolve)); t.after(() => marker.close());
  const code = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,[${JSON.stringify(path.resolve(__dirname, '../desktop/server-host.js'))}],{stdio:['pipe','pipe','inherit']});p.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['-e', code], { env: f.env, stdio: ['ignore','pipe','pipe'] });
  t.after(() => { if (owner.exitCode == null) owner.kill('SIGKILL'); });
  const info = await ready(owner); assert.notEqual(info.pid, owner.pid);
  owner.kill('SIGKILL');
  for (let i = 0; i < 30 && !await gone(info.url); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await gone(info.url), true);
  assert.equal(await gone(`http://127.0.0.1:${marker.address().port}/`), false);
});
