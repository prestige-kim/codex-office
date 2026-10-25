'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { CombinedMonitor, DISPLAY_WINDOW_MS: WEEK } = require('../lib/combined');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = t => new Date(t).toISOString();
function fixtures(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexRoot = path.join(dir, 'codex'), claudeRoot = path.join(dir, 'claude'); fs.mkdirSync(codexRoot); fs.mkdirSync(claudeRoot);
  const write = (file, rows) => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const codex = (id, cwd, at, extra = {}) => { const file = path.join(codexRoot, id + '.jsonl'); write(file, [
    { type: 'session_meta', timestamp: iso(at - 1000), payload: { id, cwd, ...extra } },
    { type: 'event_msg', timestamp: iso(at), payload: { type: 'task_complete' } }
  ]); return file; };
  const claude = (id, cwd, at) => { const file = path.join(claudeRoot, id + '.jsonl'); write(file, [
    { type: 'user', sessionId: id, cwd, uuid: id + '-u', timestamp: iso(at - 1000), message: { content: '작업' } },
    { type: 'assistant', sessionId: id, cwd, uuid: id + '-a', timestamp: iso(at), message: { content: [{ type: 'text', text: '완료' }], stop_reason: 'end_turn' } }
  ]); return file; };
  return { dir, codexRoot, claudeRoot, codex, claude };
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + '\n');
test('last-activity window filters both providers and empty floors, retaining the exact seven-day boundary', t => {
  const f = fixtures(t);
  f.codex('old-codex', '/old-project', NOW - WEEK - 1);
  f.claude('old-claude', '/old-project', NOW - WEEK - 1);
  f.codex('boundary', '/mixed', NOW - WEEK);
  f.codex('expired-mixed', '/mixed', NOW - WEEK - 1);
  f.claude('recent', '/mixed', NOW - 1000);
  const m = new CombinedMonitor({ ...f, now: () => NOW }); m.discover();
  const s = m.snapshot(); assert.deepEqual(s.floors.map(f => f.proj), ['/mixed']);
  assert.deepEqual(new Set(s.floors[0].sessions.map(s => s.key)), new Set(['codex/boundary', 'claude/recent']));
  assert.equal(s.floors[0].total, 2); assert.deepEqual(s.retention, { days: 7, basis: 'lastActivity', visibleSessions: 2, hiddenSessions: 3 });
  assert.equal(s.diagnostics.files, 5); assert.equal(m.monitors.reduce((n, m) => n + m.states.size, 0), 5);
});
test('sessions age out while the office stays open; filtering preserves bytes, file mtimes and directories', t => {
  const f = fixtures(t), files = [f.codex('c', '/app', NOW - WEEK + 1), f.claude('a', '/app', NOW - WEEK + 1)];
  const before = files.map(file => [digest(file), fs.statSync(file).mtimeMs]);
  let now = NOW; const m = new CombinedMonitor({ ...f, now: () => now }); m.discover(); assert.equal(m.snapshot().floors[0].total, 2);
  now += 2; m.poll(); m.discover(); const s = m.snapshot(); assert.deepEqual(s.floors, []); assert.equal(s.retention.hiddenSessions, 2);
  assert.deepEqual(files.map(file => [digest(file), fs.statSync(file).mtimeMs]), before);
  assert.deepEqual(fs.readdirSync(f.codexRoot), ['c.jsonl']); assert.deepEqual(fs.readdirSync(f.claudeRoot), ['a.jsonl']);
  // Restarting restores history but does not expose expired rows.
  const restarted = new CombinedMonitor({ ...f, now: () => now }); restarted.discover(); assert.deepEqual(restarted.snapshot().floors, []);
});
test('resuming an old session reuses its existing row and restores its floor for each provider', t => {
  const f = fixtures(t), cx = f.codex('c', '/app', NOW - WEEK - 1), cl = f.claude('a', '/app', NOW - WEEK - 1);
  const m = new CombinedMonitor({ ...f, now: () => NOW }); m.discover(); assert.deepEqual(m.snapshot().floors, []);
  append(cx, { type: 'event_msg', timestamp: iso(NOW), payload: { type: 'task_started', turn_id: 'new' } });
  append(cl, { type: 'user', sessionId: 'a', cwd: '/app', uuid: 'resumed', timestamp: iso(NOW), message: { content: '이어서 작업' } });
  m.poll(); const s = m.snapshot(); assert.equal(s.floors.length, 1); assert.equal(s.floors[0].total, 2); assert.equal(s.retention.hiddenSessions, 0);
  assert.equal(m.monitors.reduce((n, m) => n + m.states.size, 0), 2);
});
test('file touches and quota-only records do not revive an inactive session; quota display remains available', t => {
  const f = fixtures(t), file = f.codex('old', '/old', NOW - WEEK - 1);
  append(file, { type: 'event_msg', timestamp: iso(NOW), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 25, window_minutes: 300 } } } });
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
  const m = new CombinedMonitor({ ...f, now: () => NOW }); m.discover(); const s = m.snapshot();
  assert.deepEqual(s.floors, []); assert.equal(s.retention.hiddenSessions, 1); assert.equal(s.usageStatus.codex.windows[0].used, 25);
});
test('undated or invalid-date records cannot make an old transcript appear recent on restart', t => {
  const f = fixtures(t), cx = f.codex('old', '/app', NOW - WEEK - 1), cl = f.claude('old', '/app', NOW - WEEK - 1);
  append(cx, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'undated', arguments: '{"cmd":"npm test"}' } });
  append(cx, { type: 'event_msg', timestamp: 'not-a-date', payload: { type: 'task_started' } });
  append(cl, { type: 'assistant', sessionId: 'old', cwd: '/app', uuid: 'undated', message: { content: [{ type: 'tool_use', id: 'undated', name: 'Read', input: { file_path: '/app/x' } }] } });
  const m = new CombinedMonitor({ ...f, now: () => NOW }); m.discover(); assert.deepEqual(m.snapshot().floors, []);
});
test('recent child activity retains an older parent session, and an old waiting session still expires', t => {
  const f = fixtures(t), parent = f.codex('parent', '/app', NOW - WEEK - 1);
  f.codex('child', '/app', NOW - 1, { parent_thread_id: 'parent' });
  append(parent, { type: 'event_msg', timestamp: iso(NOW - WEEK - 1), payload: { type: 'request_approval' } });
  let now = NOW; const m = new CombinedMonitor({ ...f, now: () => now }); m.discover();
  assert.equal(m.snapshot().floors[0].sessions[0].sid, 'parent'); assert.equal(m.snapshot().floors[0].total, 1);
  now += WEEK + 1; assert.deepEqual(m.snapshot().floors, []);
});
test('expired child workers are hidden even when their parent still has recent activity', t => {
  const f = fixtures(t); f.codex('parent', '/app', NOW);
  const child = f.codex('child', '/app', NOW - WEEK - 1, { parent_thread_id: 'parent' });
  append(child, { type: 'event_msg', timestamp: iso(NOW - WEEK - 1), payload: { type: 'task_started', turn_id: 'old-child' } });
  const m = new CombinedMonitor({ ...f, now: () => NOW }); m.discover();
  const s = m.snapshot(); assert.equal(s.floors[0].total, 1); assert.deepEqual(s.floors[0].sessions[0].state.agents, []);
  assert.equal(m.monitors[0].states.has('child'), true);
});
test('expiry clears the selected office, timeline and alerts instead of leaving an old session onscreen', () => {
  const vm = require('node:vm'), html = fs.readFileSync(path.join(__dirname, '..', 'office.html'), 'utf8');
  const source = html.slice(html.indexOf('function onSnap() {'), html.indexOf('// ───────── 그리기 루프'));
  const elements = { '#crew': { innerHTML: 'old card' }, '#alog': { innerHTML: 'old timeline' } };
  let cleared = false, closed = false, rendered = false;
  const ctx = { syncRecordedState() {}, allSessions: () => [], Date, ALL: [], scene: { primary: 'expired' },
    clearScene: () => { cleared = true; }, closePop: () => { closed = true; }, renderDir: () => { rendered = true; },
    floorAlert: new Map([['old', 'ask']]), alertInfo: new Map([['old', {}]]), $: key => elements[key] };
  vm.createContext(ctx); vm.runInContext(source, ctx); ctx.onSnap();
  assert.equal(ctx.scene, null); assert.ok(cleared && closed && rendered); assert.equal(ctx.floorAlert.size, 0);
  assert.doesNotMatch(elements['#alog'].innerHTML, /old timeline/); assert.match(elements['#crew'].innerHTML, /최근 7일/);
});
