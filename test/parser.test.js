'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createState, reduce, publicState, classify, command, parentOf } = require('../lib/codex');
const { record:r, item, call, output } = require('./helpers');
test('turn completion, cancellation and explicit waits remain distinct across resumes', () => {
  const S = createState('s');
  reduce(S, r('event_msg', { type: 'task_started', turn_id: 't1' }));
  reduce(S, call('exec_command', { cmd: 'npm test', sandbox_permissions: 'require_escalated' }));
  assert.equal(S.status, 'running', 'requesting elevated permissions does not prove an approval wait');
  reduce(S, r('event_msg', { type: 'task_complete' }));
  assert.equal(S.status, 'completed'); assert.equal(S.waiting, 0); assert.equal(S.room, 'desk');
  reduce(S, r('event_msg', { type: 'task_started', turn_id: 't2' }));
  reduce(S, call('request_user_input_async', { questions: [{ title: '색상을 골라 주세요' }] }, 'q'));
  assert.equal(S.status, 'waiting_user');
  reduce(S, output({ pending: true }, 'q')); assert.equal(S.status, 'waiting_user');
  reduce(S, item('UserMessage', { id: 'u', content: [{ text: '파랑' }] })); assert.equal(S.status, 'running');
  reduce(S, r('event_msg', { type: 'exec_approval_request', reason: '배포 확인' })); assert.equal(S.status, 'waiting_approval');
  reduce(S, r('event_msg', { type: 'turn_aborted' })); assert.equal(S.status, 'interrupted'); assert.equal(S.waiting, 0);
});
test('quiet or token-only logs never imply completion, reset zero or fresh activity', () => {
  const S = createState('s'); const at = '2026-10-25T01:00:00Z';
  reduce(S, r('event_msg', { type: 'task_started', turn_id: 't' }, at));
  reduce(S, r('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 72, window_minutes: 180, resets_at: 1 } } }, '2026-10-25T02:00:00Z'));
  const p = publicState(S, Date.parse(at) + 100000);
  assert.equal(p.status, 'stale'); assert.equal(p.lastStatus, 'running'); assert.equal(S.mtime, Date.parse(at));
  assert.equal(S.usage.primary.used, 72); assert.equal(S.usage.primary.window_minutes, 180);
});
test('desktop and CLI messages deduplicate, context blocks stay out of the office', () => {
  const S = createState('s'); reduce(S, r('event_msg', { type: 'task_started', turn_id: 't' }));
  reduce(S, r('response_item', { type: 'message', role: 'user', content: [{ text: '<environment_context>private</environment_context>' }] }));
  assert.equal(S.firstPrompt, '');
  reduce(S, r('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '통계 화면 만들어줘' }] }));
  const duplicate = reduce(S, item('UserMessage', { id: 'u1', content: [{ text: '통계 화면 만들어줘' }] }));
  assert.deepEqual(duplicate, []); assert.equal(S.firstPrompt, '통계 화면 만들어줘');
  reduce(S, r('event_msg', { type: 'task_started', turn_id: 't2' }));
  assert.ok(reduce(S, r('event_msg', { type: 'user_message', message: '통계 화면 만들어줘' })).some(e => e.k === 'user'));
});
test('code mode, namespace, mixed shell commands, unknown tools and literal strings are safely classified', () => {
  assert.equal(classify('exec', 'const r = await tools.exec_command({cmd:"rg test src"}); text(r);').room, 'library');
  assert.equal(classify('exec', 'await tools.apply_patch("*** Begin Patch\\n*** Update File: app.js")').room, 'dev');
  assert.equal(classify('request_user_input_async', { questions: [{ title: '확인' }] }, 'functions').status, 'waiting_user');
  assert.equal(classify('mcp__github__fetch_file', {}).room, 'web');
  assert.equal(classify('brand_new_tool', {}).room, 'desk');
  assert.equal(classify('write_stdin', {}), null);
  for (const cmd of ['cat file && npm test', 'sed -i x file', 'cat x > y', 'cat x | node', 'find . -delete']) assert.equal(command(cmd).room, 'server', cmd);
  assert.equal(command('git diff && rg name src').room, 'library');
});
test('failure then recovery, duplicate items and command strings are handled without crashing', () => {
  const S = createState('s');
  reduce(S, call('exec_command', { cmd: 'npm test' }, 'a'));
  reduce(S, item('CommandExecution', { id: 'a', command: 'npm test', exit_code: 1, status: 'failed', aggregated_output: 'FAIL' }));
  assert.equal(S.status, 'error'); assert.equal(S.tools, 1);
  reduce(S, call('exec_command', { cmd: 'npm test' }, 'b'));
  const completed = item('CommandExecution', { id: 'b', command: 'npm test', exit_code: 0, status: 'completed' });
  reduce(S, completed); reduce(S, completed);
  assert.equal(S.status, 'running'); assert.equal(S.tools, 2);
  reduce(S, output('Process exited with code 2\nFAILED', 'b')); assert.equal(S.status, 'error');
  reduce(S, call('new_tool', {}, 'c')); assert.equal(S.status, 'running');
});
test('file changes, plan boards and nested child metadata retain structured data', () => {
  const S = createState('s');
  reduce(S, call('update_plan', { plan: [{ step: '검증', status: 'in_progress' }] })); assert.equal(S.board[0].t, '검증');
  reduce(S, item('FileChange', { id: 'f', changes: { '/project/한글.js': { type: 'update' } }, status: 'completed' }));
  assert.equal(S.room, 'dev'); assert.equal(S.detail, '한글.js'); assert.equal(S.tools, 2, 'a pending plan does not swallow later tool counts');
  assert.equal(parentOf({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }), 'parent');
  assert.deepEqual(reduce(S, r('world_state', { state: 'private contents' })), []);
});
test('reasoning reload restores the actual public summary and errors are not counted again by wrapper output', () => {
  const S = createState('s');
  reduce(S, item('UserMessage', { id: 'u', content: [{ text: '이 요청을 요약으로 오인하면 안 됩니다' }] }));
  reduce(S, item('Reasoning', { id: 'r', summary_text: ['기존 구조 확인'] })); assert.equal(publicState(S).bubble.text, '기존 구조 확인');
  reduce(S, call('exec_command', { cmd: 'npm test' }, 'a'));
  reduce(S, item('CommandExecution', { id: 'a', command: 'npm test', exit_code: 1, status: 'failed' }));
  const count = [...S.daily.values()][0].errors;
  reduce(S, output('Process exited with code 1', 'a')); assert.equal([...S.daily.values()][0].errors, count);
  reduce(S, output('null', 'unknown')); // Primitive and null tool outputs are valid records.
});
