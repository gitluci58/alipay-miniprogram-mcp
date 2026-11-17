import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { buildTools } from '../src/tools.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipay-mcp-qr-test-'));
const png = await QRCode.toBuffer('alipays://platformapi/startapp?appId=example', { width: 420, margin: 2 });
const server = http.createServer((req, res) => {
  if (req.url === '/failed') return res.writeHead(503).end();
  if (req.url === '/invalid') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('not a PNG');
  res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let qrUrl = `${base}/preview`;
let stopped = 0;
let stopFails = false;
const active = new Map();
const worker = {
  onEvent() {},
  async call(op) {
    if (op === 'preview.run') return { qrcodeUrl: qrUrl, version: 'test' };
    if (op === 'remoteDebug.start') return { qrcodeUrl: qrUrl, debugUrl: 'local-debug', version: 'test' };
    if (op === 'remoteDebug.stop') { stopped++; if (stopFails) throw new Error('stop failed'); return { stopped: true }; }
    if (op === 'auth.login.start') return { qrCodeUrl: 'alipays://login-test', status: 'waiting' };
    throw new Error(`Unexpected operation: ${op}`);
  },
};
const sessions = {
  create() { active.set('test-session', {}); return 'test-session'; },
  set(id, value) { active.set(id, value); },
  delete(id) { active.delete(id); },
};
const tools = buildTools({ worker, sessions, logStore: {}, resolveProject: () => dataDir, dataDir, notify() {} });
const call = async (name, args = {}) => {
  const result = await tools.find((tool) => tool.name === name).handler(args);
  return { ...JSON.parse(result.content[0].text), isError: result.isError };
};

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  const resolved = fs.realpathSync(dataDir);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('alipay-mcp-qr-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('preview and batch preview return the image bytes from the SDK URL', async () => {
  const preview = await call('mp_preview', { project: dataDir, appId: 'test' });
  assert.equal(preview.ok, true);
  assert.ok(fs.readFileSync(preview.qrImageFile).equals(png), 'preview image bytes differ');
  const batch = await call('mp_test_run', { project: dataDir, appId: 'test', pages: ['pages/index/index'], caseLimit: 1, skipBuild: true });
  assert.equal(batch.cases[0].ok, true);
  assert.ok(fs.readFileSync(batch.cases[0].qrImageFile).equals(png), 'batch image bytes differ');
});

test('remote debug returns the SDK image and login still encodes its scan URL', async () => {
  const debug = await call('mp_remote_debug', { project: dataDir, appId: 'test' });
  assert.equal(debug.ok, true);
  assert.ok(fs.readFileSync(debug.qrImageFile).equals(png), 'debug image bytes differ');
  const login = await call('mp_login');
  assert.equal(login.ok, true);
  assert.ok(fs.readFileSync(login.qrImageFile).equals(await QRCode.toBuffer('alipays://login-test', { width: 420, margin: 2 })), 'login QR content changed');
});

test('image errors are reported and an already started remote debug session is stopped', async () => {
  qrUrl = `${base}/failed`;
  const failed = await call('mp_preview', { project: dataDir, appId: 'test' });
  assert.equal(failed.isError, true);
  assert.match(failed.error, /503/);
  const batch = await call('mp_test_run', { project: dataDir, appId: 'test', pages: ['pages/index/index'], caseLimit: 1, skipBuild: true });
  assert.equal(batch.cases[0].ok, false);
  assert.match(batch.cases[0].error, /503/);
  qrUrl = `${base}/invalid`;
  const invalid = await call('mp_preview', { project: dataDir, appId: 'test' });
  assert.equal(invalid.isError, true);
  const debug = await call('mp_remote_debug', { project: dataDir, appId: 'test' });
  assert.equal(debug.isError, true);
  assert.equal(stopped, 1);
  assert.equal(active.has('test-session'), false);
  stopFails = true;
  const stopFailed = await call('mp_remote_debug', { project: dataDir, appId: 'test' });
  assert.equal(stopFailed.isError, true);
  assert.equal(stopFailed.sessionId, 'test-session');
  assert.equal(active.has('test-session'), true);
});
