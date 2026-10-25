'use strict';
const { Monitor } = require('./monitor');
class CombinedMonitor {
  constructor({ codexRoot, claudeRoot, onEvent, now, codexEnabled = true, claudeEnabled = true }) {
    this.monitors = [];
    if (codexEnabled) this.monitors.push(new Monitor(codexRoot, { onEvent, now, agent: 'codex' }));
    if (claudeEnabled) this.monitors.push(new Monitor(claudeRoot, { onEvent, now, agent: 'claude' }));
  }
  discover() { for (const m of this.monitors) m.discover(); }
  poll() { for (const m of this.monitors) m.poll(); }
  snapshot() {
    const groups = new Map(), usage = { codex: null, claude: null }, sources = {}, totals = { files: 0, sessions: 0, malformedLines: 0, readErrors: 0 };
    for (const m of this.monitors) {
      const snap = m.snapshot(); usage[m.agent] = snap.usage[m.agent]; sources[m.agent] = { ...snap.diagnostics, enabled: true };
      for (const k of Object.keys(totals)) totals[k] += snap.diagnostics[k];
      for (const f of snap.floors) {
        if (!groups.has(f.proj)) groups.set(f.proj, { proj: f.proj, name: f.name, sessions: [] });
        groups.get(f.proj).sessions.push(...f.sessions);
      }
    }
    const floors = [...groups.values()].sort((a, b) => a.proj.localeCompare(b.proj)).map((f, i) => {
      f.sessions.sort((a, b) => b.mtime - a.mtime);
      return { ...f, n: i + 1, mtime: f.sessions[0].mtime, total: f.sessions.length, active: f.sessions.some(s => s.active) };
    });
    return { floors, usage, diagnostics: { ...totals, readOnly: true, sourceExists: Object.values(sources).some(s => s.sourceExists), sources } };
  }
}
module.exports = { CombinedMonitor };
