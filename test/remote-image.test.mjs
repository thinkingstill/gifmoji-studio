// 链接导入图片的端到端测试。
// 为了不依赖外网，这里自己起一个本地图片服务，让被测服务从它那里"下载"图片。
// 覆盖：成功导入、文件+链接混合、非图片、超大、404、非法协议、数量上限、内网拦截。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const APP_PORT = Number(process.env.REMOTE_TEST_PORT || 4321);
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
// 图片服务用随机端口，避免和本机其它进程抢端口导致 EADDRINUSE
let IMG_ORIGIN = '';
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'gifmoji-remote-'));
const serverPath = path.resolve(import.meta.dirname, '..', 'server.js');

// 一张真实可解码的 PNG，用于成功路径
const PNG = await sharp({
  create: { width: 96, height: 96, channels: 3, background: '#7c5cff' }
}).png().toBuffer();

const imageServer = http.createServer((req, res) => {
  if (req.url === '/frame.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
    return;
  }
  if (req.url === '/not-an-image') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>nope</html>');
    return;
  }
  if (req.url === '/huge.png') {
    // 声明的长度就超限，服务端应在读流之前就拦下，不会真的耗尽内存
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(16 * 1024 * 1024) });
    res.end(Buffer.alloc(1024));
    return;
  }
  if (req.url === '/redirect.png') {
    res.writeHead(302, { Location: '/frame.png' });
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
IMG_ORIGIN = `http://127.0.0.1:${imageServer.address().port}`;

/**
 * 启动被测服务。
 * allowPrivate=true 时才允许 http 与内网地址 —— 默认配置下这些都是被拒绝的。
 */
function startApp(port, allowPrivate) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: path.join(DATA_DIR, String(port)),
    NODE_ENV: 'test',
    TOKENHUB_API_KEY: '',
    // 本测试会连续发十几个请求，把默认写操作限流放宽，避免 429 干扰断言
    RATE_LIMIT_MAX: '1000'
  };
  if (allowPrivate) env.ALLOW_PRIVATE_MODEL_URL = 'true';
  else delete env.ALLOW_PRIVATE_MODEL_URL;
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', (c) => { child.log += c.toString(); });
  child.stderr.on('data', (c) => { child.log += c.toString(); });
  return child;
}

async function waitReady(child, origin, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：\n${child.log}`);
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return;
    } catch { /* 端口还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`服务未就绪：\n${child.log}`);
}

function check(name, fn) {
  return fn().then(
    () => console.log(`PASS ${name}`),
    (error) => {
      console.error(`FAIL ${name}\n${error?.stack || error}`);
      throw error;
    }
  );
}

const app = startApp(APP_PORT, true);
// 默认配置实例：用于验证内网与明文 HTTP 会被拦下
const strictApp = startApp(APP_PORT + 10, false);
const STRICT_ORIGIN = `http://127.0.0.1:${APP_PORT + 10}`;

async function postJson(origin, endpoint, body) {
  const res = await fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  await waitReady(app, ORIGIN);
  await waitReady(strictApp, STRICT_ORIGIN);

  await check('通过链接导入单张分镜', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/frame.png`] });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.session.frames.length, 1);
    // 入库统一裁成 1024×1024（与文件上传同一套处理），证明远程图片确实被解码并落盘
    assert.equal(data.session.frames[0].width, 1024);
    assert.equal(data.session.frames[0].height, 1024);
  });

  await check('链接可按换行与逗号批量导入', async () => {
    const text = [`${IMG_ORIGIN}/frame.png`, `${IMG_ORIGIN}/frame.png`].join('\n');
    // 换行分隔走表单字段路径，等价于前端 textarea 的输入
    const body = new URLSearchParams({ urls: text });
    const res = await fetch(`${ORIGIN}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.session.frames.length, 2);
  });

  await check('链接返回非图片时给出明确错误', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/not-an-image`] });
    assert.equal(status, 400);
    assert.match(data.error, /不是图片/);
  });

  await check('图片超过 15 MB 时拒绝，且不会读完整流', async () => {
    const started = Date.now();
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/huge.png`] });
    assert.equal(status, 400);
    assert.match(data.error, /15 MB/);
    assert.ok(Date.now() - started < 5000, '应在读取前快速拒绝');
  });

  await check('链接 404 时提示可直接打开的地址', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/missing.png`] });
    assert.equal(status, 400);
    assert.match(data.error, /404/);
  });

  await check('不跟随重定向，避免 302 跳内网绕过校验', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/redirect.png`] });
    assert.equal(status, 400);
    assert.match(data.error, /无法访问/);
  });

  await check('非法协议（file://）被拒绝', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: ['file:///etc/passwd'] });
    assert.equal(status, 400);
    assert.match(data.error, /必须|格式/);
  });

  await check('一次超过 8 个链接被拒绝', async () => {
    const urls = Array.from({ length: 9 }, () => `${IMG_ORIGIN}/frame.png`);
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls });
    assert.equal(status, 400);
    assert.match(data.error, /最多保留 8 帧|8 个/);
  });

  await check('既没有文件也没有链接时给出提示', async () => {
    const { status, data } = await postJson(ORIGIN, '/api/import', { urls: [] });
    assert.equal(status, 400);
    assert.match(data.error, /至少一个图片链接|请选择图片/);
  });

  await check('分镜上限会连同已有帧一起计算', async () => {
    // 先塞满 8 帧，再追加链接，应被挡住
    const first = await postJson(ORIGIN, '/api/import', {
      urls: Array.from({ length: 8 }, () => `${IMG_ORIGIN}/frame.png`)
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const sessionId = first.data.session.id;
    const extra = await postJson(ORIGIN, '/api/import', { sessionId, urls: [`${IMG_ORIGIN}/frame.png`] });
    assert.equal(extra.status, 400);
    assert.match(extra.data.error, /最多保留 8 帧/);
  });

  await check('默认配置下拒绝明文 HTTP 链接', async () => {
    const { status, data } = await postJson(STRICT_ORIGIN, '/api/import', { urls: [`${IMG_ORIGIN}/frame.png`] });
    assert.equal(status, 400);
    assert.match(data.error, /HTTPS/);
  });

  await check('默认配置下拒绝指向本机的链接', async () => {
    const { status, data } = await postJson(STRICT_ORIGIN, '/api/import', { urls: ['https://127.0.0.1/frame.png'] });
    assert.equal(status, 400);
    assert.match(data.error, /本机|内网|保留地址/);
  });

  await check('参考图链接在调用模型之前就被校验', async () => {
    // 带上假密钥，让请求越过 API Key 检查，真正走到参考图解析这一步；
    // 参考图解析排在接口地址校验之前，所以坏链接会先暴露出来
    const res = await fetch(`${ORIGIN}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '测试参考图链接',
        model: 'test-model',
        apiKey: 'test-key-not-real',
        baseUrl: 'https://example.com/v1/images/generations',
        referenceUrl: `${IMG_ORIGIN}/not-an-image`
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.match(data.error, /不是图片/, `实际错误：${data.error}`);
  });

  await check('参考图链接可用时能顺利进入任务创建', async () => {
    const res = await fetch(`${ORIGIN}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '测试参考图链接可用路径',
        model: 'test-model',
        apiKey: 'test-key-not-real',
        // 带参考图时接口会被改写为图生图路径，这里只关心是否越过参考图解析
        baseUrl: 'https://example.com/v1/images/generations',
        referenceUrl: `${IMG_ORIGIN}/frame.png`
      })
    });
    const data = await res.json();
    // 参考图没问题就会继续走到接口地址校验；example.com 解析正常，
    // 于是任务被创建（202），真正的模型调用在后台异步失败，不影响本次断言
    assert.equal(res.status, 202, `实际：${res.status} ${JSON.stringify(data)}`);
    assert.ok(data.jobId, '应返回 jobId');
  });

  console.log('\n链接导入测试全部通过。');
} finally {
  imageServer.close();
  app.kill('SIGTERM');
  strictApp.kill('SIGTERM');
  await fs.rm(DATA_DIR, { recursive: true, force: true });
}
