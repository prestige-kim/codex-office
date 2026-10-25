#!/usr/bin/env node
'use strict';
// Synthetic Codex records only. Real sessions and settings are never changed.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { start } = require('./server');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-demo-'));
const root = path.join(dir, 'sessions', '2026', '10', '25'); fs.mkdirSync(root, { recursive: true });
const files = { main: path.join(root, 'rollout-demo-main.jsonl'), helper: path.join(root, 'rollout-demo-helper.jsonl'), other: path.join(root, 'rollout-demo-other.jsonl') };
const line = (who, type, payload) => fs.appendFileSync(files[who], JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
const event = (who, type, extra = {}) => line(who, 'event_msg', { type, ...extra });
const item = (type, data) => event('main', 'item_completed', { item: { type, id: `item-${++counter}`, ...data } });
let counter = 0, round = 0, i = 0;
line('main', 'session_meta', { id: 'demo-main', cwd: '/demo/가계부', timestamp: new Date().toISOString() });
line('helper', 'session_meta', { id: 'demo-helper', cwd: '/demo/가계부', parent_thread_id: 'demo-main', source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' });
line('other', 'session_meta', { id: 'demo-other', cwd: '/demo/개인-홈페이지' });
event('other', 'task_started', { turn_id: 'other' }); event('other', 'user_message', { message: '소개 페이지를 정리해줘' }); event('other', 'task_complete');
event('main', 'token_count', { rate_limits: { primary: { used_percent: 24, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 12000 }, secondary: { used_percent: 38, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 300000 } } });
const steps = [
  () => { round++; event('main', 'task_started', { turn_id: `turn-${round}` }); item('UserMessage', { content: [{ text: '가계부 CSV 내보내기 기능을 추가하고 검증해줘' }] }); },
  () => item('Reasoning', { summary_text: ['기존 내보내기 코드를 확인합니다.'] }),
  () => line('main', 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: `read-${round}`, input: 'const r = await tools.exec_command({cmd:"rg export src"}); text(r);' }),
  () => { item('CommandExecution', { command: 'rg export src', exit_code: 0 }); line('main', 'response_item', { type: 'custom_tool_call_output', call_id: `read-${round}`, output: 'Process exited with code 0' }); },
  () => { event('helper', 'task_started', { turn_id: `helper-${round}` }); line('helper', 'response_item', { type: 'function_call', name: 'exec_command', call_id: `h-${round}`, arguments: JSON.stringify({ cmd: 'cat src/export.ts' }) }); },
  () => line('main', 'response_item', { type: 'function_call', name: 'update_plan', call_id: `plan-${round}`, arguments: JSON.stringify({ plan: [{ step: '기존 코드 확인', status: 'completed' }, { step: 'CSV 기능 구현', status: 'in_progress' }, { step: '검증', status: 'pending' }] }) }),
  () => item('FileChange', { changes: { '/demo/가계부/src/export.ts': { type: 'update' } }, status: 'completed' }),
  () => { event('helper', 'task_complete'); item('CommandExecution', { command: 'npm test', exit_code: 1, status: 'failed', aggregated_output: 'CSV 날짜 형식 테스트 실패' }); },
  () => item('FileChange', { changes: { '/demo/가계부/src/export.ts': { type: 'update' } }, status: 'completed' }),
  () => item('CommandExecution', { command: 'npm test', exit_code: 0, status: 'completed' }),
  () => line('main', 'response_item', { type: 'function_call', name: 'request_user_input_async', call_id: `question-${round}`, arguments: JSON.stringify({ questions: [{ title: '파일 이름에 날짜를 넣을까요?' }] }) }),
  () => {},
  () => item('UserMessage', { content: [{ text: '날짜를 넣어줘' }] }),
  () => event('main', 'exec_approval_request', { reason: '데모 승인 이벤트 · 실제 실행은 하지 않습니다' }),
  () => {},
  () => { event('main', 'approval_resolved'); item('AgentMessage', { content: [{ text: 'CSV 내보내기를 구현했고 테스트가 통과했습니다.' }], phase: 'final' }); event('main', 'task_complete'); },
  () => {}, () => {},
  () => { event('main', 'task_started', { turn_id: `cancel-${round}` }); event('main', 'turn_aborted', { reason: '데모 중단 상태' }); },
  () => {}, () => {},
];
steps[i++]();
const timer = setInterval(() => { steps[i++](); if (i >= steps.length) i = 0; }, 2500);
const app = start({ root: path.join(dir, 'sessions'), dataDir: path.join(dir, 'office-data'), port: Number(process.env.PORT || 4778) });
app.server.on('error', e => { console.error(e.message); stop(); });
console.log('데모 모드: 화면의 작업·승인·사용량은 모두 가짜 데이터입니다.');
function stop() { clearInterval(timer); app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
