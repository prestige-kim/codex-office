'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Monitor, JsonlReader } = require('../lib/monitor'); const { record:r, item, call } = require('./helpers');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const append = (f, records) => fs.appendFileSync(f, records.map(o => JSON.stringify(o)).join('\n') + '\n');
test('partial lines and UTF-8 byte boundaries survive polling, malformed lines are isolated', t => {
  const dir = fixture(t), file = path.join(dir, 'log.jsonl'), seen = []; fs.writeFileSync(file, '');
  const reader = new JsonlReader(file, o => seen.push(o)); const buf = Buffer.from(JSON.stringify({ text: '한글 🚀' }) + '\n');
  const split = buf.indexOf(Buffer.from('한')) + 1;
  fs.appendFileSync(file, buf.subarray(0, split)); reader.read(); assert.equal(seen.length, 0);
  fs.appendFileSync(file, buf.subarray(split)); reader.read(); assert.equal(seen[0].text, '한글 🚀');
  fs.appendFileSync(file, 'broken\n{"n":1}\n'); reader.read(); assert.equal(reader.errors, 1); assert.equal(seen[1].n, 1);
});
test('startup restores terminal state, append resumes it, sources remain byte-identical, truncation resets counts', t => {
  const root = fixture(t), f = path.join(root, 'session.jsonl');
  append(f, [r('session_meta', { id: 'main', cwd: '/project/app' }), r('event_msg', { type: 'task_started', turn_id: 't' }), call('exec_command', { cmd: 'npm test' }), r('event_msg', { type: 'task_complete' })]);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); const before = hash(), mtime = fs.statSync(f).mtimeMs;
  const m = new Monitor(root); m.discover(); m.poll(); const s = m.snapshot().floors[0].sessions[0];
  assert.equal(s.status, 'completed'); assert.equal(s.waiting, 0); assert.equal(s.active, false); assert.equal(hash(), before); assert.equal(fs.statSync(f).mtimeMs, mtime);
  append(f, [r('event_msg', { type: 'task_started', turn_id: 't2' }), call('exec_command', { cmd: 'rg x .' }, 'new')]);
  m.poll(); assert.equal(m.snapshot().floors[0].sessions[0].state.room, 'library');
  fs.writeFileSync(f, ''); append(f, [r('session_meta', { id: 'main', cwd: '/project/app' }), r('event_msg', { type: 'turn_aborted' })]);
  m.poll(); assert.equal(m.states.get('main').tools, 0); assert.equal(m.snapshot().floors[0].sessions[0].status, 'interrupted');
});
test('late parent discovery, nested cwd isolation and explicit child completion avoid ghost workers', t => {
  const root = fixture(t), child = path.join(root, 'a-child.jsonl'), main = path.join(root, 'z-main.jsonl');
  append(child, [r('session_meta', { id: 'child', cwd: '/project/app', parent_thread_id: 'main' }), r('event_msg', { type: 'task_started', turn_id: 'c' })]);
  append(main, [r('session_meta', { id: 'main', cwd: '/project/app' }), r('event_msg', { type: 'task_started', turn_id: 'm' })]);
  append(path.join(root, 'other.jsonl'), [r('session_meta', { id: 'other', cwd: '/project/app/nested' })]);
  const m = new Monitor(root); m.discover(); let snap = m.snapshot(); assert.equal(snap.floors.length, 2);
  const parent = snap.floors.find(f => f.proj === '/project/app').sessions[0]; assert.equal(parent.state.agents.length, 1);
  append(child, [r('event_msg', { type: 'task_complete' })]); m.poll(); assert.equal(m.snapshot().floors.find(f => f.proj === '/project/app').sessions[0].state.agents.length, 0);
});
test('activity links can connect children lacking a parent field, symlink transcripts are skipped', t => {
  const root = fixture(t);
  append(path.join(root, 'main.jsonl'), [r('session_meta', { id: 'main', cwd: '/app' }), item('SubAgentActivity', { id: 'link', agent_thread_id: 'kid', kind: 'spawn' })]);
  append(path.join(root, 'kid.jsonl'), [r('session_meta', { id: 'kid', cwd: '/app' }), r('event_msg', { type: 'task_started' })]);
  fs.symlinkSync(path.join(root, 'main.jsonl'), path.join(root, 'link.jsonl'));
  const m = new Monitor(root); m.discover(); assert.equal(m.files.size, 2); assert.equal(m.snapshot().floors[0].sessions.length, 1); assert.equal(m.snapshot().floors[0].sessions[0].state.agents.length, 1);
});
test('a missing source is an empty office and expired quota remains last observed', t => {
  const root = fixture(t), m = new Monitor(path.join(root, 'missing')); m.discover(); assert.equal(m.snapshot().diagnostics.sourceExists, false);
  const f = path.join(root, 'quota.jsonl'); append(f, [r('session_meta', { id: 'q', cwd: '/app' }), r('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 88, resets_at: 1, window_minutes: 300 } } })]);
  const live = new Monitor(root); live.discover(); assert.equal(live.snapshot().usage.codex.primary.used, 88); assert.equal(live.snapshot().usage.codex.expired, true);
});
test('in-place rewrites with the same byte length restore a fresh state', t => {
  const root = fixture(t), file = path.join(root, 'replace.jsonl');
  const old = [r('session_meta', { id: 'same', cwd: '/app' }), r('event_msg', { type: 'task_complete' })].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, old); const m = new Monitor(root); m.discover();
  // Pad JSON whitespace to keep the exact original file size.
  const lines = old.split('\n'); const o = JSON.parse(lines[1]); o.payload.type = 'turn_aborted'; lines[1] = JSON.stringify(o) + ' '; const replacement = lines.join('\n');
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(old)); fs.writeFileSync(file, replacement); m.poll();
  assert.equal(m.snapshot().floors[0].sessions[0].status, 'interrupted');
});
