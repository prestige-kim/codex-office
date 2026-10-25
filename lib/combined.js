'use strict';
const { Monitor } = require('./monitor');
const { usageStatus } = require('./usage');
const DISPLAY_DAYS = 7;
const DISPLAY_WINDOW_MS = DISPLAY_DAYS * 24 * 60 * 60 * 1000;
class CombinedMonitor {
  constructor({ codexRoot, claudeRoot, onEvent, now, codexEnabled = true, claudeEnabled = true }) {
    this.monitors = []; this.now = now || Date.now;
    if (codexEnabled) this.monitors.push(new Monitor(codexRoot, { onEvent, now, agent: 'codex' }));
    if (claudeEnabled) this.monitors.push(new Monitor(claudeRoot, { onEvent, now, agent: 'claude' }));
  }
  discover() { for (const m of this.monitors) m.discover(); }
  poll() { for (const m of this.monitors) m.poll(); }
  snapshot() {
    const now = this.now(), cutoff = now - DISPLAY_WINDOW_MS;
    const recentActivity = at => Number.isFinite(at) && at > 0 && at >= cutoff;
    let hiddenSessions = 0, visibleSessions = 0;
    const groups = new Map(), usage = { codex: null, claude: null }, sources = {}, totals = { files: 0, sessions: 0, malformedLines: 0, readErrors: 0 };
    for (const m of this.monitors) {
      const snap = m.snapshot(); usage[m.agent] = snap.usage[m.agent]; sources[m.agent] = { ...snap.diagnostics, enabled: true };
      for (const k of Object.keys(totals)) totals[k] += snap.diagnostics[k];
      for (const f of snap.floors) {
        // Presentation only: retain parsed history and original files so an old session
        // can immediately reappear when it records new activity. Usage stays independent.
        const recent = f.sessions.filter(s => recentActivity(s.mtime)).map(s => ({ ...s,
          state: s.state ? { ...s.state, agents: (s.state.agents || []).filter(a => recentActivity(a.mtime)) } : s.state
        }));
        hiddenSessions += f.sessions.length - recent.length;
        visibleSessions += recent.length;
        if (!recent.length) continue;
        if (!groups.has(f.proj)) groups.set(f.proj, { proj: f.proj, name: f.name, sessions: [] });
        groups.get(f.proj).sessions.push(...recent);
      }
    }
    const floors = [...groups.values()].sort((a, b) => a.proj.localeCompare(b.proj)).map((f, i) => {
      f.sessions.sort((a, b) => b.mtime - a.mtime);
      return { ...f, n: i + 1, mtime: f.sessions[0].mtime, total: f.sessions.length, active: f.sessions.some(s => s.active) };
    });
    const status = Object.fromEntries(['claude', 'codex'].map(a => [a, usageStatus(a, usage[a], sources[a], now)]));
    return { floors, retention: { days: DISPLAY_DAYS, basis: 'lastActivity', visibleSessions, hiddenSessions }, usage, usageStatus: status, diagnostics: { ...totals, readOnly: true, sourceExists: Object.values(sources).some(s => s.sourceExists), sources } };
  }
}
module.exports = { CombinedMonitor, DISPLAY_WINDOW_MS };
