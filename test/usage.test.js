'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { rateLimits } = require('../lib/codex');
const { usageStatus, STALE_MS } = require('../lib/usage');
const { CombinedMonitor } = require('../lib/combined');

const NOW = Date.parse('2026-10-25T12:00:00Z'), sec = ms => Math.floor(ms / 1000);
const connected = { sourceExists: true };
const limits = (at, primary, secondary) => rateLimits({ primary, secondary, plan_type: 'pro' }, at);

test('recorded Codex limits keep percentage, window, reset time and observation time separate', () => {
  const u = limits(NOW - 60_000, { used_percent: 42.4, window_minutes: 300, resets_at: sec(NOW + 3_600_000) }, { used_percent: 10, window_minutes: 10080, resets_at: sec(NOW + 86_400_000) });
  const s = usageStatus('codex', u, connected, NOW);
  assert.equal(s.records, 'connected'); assert.equal(s.limits, 'recorded'); assert.equal(s.stale, false); assert.equal(s.observedAt, NOW - 60_000);
  assert.deepEqual(s.windows.map(w => [w.used, w.windowMinutes, w.state]), [[42.4, 300, 'recorded'], [10, 10080, 'recorded']]);
  assert.equal(s.windows[0].resetsAt, sec(NOW + 3_600_000) * 1000);
});

test('missing Codex limits are reported as absent, never as 0%', () => {
  for (const u of [null, rateLimits(undefined, NOW), rateLimits({}, NOW)]) {
    const s = usageStatus('codex', u, connected, NOW);
    assert.equal(s.limits, 'none'); assert.deepEqual(s.windows, []);
  }
  const partial = usageStatus('codex', limits(NOW, { used_percent: 5, window_minutes: 300 }, null), connected, NOW);
  assert.equal(partial.windows.length, 1); assert.equal(partial.windows[0].resetsAt, null);
});

test('old observations are marked stale but keep their last recorded value', () => {
  const s = usageStatus('codex', limits(NOW - STALE_MS - 1, { used_percent: 70, resets_at: sec(NOW + 600_000) }), connected, NOW);
  assert.equal(s.stale, true); assert.equal(s.windows[0].used, 70);
  assert.equal(usageStatus('codex', limits(NOW - STALE_MS + 1_000, { used_percent: 70 }), connected, NOW).stale, false);
});

test('malformed limit values are dropped instead of displayed', () => {
  for (const bad of [{ used_percent: 'NaN' }, { used_percent: '50' }, { used_percent: NaN }, { used_percent: -3 }, { used_percent: Infinity }, { used: 20 }, 'x', 7])
    assert.equal(limits(NOW, bad), null);
  const odd = limits(NOW, { used_percent: 150, resets_at: 'tomorrow', window_minutes: -5 });
  assert.equal(odd.primary.used, 100); assert.equal(odd.primary.resets_at, 0); assert.equal(odd.primary.window_minutes, null);
});

test('a passed reset time hides the old percentage without claiming 0%', () => {
  const u = limits(NOW - 3_600_000, { used_percent: 95, window_minutes: 300, resets_at: sec(NOW - 1_000) }, { used_percent: 30, window_minutes: 10080, resets_at: sec(NOW + 86_400_000) });
  const [five, week] = usageStatus('codex', u, connected, NOW).windows;
  assert.equal(five.state, 'reset'); assert.equal(five.used, null); assert.equal(five.lastUsed, 95);
  assert.equal(week.state, 'recorded'); assert.equal(week.used, 30);
});

test('Claude limits are unsupported regardless of record connection, and record status is reported separately', () => {
  assert.deepEqual([connected, { sourceExists: false }, undefined].map(src => usageStatus('claude', null, src, NOW)).map(s => [s.records, s.limits, s.manual, s.windows.length]),
    [['connected', 'unsupported', '/usage', 0], ['missing', 'unsupported', '/usage', 0], ['disabled', 'unsupported', '/usage', 0]]);
  assert.equal(usageStatus('codex', null, undefined, NOW).records, 'disabled');
});

test('combined snapshot never derives Claude limits from transcripts, even with token or rate fields present', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-office-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexRoot = path.join(dir, 'codex'), claudeRoot = path.join(dir, 'claude'); fs.mkdirSync(codexRoot); fs.mkdirSync(path.join(claudeRoot, 'p'), { recursive: true });
  const at = new Date(NOW - 30_000).toISOString();
  fs.writeFileSync(path.join(claudeRoot, 'p', 's.jsonl'), [
    { type: 'user', uuid: 'u', sessionId: 's', cwd: '/w', timestamp: at, message: { role: 'user', content: '테스트 작업' } },
    { type: 'assistant', uuid: 'a', sessionId: 's', cwd: '/w', timestamp: at, rate_limits: { five_hour: { used_percentage: 50 } }, message: { role: 'assistant', content: [{ type: 'text', text: '완료' }], usage: { input_tokens: 9000, output_tokens: 100 }, stop_reason: 'end_turn' } }
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(codexRoot, 'c.jsonl'), [{ type: 'session_meta', payload: { id: 'c', cwd: '/w' } }, { type: 'event_msg', timestamp: at, payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: sec(NOW + 600_000) } } } }].map(JSON.stringify).join('\n') + '\n');
  const m = new CombinedMonitor({ codexRoot, claudeRoot, now: () => NOW }); m.discover(); m.poll(); const snap = m.snapshot();
  assert.equal(snap.usage.claude, null);
  assert.equal(snap.usageStatus.claude.records, 'connected'); assert.equal(snap.usageStatus.claude.limits, 'unsupported');
  assert.equal(snap.usageStatus.codex.limits, 'recorded'); assert.equal(snap.usageStatus.codex.windows[0].used, 12);
  const off = new CombinedMonitor({ codexRoot, claudeRoot, claudeEnabled: false, now: () => NOW }); off.discover();
  assert.equal(off.snapshot().usageStatus.claude.records, 'disabled');
});

test('office header labels record connection and limit availability separately', () => {
  const vm = require('node:vm'), html = fs.readFileSync(path.join(__dirname, '..', 'office.html'), 'utf8');
  const src = html.slice(html.indexOf('function renderUsage('), html.indexOf('// ───────── 날씨'));
  const el = { innerHTML: '', title: '' }, ctx = { $: () => el, Date }; vm.createContext(ctx); vm.runInContext(src, ctx);
  const now = Date.now(), recorded = (at, w) => usageStatus('codex', rateLimits({ primary: w }, at), connected, now);
  ctx.renderUsage({ claude: usageStatus('claude', null, connected, now), codex: usageStatus('codex', null, connected, now) });
  assert.match(el.innerHTML, /기록 연결됨 · 한도는 \/usage에서 확인/); assert.match(el.innerHTML, /한도 기록 아직 없음/); assert.doesNotMatch(el.innerHTML, /0%|사용 한도 기록 없음/);
  ctx.renderUsage({ claude: usageStatus('claude', null, { sourceExists: false }, now), codex: recorded(now, { used_percent: 33, window_minutes: 300, resets_at: sec(now + 600_000) }) });
  assert.match(el.innerHTML, /기록 폴더 없음/); assert.match(el.innerHTML, /5시간 33%</);
  ctx.renderUsage({ claude: usageStatus('claude', null, connected, now), codex: recorded(now - STALE_MS - 1, { used_percent: 33, window_minutes: 10080 }) });
  assert.match(el.innerHTML, /주간 33%\*/); assert.match(el.title, /오래된 기록/);
  ctx.renderUsage({ claude: usageStatus('claude', null, connected, now), codex: recorded(now, { used_percent: 90, window_minutes: 300, resets_at: sec(now - 1000) }) });
  assert.match(el.innerHTML, /5시간 초기화됨/); assert.doesNotMatch(el.innerHTML, /90%/);
});
