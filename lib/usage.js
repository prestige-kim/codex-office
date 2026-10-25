'use strict';
// Plan usage limits (5-hour / weekly) are a different value from context %, token counts and cost estimates.
// Only values a tool itself recorded are shown. Nothing here estimates, fetches, or fills in a limit.
const STALE_MS = 15 * 60_000;

// Claude Code transcripts do not record plan limits. The official surfaces are the interactive /usage
// screen and the rate_limits field sent to a user-configured status line command (stdin only).
const support = {
  claude: { limits: 'unsupported', manual: '/usage', note: 'Claude Code 작업 기록에는 사용 한도가 저장되지 않습니다. Claude Code 안에서 /usage로 확인하세요.' },
  codex: { limits: 'transcript', manual: '/status', note: 'Codex 기록의 token_count 이벤트에 남은 마지막 한도 값입니다.' }
};

function windowStatus(w, now) {
  if (!w || !Number.isFinite(w.used)) return null;
  const resetsAt = Number.isFinite(w.resets_at) && w.resets_at > 0 ? w.resets_at * 1000 : 0;
  // After the reset time the recorded percentage no longer describes the current window, and it is not 0% either.
  const reset = resetsAt > 0 && resetsAt <= now;
  return { used: reset ? null : w.used, lastUsed: w.used, resetsAt: resetsAt || null, windowMinutes: Number.isFinite(w.window_minutes) && w.window_minutes > 0 ? w.window_minutes : null, state: reset ? 'reset' : 'recorded' };
}

// records: whether the tool's work history is connected. limits: whether plan limits can be shown at all.
function usageStatus(agent, usage, source, now = Date.now()) {
  const info = support[agent] || { limits: 'unsupported', manual: '', note: '' };
  const records = !source ? 'disabled' : source.sourceExists ? 'connected' : 'missing';
  const base = { agent, records, manual: info.manual, note: info.note, observedAt: null, stale: false, windows: [] };
  if (info.limits === 'unsupported') return { ...base, limits: 'unsupported' };
  const windows = usage ? [usage.primary, usage.secondary].map(w => windowStatus(w, now)).filter(Boolean) : [];
  if (!windows.length) return { ...base, limits: 'none' };
  return { ...base, limits: 'recorded', observedAt: usage.at, stale: now - usage.at > STALE_MS, plan: usage.plan || '', windows };
}

module.exports = { usageStatus, windowStatus, support, STALE_MS };
