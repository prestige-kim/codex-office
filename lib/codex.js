'use strict';
// Only parses data. Never evaluates tool arguments, runs commands, or writes transcripts.
const path = require('node:path');
const clip = (s, n = 90) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const text = x => typeof x === 'string' ? x : Array.isArray(x) ? x.map(v => text(v && (v.text ?? v.content ?? v))).join(' ') : '';
const key = s => String(s || '').replace(/[_./-]/g, '').toLowerCase();
const basename = s => path.posix.basename(String(s || '').replace(/\\/g, '/'));
const parse = s => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const leaf = s => String(s || '').split(/__|\./).pop();
const terminal = new Set(['completed', 'interrupted', 'failed']);
const working = new Set(['running', 'thinking', 'error']);
const labels = { unknown: '상태 기록 없음', running: '작업 중', thinking: '생각 중', waiting_user: '질문 응답 대기', waiting_approval: '실행 승인 대기', completed: '작업 완료', interrupted: '작업 중단', failed: '작업 실패', error: '도구 오류', stale: '기록 갱신 대기' };
function remember(map, id, limit = 512) {
  if (!id) return false;
  if (map.has(id)) return true;
  map.set(id, true);
  if (map.size > limit) map.delete(map.keys().next().value);
  return false;
}
function createState(id, meta = {}) {
  return { id, cwd: meta.cwd || '', parent: parentOf(meta), agentType: /guardian/i.test(JSON.stringify(meta.source || '') + (meta.thread_source || '')) ? 'Guardian' : 'Helper',
    started: Date.parse(meta.timestamp) || 0, mtime: 0, status: 'unknown', statusAt: 0, turn: '', room: 'desk', tool: '', detail: '', mood: '', bubble: null,
    firstPrompt: '', tools: 0, board: [], usage: null, agents: {}, pending: new Map(), seen: new Map(), messages: new Map(), counted: new Map(),
    work: new Map(), daily: new Map(), warnings: 0 };
}
function parentOf(meta) {
  const sub = meta.source && typeof meta.source === 'object' && meta.source.subagent;
  return meta.parent_thread_id || (sub && (sub.parent_thread_id || sub.thread_spawn?.parent_thread_id || sub.other?.parent_thread_id)) || '';
}
function command(cmd) {
  const raw = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
  const clean = raw.replace(/^(?:bash|zsh|sh)\s+-l?c\s+['"]?/, '').trim();
  // Mixed commands are executions unless every segment is a known read-only operation.
  const chunks = clean.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean);
  const read = /^(?:(?:cat|sed|head|tail|nl|less|more|rg|grep|ag|ls|find|fd|tree|wc|stat|file|du|pwd|realpath|jq)\b|git\s+(?:show|log|diff|status|blame|grep|ls-files)\b)/;
  const isRead = chunks.length > 0 && chunks.every(s => read.test(s)) && !/[<>]|\$\(|`/.test(clean) && !/\bsed\s+.*(?:-i|--in-place)\b/.test(clean) && !/\bfind\s+.*(?:-exec|-delete)\b/.test(clean);
  return { tool: isRead ? '읽기·검색' : '명령 실행', room: isRead ? 'library' : 'server', detail: clip(raw, 65) };
}
function classify(name, input, namespace = '') {
  const n = leaf(name), a = parse(input), raw = typeof input === 'string' ? input : JSON.stringify(input || {});
  if (n === 'Bash') return { ...command(a.command), tool: 'Bash' };
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(n)) return { tool: n, room: 'library', detail: clip(a.pattern || a.path || basename(a.file_path || a.notebook_path), 65) };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(n)) return { tool: n, room: 'dev', detail: basename(a.file_path || a.notebook_path) };
  if (['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode', 'Skill'].includes(n)) return { tool: n, room: 'meeting', detail: clip(a.subject || a.skill || '') };
  if (['Agent', 'Task'].includes(n)) return { tool: n, room: 'phone', detail: clip(a.description || a.subagent_type || 'Claude 도우미') };
  if (['exec', 'shell', 'exec_command', 'local_shell', 'shell_command'].includes(n)) {
    if (n === 'exec') {
      const nested = [...raw.matchAll(/\btools\.([\w$]+)\s*\(/g)].map(m => m[1]);
      if (nested.some(t => leaf(t) === 'apply_patch')) return classify('apply_patch', raw);
      const cmds = [...raw.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g)].map(m => {
        if (m[1][0] === '"') { try { return JSON.parse(m[1]); } catch {} }
        return m[1].slice(1, -1);
      });
      if (cmds.length) { const all = cmds.map(command); return all.find(x => x.room !== 'library') || all[0]; }
      const other = nested.filter(t => !['exec_command', 'write_stdin', 'clock__curr_time'].includes(t));
      if (other.length) return classify(other[0], raw);
      return { tool: '도구 실행', room: 'desk', detail: '코드 모드 · 세부 작업 기록 대기' };
    }
    return command(a.cmd || a.command || a.action?.command || raw);
  }
  if (['wait', 'write_stdin', 'sleep'].includes(n)) return null;
  if (n === 'apply_patch') { const f = raw.match(/\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/); return { tool: '파일 수정', room: 'dev', detail: f ? basename(f[1]).replace(/\\n.*$/, '') : '' }; }
  if (['request_user_input', 'request_user_input_async', 'AskUserQuestion'].includes(n)) return { tool: '질문', room: 'boss', detail: clip(a.questions?.[0]?.question || a.questions?.[0]?.title || '사용자 응답을 기다립니다'), status: 'waiting_user' };
  if (['update_plan', 'set_plan'].includes(n)) return { tool: '계획', room: 'meeting', detail: clip(a.explanation || '') };
  if (['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent'].includes(n)) return { tool: '에이전트 협업', room: 'phone', detail: clip(a.task_name || a.target || '') };
  if (['view_image', 'read_file', 'list_dir'].includes(n)) return { tool: '자료 확인', room: 'library', detail: basename(a.path || '') };
  if (n === 'run' || /web|search|fetch|browse|mcp/i.test(name + namespace)) return { tool: '검색·외부 도구', room: 'web', detail: clip(a.search_query?.[0]?.q || a.open?.[0]?.ref_id || a.query || n, 65) };
  return { tool: clip(n, 40) || '도구', room: 'desk', detail: '' };
}
function rateLimits(raw, at) {
  if (!raw || typeof raw !== 'object') return null;
  // Malformed windows are dropped rather than shown as 0%.
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const win = w => w && num(w.used_percent) !== null && w.used_percent >= 0 ? { used: Math.min(100, w.used_percent), resets_at: num(w.resets_at) > 0 ? w.resets_at : 0, window_minutes: num(w.window_minutes) > 0 ? w.window_minutes : null } : null;
  const primary = win(raw.primary), secondary = win(raw.secondary);
  if (!primary && !secondary) return null;
  return { primary, secondary, five_hour: primary, seven_day: secondary, at, plan: raw.plan_type || '' };
}
function reduce(S, o) {
  const out = [], p = o?.payload || {}, at = Date.parse(o?.timestamp) || Date.now();
  const emit = e => { out.push({ ...e, at }); };
  const set = (status, detail = '') => { S.status = status; S.statusAt = at; S.waiting = /^waiting_/.test(status) ? at : 0; emit({ k: 'status', status, text: detail || labels[status] }); };
  const activity = () => {
    S.mtime = Math.max(S.mtime, at);
    if (!S.started) S.started = at;
    const d = new Date(at), day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!S.work.has(day)) S.work.set(day, new Set());
    S.work.get(day).add(Math.floor((d.getHours() * 60 + d.getMinutes()) / 5));
    return day;
  };
  const day = () => { const k = activity(); if (!S.daily.has(k)) S.daily.set(k, { tools: {}, files: new Set(), prompts: [], errors: 0 }); return S.daily.get(k); };
  const message = (role, tx, id) => {
    tx = text(tx).trim(); if (!tx) return;
    // Setup/context blocks are not user instructions shown in the office.
    if (role === 'user' && /^(?:# AGENTS\.md|<(?:environment_context|INSTRUCTIONS|external_|system|permissions|turn_aborted|user_instructions))/i.test(tx)) return;
    const sig = `${S.turn}:${role}:${tx}`;
    if (remember(S.messages, sig, 128)) return;
    activity();
    if (role === 'user') { if (!S.firstPrompt) S.firstPrompt = clip(tx, 50); S.pending.clear(); set('running'); S.room = 'desk'; S.tool = ''; S.detail = ''; S.mood = ''; const d = day(); d.prompts.push(clip(tx, 70)); if (d.prompts.length > 20) d.prompts.shift(); }
    if (role === 'assistant') { S.mood = ''; if (working.has(S.status)) set('running'); }
    S.bubble = { k: role === 'user' ? 'user' : 'say', text: clip(tx) };
    emit({ k: role === 'user' ? 'user' : 'say', text: clip(tx) });
  };
  const fail = tx => { activity(); set('error'); S.mood = 'sweat'; S.bubble = { k: 'error', text: clip(tx || '도구 실패') }; day().errors++; emit({ k: 'error', text: S.bubble.text }); };
  const tool = (a, id, count = true) => {
    if (!a) return;
    activity(); set(a.status || 'running'); S.room = a.room; S.tool = a.tool; S.detail = a.detail; S.mood = 'work'; S.bubble = null;
    const fresh = count && !remember(S.counted, id);
    if (fresh) { S.tools++; const d = day(); d.tools[a.room] = (d.tools[a.room] || 0) + 1; if (a.room === 'dev' && a.detail) d.files.add(a.detail); }
    emit({ k: 'tool', tool: a.tool, room: a.room, detail: a.detail, count: fresh });
  };
  if (!o || typeof o !== 'object') return out;
  if (o.type === 'session_meta') { S.cwd = p.cwd || S.cwd; S.parent = parentOf(p) || S.parent; return out; }
  if (o.type === 'turn_context') { S.cwd = p.cwd || S.cwd; if (p.turn_id) S.turn = p.turn_id; return out; }
  if (o.type === 'event_msg' && p.type === 'token_count') { const r = rateLimits(p.rate_limits, at); if (r && (!S.usage || at >= S.usage.at)) S.usage = r; return out; }
  if (o.type === 'event_msg') {
    if (p.type === 'task_started') { S.turn = p.turn_id || `${at}`; S.pending.clear(); S.seen.clear(); activity(); set('running'); return out; }
    if (['task_complete', 'turn_aborted', 'task_failed', 'turn_failed'].includes(p.type)) {
      activity(); S.pending.clear(); set(p.type === 'task_complete' ? 'completed' : p.type === 'turn_aborted' ? 'interrupted' : 'failed', clip(p.reason || p.error?.message)); S.room = 'desk'; S.tool = ''; S.detail = ''; S.mood = ''; return out;
    }
    if (p.type === 'user_message') { message('user', p.message, p.id); return out; }
    if (p.type === 'agent_message') { message('assistant', p.message, p.id); return out; }
    if (p.type === 'agent_reasoning') { activity(); set('thinking'); S.mood = 'think'; S.bubble = { k: 'think', text: clip(p.text || '생각 중…') }; emit({ k: 'think', text: S.bubble.text }); return out; }
    if (['exec_approval_request', 'apply_patch_approval_request', 'request_approval'].includes(p.type)) { activity(); S.room = 'boss'; S.tool = '승인 요청'; S.detail = clip(p.reason || p.command || 'Codex에서 승인을 확인하세요'); set('waiting_approval', S.detail); return out; }
    if (['exec_approval_response', 'apply_patch_approval_response', 'approval_resolved'].includes(p.type)) { activity(); set('running'); return out; }
  }
  if (o.type === 'response_item') {
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      const id = p.call_id || p.id;
      if (remember(S.seen, `call:${id || at + p.name}`)) return out;
      const a = classify(p.name, p.input ?? p.arguments, p.namespace);
      S.pending.set(id, { a, name: p.name });
      // Requesting elevated permissions is not evidence that an approval is blocking.
      tool(a, id || `${at}:${p.name}`);
      if (leaf(p.name) === 'update_plan') { const args = parse(p.arguments ?? p.input); S.board = (args.plan || []).slice(0, 8).map(x => ({ t: clip(x.step, 60), s: x.status })); emit({ k: 'board', items: S.board }); }
      return out;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const call = S.pending.get(p.call_id); S.pending.delete(p.call_id);
      const output = parse(p.output), str = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
      const exit = output.exit_code ?? output.exitCode ?? (str.match(/(?:Process exited with code|exit_code["']?\s*:)\s*(-?\d+)/i) || [])[1];
      if (output.isError || output.is_error || output.error || (exit != null && Number(exit) !== 0)) { if (!call?.failed) fail(output.error?.message || output.output || `명령 종료 코드 ${exit ?? '오류'}`); }
      // A successful output alone does not imply a completed turn or answered async question.
      else if (call && working.has(S.status)) { activity(); if (S.status === 'error') set('running'); }
      return out;
    }
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) { message(p.role, p.content, p.id); return out; }
    if (p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) { activity(); set('thinking'); S.mood = 'think'; S.bubble = { k: 'think', text: clip(text(p.summary)) || '생각 중…' }; emit({ k: 'think', text: S.bubble.text }); return out; }
    // encrypted_content / raw_content and unknown payloads are intentionally ignored.
  }
  if (o.type === 'event_msg' && ['item_started', 'item_completed'].includes(p.type) && p.item) {
    const it = p.item, type = key(it.type), complete = p.type === 'item_completed', id = it.id || `${at}:${type}`;
    if (remember(S.seen, `${p.type}:${id}`)) return out;
    if (type === 'usermessage') { if (complete) message('user', it.content, id); return out; }
    if (type === 'agentmessage') { if (complete) message('assistant', it.content, id); return out; }
    if (type === 'reasoning') { activity(); set('thinking'); S.mood = 'think'; S.bubble = { k: 'think', text: clip(text(it.summary_text)) || '생각 중…' }; emit({ k: 'think', text: S.bubble.text }); return out; }
    if (type === 'subagentactivity') { emit({ k: 'childLink', id: it.agent_thread_id, kind: it.kind }); return out; }
    if (type === 'contextcompaction') { activity(); set('running'); S.room = 'meeting'; emit({ k: 'say', text: '대화 기록을 정리하는 중' }); return out; }
    let a;
    if (type === 'commandexecution') {
      a = command(it.command || it.parsed_cmd?.map(x => x.cmd || x.path || '').join(' '));
      if ((it.parsed_cmd || []).length && it.parsed_cmd.every(x => /^(read|list|search)$/.test(x.type)) && a.room === 'library') a.tool = '읽기·검색';
    } else if (type === 'filechange') { const files = Array.isArray(it.changes) ? it.changes.map(x => x.path) : Object.keys(it.changes || {}); a = { tool: '파일 수정', room: 'dev', detail: files.map(basename).filter(Boolean).slice(0, 3).join(', ') }; if (complete) files.forEach(f => day().files.add(basename(f))); }
    else if (['mcptoolcall', 'websearch', 'extension'].includes(type)) a = { tool: type === 'mcptoolcall' ? clip(`${it.server}.${it.tool}`, 50) : '웹 검색', room: 'web', detail: clip(it.query || it.kind || '') };
    else if (type === 'imageview') a = { tool: '이미지 확인', room: 'library', detail: basename(it.path) };
    if (a) {
      const waiting = /waiting.*approval|pending.*approval/i.test(it.status || '');
      const wasCall = S.pending.has(it.call_id || it.id);
      // Completed tool items often follow a code-mode wrapper. Reposition without double counting that wrapper.
      const paired = wasCall || (complete && [...S.pending.values()].some(c => ['exec', 'exec_command', 'shell', 'local_shell', 'shell_command'].includes(leaf(c.name))));
      tool(a, it.call_id || id, !paired);
      if (waiting) { S.room = 'boss'; set('waiting_approval'); }
      if (complete && (it.exit_code != null && it.exit_code !== 0 || /^(failed|declined)$/i.test(it.status || '') || it.result?.isError || it.result?.is_error)) {
        fail(it.stderr || it.aggregated_output || '도구 실행 실패');
        const pending = S.pending.get(it.call_id || it.id) || [...S.pending.values()].find(c => leaf(c.name) === 'exec');
        if (pending) pending.failed = true;
      }
    }
  }
  return out;
}
function publicState(S, now = Date.now()) {
  const stale = working.has(S.status) && now - S.mtime > 90_000;
  return { status: stale ? 'stale' : S.status, lastStatus: S.status, statusLabel: labels[stale ? 'stale' : S.status], statusAt: S.statusAt,
    room: /^waiting_/.test(S.status) ? 'boss' : stale ? 'desk' : S.room, tool: S.tool, detail: S.detail, mood: stale || terminal.has(S.status) ? '' : S.mood,
    bubble: S.bubble, board: S.board, agents: Object.values(S.agents), idle: terminal.has(S.status) || stale || S.status === 'unknown' };
}
module.exports = { createState, reduce, publicState, classify, command, parentOf, labels, rateLimits, terminal, working };
