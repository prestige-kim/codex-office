#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CombinedMonitor } = require('./lib/combined');
function start(options = {}) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.resolve(options.root || process.env.CODEX_SESSIONS_DIR || path.join(codexHome, 'sessions'));
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeRoot = path.resolve(options.claudeRoot || process.env.CLAUDE_PROJECTS_DIR || path.join(claudeHome, 'projects'));
  const dataDir = path.resolve(options.dataDir || process.env.OFFICE_DATA_DIR || path.join(__dirname, 'data'));
  // Configuration writes must stay outside the Codex home and transcript tree.
  const inside = (a, b) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
  const real = p => { if (fs.existsSync(p)) return fs.realpathSync(p); const parent = path.dirname(p); return parent === p ? p : path.join(real(parent), path.basename(p)); };
  if ([codexHome, root, claudeHome, claudeRoot].some(p => inside(real(p), real(dataDir)))) throw new Error('OFFICE_DATA_DIR must be outside the Codex/Claude homes and transcript directories');
  const confFile = path.join(dataDir, 'office.json'), clients = new Set();
  let config = { building: '코덱스 오피스', user: '대표' };
  try { config = { ...config, ...JSON.parse(fs.readFileSync(confFile, 'utf8')) }; } catch {}
  const ownerName = name => typeof name === 'string' && name.trim() && name.trim() !== '나' ? name.trim() : '대표';
  config.user = ownerName(config.user);
  const broadcast = (event, value) => { const msg = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`; for (const client of clients) if (client.writableLength < 1024 * 1024) client.write(msg); else client.destroy(); };
  const monitor = new CombinedMonitor({ codexRoot: root, claudeRoot, codexEnabled: options.codexEnabled ?? !process.env.NO_CODEX, claudeEnabled: options.claudeEnabled ?? !process.env.NO_CLAUDE, onEvent: (S, e) => {
    if (S.parent) return; // Child animation is synchronized from the authoritative snapshot.
    if (e.k !== 'childLink') broadcast('ev', { session: `${S.provider}/${S.id}`, ...e });
  } });
  const snapshot = () => ({ ...monitor.snapshot(), root: claudeRoot, codex: root, self: __dirname.replace(/\\/g, '/'), ...config,
    setup: { need: false, hasCodex: fs.existsSync(root), hasClaude: fs.existsSync(claudeRoot) } });
  const server = http.createServer((req, res) => {
    const host = req.headers.host || '';
    if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) { res.writeHead(403); return res.end('Localhost only'); }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) { res.writeHead(403); return res.end('Same origin only'); }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'");
    const url = req.url.split('?')[0];
    if (url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: snap\ndata: ${JSON.stringify(snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url === '/snapshot' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(snapshot())); }
    if (url === '/setup' && req.method === 'POST') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
      let body = '', bytes = 0;
      req.on('data', c => { bytes += c.length; if (bytes > 4096) req.destroy(); else body += c; });
      req.on('end', () => {
        let result;
        try {
          const d = JSON.parse(body), clean = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
          const building = clean(d.building), user = clean(d.user);
          if (!building || !user) throw new Error('건물 이름과 대표 이름을 입력해 주세요');
          fs.mkdirSync(dataDir, { recursive: true });
          // Only this application's configuration is written. No Codex settings are touched.
          if (fs.existsSync(confFile) && fs.lstatSync(confFile).isSymbolicLink()) throw new Error('설정 파일 심볼릭 링크는 지원하지 않습니다');
          config = { building, user: ownerName(user) }; const temp = confFile + '.' + process.pid + '.tmp';
          fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, confFile); result = { ok: true };
        } catch (e) { result = { ok: false, msg: e.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); if (result.ok) broadcast('snap', snapshot());
      }); return;
    }
    if ((url === '/' || url === '/index.html') && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'office.html'))); }
    res.writeHead(404); res.end();
  });
  monitor.discover();
  let previous = '';
  const send = () => { const value = snapshot(), json = JSON.stringify(value); if (json !== previous) { previous = json; broadcast('snap', value); } };
  const timers = [setInterval(() => { monitor.poll(); send(); }, 250), setInterval(() => { monitor.discover(); send(); }, 2000), setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000)];
  server.on('close', () => timers.forEach(clearInterval));
  server.listen(options.port ?? Number(process.env.PORT || 4777), '127.0.0.1', () => {
    console.log(`🏢 코덱스 오피스 · Claude + Codex http://localhost:${server.address().port}\nCodex 기록 읽기 전용: ${root}\nClaude 기록 읽기 전용: ${claudeRoot}\n추가 모델 호출 없음 · 종료: Ctrl+C`);
    options.onReady?.(server);
  });
  let closed = false;
  return { server, monitor, snapshot, close: () => {
    if (closed) return;
    closed = true; timers.forEach(clearInterval);
    clients.forEach(c => c.end()); server.close();
  } };
}
if (require.main === module) {
  let app; try { app = start(); } catch (e) { console.error(e.message); process.exitCode = 1; }
  app?.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '포트가 사용 중입니다. PORT=4778 npm start 로 실행하세요.' : e.message); app.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app?.close(); });
}
module.exports = { start };
