'use strict';
// Normalize transcript events only. Never read auth/settings, install hooks, or call models.
const path = require('node:path');
const codex = require('./codex');
const clip = (s, n = 90) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const blocks = o => typeof o.message?.content === 'string' ? [{ type: 'text', text: o.message.content }] : Array.isArray(o.message?.content) ? o.message.content : [];
const contentText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text || '').join(' ') : '';
function metadata(file, root, o) {
  const parts = path.relative(root, file).split(path.sep), i = parts.indexOf('subagents');
  const parent = i > 0 ? parts[i - 1] : '';
  const base = path.basename(file, '.jsonl');
  return { id: parent ? `${parent}:sub:${base}` : o.sessionId || base, parent_thread_id: parent, cwd: o.cwd || '', timestamp: o.timestamp, agentType: o.agentType || 'general-purpose' };
}
function createState(id, meta = {}) { const S = codex.createState(id, meta); S.claudeSeen = new Set(); S.agentType = meta.agentType || 'general-purpose'; return S; }
function reduce(S, o) {
  const out = [], timestamp = o.timestamp;
  const apply = (type, payload) => { const es = codex.reduce(S, { type, payload, timestamp }); out.push(...es); return es; };
  const event = (type, extra = {}) => apply('event_msg', { type, ...extra });
  const emit = e => out.push({ ...e, at: Date.parse(timestamp) || Date.now() });
  if (o.cwd) S.cwd = o.cwd;
  if (o.agentType && S.parent) S.agentType = o.agentType;
  if (o.type === 'ai-title' && o.aiTitle) { S.title = clip(o.aiTitle, 80); return out; }
  if (o.type === 'summary' && o.summary) { if (!S.title) S.title = clip(o.summary, 80); return out; }
  // API request blobs, attachments and file snapshots can contain entire contexts or secrets.
  if (!['user', 'assistant', 'system', 'result'].includes(o.type)) return out;
  if (o.isSidechain && !S.parent) return out; // Separate subagent files are linked by their directory.
  if (o.uuid) { if (S.claudeSeen.has(o.uuid)) return out; S.claudeSeen.add(o.uuid); if (S.claudeSeen.size > 2048) S.claudeSeen.delete(S.claudeSeen.values().next().value); }
  if (o.type === 'system') {
    if (o.subtype === 'turn_duration' && !S.pending.size && S.status !== 'completed') event('task_complete');
    else if (['turn_aborted', 'interrupted'].includes(o.subtype)) event('turn_aborted');
    else if (o.subtype === 'permission_request') event('request_approval', { reason: 'Claude Code에서 승인을 확인하세요' });
    else if (o.subtype === 'permission_response') { S.room = 'desk'; S.tool = ''; S.detail = ''; event('approval_resolved'); }
    return out;
  }
  if (o.type === 'result') { if (o.is_error) event('task_failed'); else if (!S.pending.size) event('task_complete'); return out; }
  const cs = blocks(o);
  if (o.type === 'user') {
    for (const c of cs) if (c.type === 'tool_result') {
      const call = S.pending.get(c.tool_use_id), a = S.agents[c.tool_use_id], value = contentText(c.content);
      apply('response_item', { type: 'function_call_output', call_id: c.tool_use_id, output: JSON.stringify(c.is_error ? { is_error: true, error: { message: clip(value) || 'Claude 도구 실패' } } : { ok: true }) });
      if (call?.name === 'AskUserQuestion' && !c.is_error) { S.room = 'desk'; S.tool = ''; S.detail = ''; event('approval_resolved'); }
      if (a) {
        const rich = o.toolUseResult || {}, background = rich.isAsync === true || rich.status === 'async_launched';
        if (background && !c.is_error) { a.externalId = rich.agentId || ''; a.status = 'running'; }
        else { delete S.agents[c.tool_use_id]; emit({ k: 'agentDone', id: c.tool_use_id }); }
      }
    }
    const tx = cs.filter(c => c.type === 'text').map(c => c.text || '').join('\n').trim();
    if (/^\[Request interrupted by user(?: for tool use)?\]/.test(tx)) { event('turn_aborted'); return out; }
    if (tx.includes('<task-notification>')) {
      const id = tx.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
      for (const [key, a] of Object.entries(S.agents)) if (id && a.externalId === id) { delete S.agents[key]; emit({ k: 'agentDone', id: key }); }
      return out;
    }
    if (tx && !o.isMeta && !o.isCompactSummary && !/^(?:<(?:command|local-command|system-reminder|bash-|user-memory)|Caveat:)/.test(tx)) {
      event('task_started', { turn_id: o.uuid || o.promptId || timestamp });
      event('user_message', { message: tx });
    }
    return out;
  }
  for (const c of cs) {
    if (c.type === 'thinking' || c.type === 'redacted_thinking') event('agent_reasoning', { text: '생각 중…' });
    else if (c.type === 'text' && c.text?.trim()) event('agent_message', { message: c.text });
    else if (c.type === 'tool_use') {
      const inp = c.input || {};
      apply('response_item', { type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(inp) });
      if (c.name === 'TodoWrite') { S.board = (inp.todos || []).slice(0, 8).map(x => ({ t: clip(x.content || x.activeForm, 60), s: x.status })); emit({ k: 'board', items: S.board }); }
      if (['Agent', 'Task'].includes(c.name)) {
        const a = { id: c.id, type: inp.subagent_type || 'general-purpose', desc: clip(inp.description || 'Claude 도우미', 50), room: 'lobby', tool: '', detail: '', tools: 0, since: Date.parse(timestamp) || Date.now(), status: 'running', statusLabel: '작업 중' };
        S.agents[c.id] = a; emit({ k: 'spawn', ...a });
      }
    }
  }
  const stop = o.message?.stop_reason;
  if (stop === 'end_turn' && !S.pending.size && S.status !== 'completed') event('task_complete');
  else if (['max_tokens', 'refusal'].includes(stop)) event('task_failed', { reason: stop === 'max_tokens' ? '응답 길이 한도 도달' : '응답 거절' });
  return out;
}
module.exports = { metadata, createState, reduce };
