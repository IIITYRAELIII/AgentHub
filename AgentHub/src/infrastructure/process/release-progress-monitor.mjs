import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorIdentity } from '../../../release-progress/identity.mjs';

export const RELEASE_PROGRESS_PORT = 58268;
const pending = new Map();
function failure(code) { return Object.assign(new Error(code), { code }); }

function json(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let text = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) req.destroy(failure('MONITOR_RESPONSE_TOO_LARGE'));
        else text += chunk;
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(failure('MONITOR_PORT_OCCUPIED'));
        try { resolve(JSON.parse(text)); } catch { reject(failure('MONITOR_PORT_OCCUPIED')); }
      });
    });
    const timer = setTimeout(() => req.destroy(failure('MONITOR_PROBE_TIMEOUT')), 2_000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
  });
}

async function inspect(url, identity) {
  let value;
  try { value = await json(`${url}/api/identity`); }
  catch (error) { if (error.code === 'ECONNREFUSED') return null; throw error; }
  if (value?.protocol === identity.protocol && value.binding === identity.binding
      && value.operationId === identity.operationId) return { url, reused: true, pid: value.pid, identityMode: 'bound' };
  // One-time compatibility with the accepted 7ffd standalone process restored
  // before autolaunch existed. Its globally unique original operation must match.
  // Never replace/kill it; this branch disappears once that process exits/reboots.
  if (value === null) {
    const old = await json(`${url}/api/status`);
    if (old?.operationId === identity.operationId && Number.isSafeInteger(old.generation)
        && typeof old.run === 'string' && Array.isArray(old.cases)) {
      return { url, reused: true, identityMode: 'legacy-operation' };
    }
  }
  throw failure('MONITOR_PORT_OCCUPIED');
}

export async function ensureReleaseProgressMonitor({ runtimeRoot, operationId, port = RELEASE_PROGRESS_PORT,
  serverFile = fileURLToPath(new URL('../../../release-progress/server.mjs', import.meta.url)) } = {}) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new TypeError('operationId is required');
  const identity = await monitorIdentity(runtimeRoot, operationId);
  const url = `http://127.0.0.1:${port}`;
  const key = `${url}/${identity.binding}`;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    const existing = await inspect(url, identity);
    if (existing) return existing;
    // No pipes, parent lifetime or Hub close handler owns the viewer process.
    // IPC exists only for the bounded launch handshake, then is disconnected.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
      .filter(name => process.env[name] != null).map(name => [name, process.env[name]]));
    const child = spawn(process.execPath, [serverFile, '--runtime-root', runtimeRoot,
      '--operation', operationId, '--port', String(port)], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
    });
    child.unref();
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        child.removeListener('message', message); child.removeListener('exit', exit);
        if (child.connected) child.disconnect();
        error ? reject(error) : resolve();
      };
      const message = value => {
        if (value?.type === 'ready' || value?.type === 'occupied') finish();
        else if (value?.type === 'failed') finish(failure('MONITOR_START_FAILED'));
      };
      const exit = () => finish(failure('MONITOR_START_FAILED'));
      const timer = setTimeout(() => finish(failure('MONITOR_START_UNKNOWN')), 5_000);
      child.once('error', error => finish(error));
      child.on('message', message); child.once('exit', exit);
    });
    const result = await inspect(url, identity);
    if (!result) throw failure('MONITOR_START_UNKNOWN');
    return { ...result, reused: result.pid !== child.pid };
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}

export function createReleaseProgressObserver({ runtimeRoot, ensure = ensureReleaseProgressMonitor,
  onError = (error) => console.warn('Release progress monitor unavailable:', error.code ?? 'MONITOR_START_FAILED') } = {}) {
  return operationId => {
    // Observation cannot veto an already durable release admission or cause a
    // second publication attempt. Failures are reported independently.
    void Promise.resolve().then(() => ensure({ runtimeRoot, operationId })).catch(onError);
  };
}
