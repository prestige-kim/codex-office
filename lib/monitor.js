'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createState, reduce, publicState, terminal, working } = require('./codex');
const MAX_LINE = 16 * 1024 * 1024;
class JsonlReader {
  constructor(file, onRecord) { this.file = file; this.onRecord = onRecord; this.offset = 0; this.pending = Buffer.alloc(0); this.discard = false; this.errors = 0; this.identity = ''; this.checkpoint = Buffer.alloc(0); }
  read() {
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
      let changed = false;
      if (this.checkpoint.length && stat.size >= this.offset) {
        const previous = Buffer.alloc(this.checkpoint.length);
        fs.readSync(fd, previous, 0, previous.length, this.offset - previous.length);
        changed = !previous.equals(this.checkpoint);
      }
      const reset = !!this.identity && (identity !== this.identity || stat.size < this.offset || changed);
      if (reset) { this.offset = 0; this.pending = Buffer.alloc(0); this.discard = false; }
      this.identity = identity;
      const end = stat.size, chunk = Buffer.alloc(64 * 1024);
      while (this.offset < end) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - this.offset), this.offset); if (!n) break;
        this.offset += n;
        let data = Buffer.concat([this.pending, chunk.subarray(0, n)]), pos = 0, nl;
        this.pending = Buffer.alloc(0);
        while ((nl = data.indexOf(10, pos)) >= 0) {
          const line = data.subarray(pos, nl); pos = nl + 1;
          if (this.discard) { this.discard = false; continue; }
          if (line.length > MAX_LINE) { this.errors++; continue; }
          if (!line.length) continue;
          let record; try { record = JSON.parse(line.toString('utf8')); } catch { this.errors++; continue; }
          this.onRecord(record, reset && !this.resetNotified);
          if (reset) this.resetNotified = true;
        }
        if (!this.discard) {
          this.pending = Buffer.from(data.subarray(pos));
          if (this.pending.length > MAX_LINE) { this.errors++; this.pending = Buffer.alloc(0); this.discard = true; }
        }
      }
      this.checkpoint = Buffer.alloc(Math.min(64, this.offset));
      fs.readSync(fd, this.checkpoint, 0, this.checkpoint.length, this.offset - this.checkpoint.length);
      this.resetNotified = false;
      return { reset, mtime: stat.mtimeMs };
    } finally { fs.closeSync(fd); }
  }
}
class Monitor {
  constructor(root, { onEvent = () => {}, now = () => Date.now() } = {}) {
    this.root = path.resolve(root); this.onEvent = onEvent; this.now = now; this.files = new Map(); this.states = new Map(); this.titles = new Map(); this.parents = new Map(); this.errors = 0;
    this.index = new JsonlReader(path.join(path.dirname(this.root), 'session_index.jsonl'), o => { if (o.id && (o.thread_name || o.title)) this.titles.set(o.id, String(o.thread_name || o.title).slice(0, 80)); });
  }
  discover() {
    const found = new Set();
    const walk = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') this.errors++; return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) { found.add(full); if (!this.files.has(full)) this.track(full); }
      }
    };
    walk(this.root, 0);
    for (const [file, F] of this.files) if (!found.has(file)) { this.files.delete(file); if (F.state) this.states.delete(F.state.id); }
    try { this.index.read(); } catch (e) { if (e.code !== 'ENOENT') this.errors++; }
  }
  track(file) {
    const F = { file, state: null, live: false, reader: null };
    F.reader = new JsonlReader(file, (o, reset) => this.record(F, o, reset));
    this.files.set(file, F);
    try { F.reader.read(); } catch (e) { this.errors++; }
    F.live = true;
  }
  record(F, o, reset = false) {
    if (reset) { if (F.state) this.states.delete(F.state.id); F.state = null; }
    // Only session_meta identifies a session. Incomplete first lines are retried naturally.
    if (o.type === 'session_meta' && (o.payload?.id || o.payload?.session_id)) {
      const id = o.payload.id || o.payload.session_id;
      if (!F.state || F.state.id !== id) { F.state = createState(id, o.payload); this.states.set(id, F.state); }
    }
    if (!F.state) return;
    const S = F.state, events = reduce(S, o);
    for (const e of events) if (e.k === 'childLink' && e.id && e.id !== S.id) this.parents.set(e.id, S.id);
    if (!S.parent && this.parents.has(S.id)) S.parent = this.parents.get(S.id);
    if (F.live) for (const e of events) {
      // Newly discovered old logs restore state silently; do not replay hours-old notifications.
      if (this.now() - e.at < 30_000 && e.at <= this.now() + 5_000) this.onEvent(S, e);
    }
  }
  poll() {
    for (const F of this.files.values()) {
      try {
        const st = fs.lstatSync(F.file);
        if (st.isSymbolicLink()) continue;
        const identity = `${st.dev}:${st.ino}`;
        if (identity !== F.reader.identity || st.size < F.reader.offset) {
          if (F.state) this.states.delete(F.state.id);
          F.state = null; F.live = false; F.reader = new JsonlReader(F.file, (o, reset) => this.record(F, o, reset));
        }
        F.reader.read(); F.live = true;
      } catch (e) { if (e.code !== 'ENOENT') this.errors++; }
    }
  }
  snapshot() {
    const now = this.now(), groups = new Map(), children = new Map(); let usage = null;
    for (const S of this.states.values()) {
      if (!S.parent && this.parents.has(S.id)) S.parent = this.parents.get(S.id);
      if (S.usage && (!usage || S.usage.at > usage.at)) usage = S.usage;
      let root = S, seen = new Set([S.id]);
      while (root.parent && this.states.has(root.parent) && !seen.has(root.parent)) { seen.add(root.parent); root = this.states.get(root.parent); }
      if (root !== S) { if (!children.has(root.id)) children.set(root.id, []); children.get(root.id).push(S); }
    }
    const date = new Date(now), day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`, monthPrefix = `${date.getFullYear()}-${date.getMonth() + 1}-`;
    const activity = S => {
      const daily = S.daily.get(day), month = [...S.work].filter(([d]) => d.startsWith(monthPrefix)).reduce((n, [, bins]) => n + bins.size * 5, 0);
      return { work: [...(S.work.get(day) || [])].sort((a, b) => a - b), month, day: { k: date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate(), tools: daily?.tools || {}, files: [...(daily?.files || [])], prompts: daily?.prompts || [], errors: daily?.errors || 0 } };
    };
    for (const S of this.states.values()) {
      if (S.parent && this.states.has(S.parent)) continue;
      const kids = children.get(S.id) || [], state = publicState(S, now), agents = [];
      for (const C of kids) {
        const c = publicState(C, now);
        if (terminal.has(C.status) || C.status === 'unknown') continue;
        agents.push({ id: C.id, type: C.agentType, desc: C.agentType === 'Guardian' ? '작업 검토' : 'Codex 도우미', room: c.room, tool: c.tool, detail: c.detail, tools: C.tools, since: C.started, status: c.status, statusLabel: c.statusLabel });
      }
      state.agents = agents;
      const mtime = Math.max(S.mtime, ...kids.map(c => c.mtime)), active = (working.has(S.status) && state.status !== 'stale') || agents.some(c => working.has(c.status));
      const proj = String(S.cwd || `session:${S.id}`).replace(/\\/g, '/').replace(/\/$/, '');
      if (!groups.has(proj)) groups.set(proj, []);
      groups.get(proj).push({ key: `codex/${S.id}`, sid: S.id, agent: 'codex', cwd: S.cwd, label: this.titles.get(S.id) || S.firstPrompt || 'Codex 세션', started: S.started, mtime,
        tools: S.tools, waiting: /^waiting_/.test(S.status) ? S.waiting : 0, status: state.status, statusLabel: state.statusLabel, active, state, ...activity(S) });
    }
    const floors = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([proj, sessions], i) => {
      sessions.sort((a, b) => b.mtime - a.mtime);
      return { n: i + 1, proj, name: path.posix.basename(proj) || proj, mtime: sessions[0].mtime, active: sessions.some(s => s.active), total: sessions.length, sessions };
    });
    // Usage is an observed snapshot. Expiry is never presented as a confirmed zero.
    if (usage) usage = { ...usage, stale: now - usage.at > 15 * 60_000, expired: [usage.primary, usage.secondary].some(w => w?.resets_at && w.resets_at * 1000 < now) };
    return { floors, usage: { codex: usage }, diagnostics: { sourceExists: fs.existsSync(this.root), files: this.files.size, sessions: this.states.size, malformedLines: [...this.files.values()].reduce((n, f) => n + f.reader.errors, 0), readErrors: this.errors, readOnly: true } };
  }
}
module.exports = { Monitor, JsonlReader };
