import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// 不依赖任何真实模型密钥的端到端冒烟测试：
// 启动服务 -> 校验健康检查/配置/静态页 -> 上传分镜 -> FFmpeg 合成 GIF -> 下载 GIF 与 ZIP。
// 任何需要外部生图接口的调用都在这里被刻意跳过，避免 CI 中伪造结果。

const PORT = Number(process.env.SMOKE_PORT || 4310);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'gifmoji-smoke-'));
const serverPath = path.resolve(import.meta.dirname, '..', 'server.js');

const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'test', TOKENHUB_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`服务提前退出：\n${serverLog}`);
    try {
      const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      // 继续等待端口就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：\n${serverLog}`);
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

try {
  await waitForServer();

  await check('健康检查返回 ok 且 FFmpeg 可用', async () => {
    const res = await fetch(`${ORIGIN}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.ffmpeg, true);
    assert.equal(body.managedKey, false);
  });

  await check('配置接口返回四种协议与分镜上限', async () => {
    const body = await (await fetch(`${ORIGIN}/api/config`)).json();
    assert.deepEqual(
      body.protocols.map((item) => item.value),
      ['auto', 'hunyuan', 'openai-images', 'openai-chat']
    );
    assert.equal(body.maxFrames, 8);
    assert.equal(body.managedKey, false);
  });

  await check('首页与静态资源可访问', async () => {
    const page = await fetch(`${ORIGIN}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /gifmoji/i);
    for (const asset of ['/app.js', '/backend.js', '/styles.css']) {
      const res = await fetch(`${ORIGIN}${asset}`);
      assert.equal(res.status, 200, `${asset} 应可访问`);
    }
  });

  await check('跨域预检通过（供 GitHub Pages 等静态站点调用）', async () => {
    const res = await fetch(`${ORIGIN}/api/compose`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://thinkingstill.github.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://thinkingstill.github.io');
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);

    const health = await fetch(`${ORIGIN}/api/health`, {
      headers: { Origin: 'https://thinkingstill.github.io' }
    });
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://thinkingstill.github.io');
  });

  await check('缺少 API Key 时生成接口返回明确错误而不是崩溃', async () => {
    const form = new FormData();
    form.append('prompt', '一只橘猫震惊地张大嘴');
    form.append('frameCount', '4');
    const res = await fetch(`${ORIGIN}/api/generate`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'missing_api_key');
  });

  let sessionId = '';
  let frameIds = [];
  await check('上传四帧分镜', async () => {
    const form = new FormData();
    for (const [index, color] of ['#ff8a4c', '#ffb347', '#7ed992', '#5aa9ff'].entries()) {
      const png = await sharp({
        create: { width: 512, height: 512, channels: 4, background: color }
      }).png().toBuffer();
      form.append('frames', new Blob([png], { type: 'image/png' }), `frame-${index}.png`);
    }
    const res = await fetch(`${ORIGIN}/api/import`, { method: 'POST', body: form });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.session.frames.length, 4);
    for (const frame of body.session.frames) {
      assert.equal(frame.width, 1024);
      assert.equal(frame.height, 1024);
    }
    sessionId = body.session.id;
    frameIds = body.session.frames.map((frame) => frame.id);
  });

  await check('FFmpeg 合成 GIF 并校验尺寸', async () => {
    const res = await fetch(`${ORIGIN}/api/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, order: frameIds, width: 320, fps: 10, holdMs: 180, quality: 'medium', maxMb: 1 })
    });
    assert.equal(res.status, 200, await res.clone().text());
    const { gif } = await res.json();
    assert.equal(gif.width, 320);
    assert.ok(gif.bytes > 0, 'GIF 体积应大于 0');
    assert.ok(gif.pages >= 4, 'GIF 至少包含四帧');
    assert.notEqual(gif.underLimit, false);

    const file = await fetch(`${ORIGIN}${gif.downloadUrl}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/gif');
    const buffer = Buffer.from(await file.arrayBuffer());
    assert.equal(buffer.subarray(0, 6).toString('latin1'), 'GIF89a');
    assert.equal(buffer.length, gif.bytes);
    // GIF 逻辑屏幕描述符中的宽高（小端序）
    // 注意：animated:true 时 sharp 会把各帧纵向堆叠，必须按单帧高度校验
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 320);
    const pages = await sharp(buffer, { animated: true }).metadata();
    assert.ok(pages.pages >= 4, `GIF 帧数应不少于 4，实际 ${pages.pages}`);
  });

  await check('分镜 ZIP 可下载且包含四张 PNG', async () => {
    const res = await fetch(`${ORIGIN}/api/download/${sessionId}/frames.zip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    const names = [];
    for (let i = 0; i < buffer.length - 2; i += 1) {
      const isLocalHeader = buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04;
      if (!isLocalHeader) continue;
      const nameLength = buffer.readUInt16LE(i + 26);
      if (!nameLength || i + 30 + nameLength > buffer.length) continue;
      names.push(buffer.subarray(i + 30, i + 30 + nameLength).toString('utf8'));
    }
    const pngs = new Set(names.filter((name) => name.endsWith('.png')));
    assert.equal(pngs.size, 4, `ZIP 内应包含 4 张分镜，实际 ${pngs.size}：${names.join(' | ')}`);
  });

  await check('静态托管版（docs/）结构与本地版一致', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const docsHtml = await fs.readFile(path.join(root, 'docs', 'index.html'), 'utf8');
    const publicHtml = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
    // Pages 版必须声明静态环境并使用相对路径
    assert.match(docsHtml, /data-env="static"/);
    assert.match(docsHtml, /src="\.\/app\.js"/);
    assert.match(publicHtml, /src="\/app\.js"/);
    assert.doesNotMatch(publicHtml, /data-env="static"/, 'public/ 版由服务端托管，不能声明静态环境');
    // 两边业务逻辑必须同源（只允许路径与标识差异），用脚本同步后逐一比对
    for (const name of ['app.js', 'backend.js', 'giflite.js', 'directgen.js', 'styles.css']) {
      const [docsFile, publicFile] = await Promise.all([
        fs.readFile(path.join(root, 'docs', name), 'utf8'),
        fs.readFile(path.join(root, 'public', name), 'utf8')
      ]);
      assert.equal(docsFile, publicFile, `docs/${name} 与 public/${name} 必须一致，请运行 node scripts/sync-docs.mjs`);
    }
  });

  await check('未知接口返回 JSON 404', async () => {
    const res = await fetch(`${ORIGIN}/api/not-exist`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, '接口不存在。');
  });

  console.log('\n冒烟测试全部通过。');
} finally {
  server.kill('SIGTERM');
  await fs.rm(DATA_DIR, { recursive: true, force: true });
}
