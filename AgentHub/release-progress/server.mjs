import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgressReader } from './reader.mjs';
import { monitorIdentity } from './identity.mjs';

const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
export async function startMonitor({ runtimeRoot, operationId, port = 0, title = 'Выпуск Agent Hub' }) {
  if (!runtimeRoot || typeof operationId !== 'string' || !operationId.trim()) throw new Error('Нужны runtimeRoot и operationId.');
  const reader = new ProgressReader({ runtimeRoot, operationId });
  const identity = await monitorIdentity(runtimeRoot, operationId);
  let pending;
  const snapshot = () => pending ??= reader.snapshot().finally(() => { pending = null; });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const address = `127.0.0.1:${server.address().port}`;
    const crossSiteData = req.headers['sec-fetch-site'] === 'cross-site' && req.url !== '/';
    if (req.headers.host !== address || req.headers.origin && req.headers.origin !== `http://${address}` || crossSiteData) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    const url = new URL(req.url, `http://${address}`);
    try {
      if (url.pathname === '/api/identity') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ...identity, pid: process.pid })); return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (assets[url.pathname]) {
        const [name, mime] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': mime }).end(await readFile(path.join(import.meta.dirname, name))); return;
      }
      if (url.pathname === '/api/status') {
        const value = await snapshot();
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('Неверная позиция результата.');
        const reset = url.searchParams.get('run') !== value.run || after > value.cases.length;
        const { cases, logFile, ...rest } = value;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ...rest, title, reset, cases: cases.slice(reset ? 0 : after), totalCases: cases.length })); return;
      }
      if (url.pathname === '/log.txt') {
        const value = await snapshot();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="release-log.txt"' });
        const stream = createReadStream(value.logFile); stream.on('error', error => res.destroy(error)); res.once('close', () => stream.destroy()); stream.pipe(res); return;
      }
      res.writeHead(404).end();
    } catch (error) { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message, observedAt: new Date().toISOString() })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--runtime-root': 'runtimeRoot', '--operation': 'operationId', '--port': 'port', '--title': 'title' }[process.argv[i]];
    if (!key || process.argv[i + 1] == null || key in options) throw new Error('Неизвестный или повторный аргумент.');
    options[key] = key === 'port' ? Number(process.argv[i + 1]) : process.argv[i + 1];
  }
  try {
    const { url } = await startMonitor(options);
    if (process.connected) process.send({ type: 'ready' });
    console.log(url);
  } catch (error) {
    if (process.connected) {
      process.send({ type: error.code === 'EADDRINUSE' ? 'occupied' : 'failed' }, () => {
        if (process.connected) process.disconnect();
      });
    } else throw error;
  }
}
