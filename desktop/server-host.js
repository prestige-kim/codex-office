#!/usr/bin/env node
'use strict';
// Private child of the native app: no daemon, no shared server, no browser launching.
const { start } = require('../server');
const fs = require('node:fs'), path = require('node:path');
let app, stopping = false, parentTimer;
const parent = process.ppid;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function removeOwnState() {
  if (!process.env.OFFICE_DATA_DIR) return;
  const file = path.join(process.env.OFFICE_DATA_DIR, 'server-state.json');
  try { const state = JSON.parse(fs.readFileSync(file, 'utf8')); if (state.serverPid === process.pid && state.appPid === parent) fs.unlinkSync(file); } catch {}
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(parentTimer);
  process.stdin.destroy();
  if (!app) return process.exit(0);
  app.server.once('close', () => { removeOwnState(); process.exit(0); });
  app.close();
  app.server.closeAllConnections?.();
  setTimeout(() => { removeOwnState(); process.exit(0); }, 1500).unref();
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  pending += data;
  if (pending.length > 4096) return stop();
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) { try { if (JSON.parse(line).type === 'shutdown') stop(); } catch {} }
});
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop); process.on('SIGINT', stop);
parentTimer = setInterval(() => {
  try { if (process.ppid !== parent) stop(); else process.kill(parent, 0); } catch { stop(); }
}, 1000);
try {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 이상이 필요합니다.');
  app = start({ port: 0, onReady: server => send({ type: 'ready', pid: process.pid, url: `http://127.0.0.1:${server.address().port}/` }) });
  app.server.on('error', error => { send({ type: 'fatal', message: error.message }); stop(); });
} catch (error) { send({ type: 'fatal', message: error.message }); stop(); }
