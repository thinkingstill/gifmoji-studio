import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { ZipFile } from 'yazl';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'gifmoji-studio-data');
const DEFAULT_MODEL = process.env.DEFAULT_IMAGE_MODEL || 'hy-image-v3.5-preview';
const DEFAULT_BASE_URL = process.env.TOKENHUB_URL || 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation';
const DEFAULT_PROTOCOL = 'hunyuan';
const ALLOWED_PROTOCOLS = new Set(['auto', 'hunyuan', 'openai-images', 'openai-chat']);
const ALLOW_PRIVATE_MODEL_URL = process.env.ALLOW_PRIVATE_MODEL_URL === 'true';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FRAMES = 8;

await fsp.mkdir(DATA_DIR, { recursive: true });

const app = express();
const sessions = new Map();
const jobs = new Map();
const rateBuckets = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '').trim();

app.use((req, res, next) => {
  // 前端可能托管在 GitHub Pages 等静态站点上，需要跨域调用本服务。
  // CORS_ORIGIN 可设为逗号分隔的白名单；留空表示允许任意来源（接口本身不依赖 Cookie）。
  const origin = req.headers.origin;
  if (origin) {
    const allowed = CORS_ORIGIN
      ? CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean).includes(origin)
      : true;
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; "
      // 参考图支持粘贴外链，http 只放行本机（与 connect-src 保持一致）
      + "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*; "
      + "style-src 'self' 'unsafe-inline'; script-src 'self'; "
      // 允许前端把请求发往任意 HTTPS 后端（静态托管时需填写自定义服务地址）
      + "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; "
      + "font-src 'self'; frame-ancestors 'self'"
  );
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 }
});

function httpError(status, message, code = '') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// 同一 IP 在窗口期内的写操作上限，默认 10 分钟 12 次；部署在反代后面时可放宽
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const windowMs = RATE_LIMIT_WINDOW_MS;
  const max = RATE_LIMIT_MAX;
  const bucket = rateBuckets.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > max) {
    return res.status(429).json({ error: '操作太频繁，请稍后再试。' });
  }
  next();
}

function safeId(value, label = '会话') {
  if (typeof value !== 'string' || !/^[a-f0-9-]{20,40}$/i.test(value)) {
    throw httpError(400, `${label}无效。`);
  }
  return value;
}

function sessionDir(sessionId) {
  return path.join(DATA_DIR, safeId(sessionId));
}

function framePublic(sessionId, frame) {
  return {
    id: frame.id,
    url: `/api/media/${sessionId}/${frame.file}`,
    width: frame.width,
    height: frame.height,
    caption: frame.caption || '分镜'
  };
}

function sessionPublic(session) {
  return {
    id: session.id,
    frames: session.frames.map((frame) => framePublic(session.id, frame)),
    hasReference: Boolean(session.referenceFile),
    referenceUrl: session.referenceFile
      ? `/api/media/${session.id}/${session.referenceFile}?v=${session.createdAt}`
      : null,
    createdAt: session.createdAt
  };
}

async function createSession() {
  const id = randomUUID();
  const dir = sessionDir(id);
  await fsp.mkdir(path.join(dir, 'frames'), { recursive: true });
  const session = { id, dir, frames: [], referenceFile: null, createdAt: Date.now() };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw httpError(404, '会话已过期，请重新生成分镜。');
  return session;
}

async function saveUploadedFrame(session, buffer, caption = '自定义分镜') {
  if (session.frames.length >= MAX_FRAMES) {
    throw httpError(400, `最多保留 ${MAX_FRAMES} 帧，请先删除不需要的分镜。`);
  }
  const id = randomUUID().slice(0, 8);
  const file = `frame-${id}.png`;
  const output = path.join(session.dir, 'frames', file);
  const info = await sharp(buffer)
    .rotate()
    .resize(1024, 1024, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toFile(output);
  const frame = { id, file, width: info.width, height: info.height, caption };
  session.frames.push(frame);
  return frame;
}

async function prepareReference(file) {
  if (!file) return null;
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) {
    throw httpError(400, '参考图仅支持 JPG、PNG 或 WebP。');
  }
  const buffer = await sharp(file.buffer)
    .rotate()
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return {
    buffer,
    dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`
  };
}

const BEATS = [
  { name: '起势', direction: '角色刚刚察觉到画面外的动静，眼神聚焦，身体轻微前倾，表情处于期待与好奇之间。' },
  { name: '反应', direction: '情绪开始明显升级，眉毛和眼睛先做出反应，嘴角变化清晰，身体出现方向性动作。' },
  { name: '增强', direction: '表情进一步夸张，肢体动作加大，轮廓张力增强，但角色和配色保持完全一致。' },
  { name: '爆发', direction: '情绪到达最高点，这是整组表情最有冲击力的主帧，动作幅度最大，表情鲜明且适合做封面。' },
  { name: '延展', direction: '延续高潮动作，增加一个有趣的小细节或轻微惯性，让画面不突然中断。' },
  { name: '转折', direction: '情绪开始转换，角色动作方向或表情发生转折，形成幽默感或意外的反差。' },
  { name: '收束', direction: '动作回落，角色逐渐回到稳定状态，保留一个可爱、得意或无奈的小表情。' },
  { name: '回环', direction: '画面接近起始姿态，动作自然减速，能够无缝衔接回第一帧形成循环。' }
];

function frameDirection(index, total) {
  if (total <= 1) return BEATS[0];
  const sequences = {
    2: [0, 7],
    3: [0, 3, 7],
    4: [0, 1, 3, 7],
    5: [0, 1, 2, 3, 7],
    6: [0, 1, 2, 3, 5, 7],
    7: [0, 1, 2, 3, 4, 5, 7],
    8: [0, 1, 2, 3, 4, 5, 6, 7]
  };
  const sequence = sequences[total] || BEATS.map((_, beatIndex) => beatIndex);
  return BEATS[sequence[index] ?? Math.min(index, BEATS.length - 1)];
}

function buildFramePrompt({ prompt, style, motion, index, total }) {
  const beat = frameDirection(index, total);
  return [
    `你是专业的表情包分镜师，正在制作一套可在微信中循环播放的动态表情，共 ${total} 帧。`,
    `这是第 ${index + 1} 帧，分镜阶段：${beat.name}。`,
    `用户主题：${prompt}`,
    `画面风格：${style}。动态基调：${motion}。`,
    `本帧动作要求：${beat.direction}`,
    '一致性要求：所有帧必须保持同一个角色、同一套服装、同一配色与同一种绘画风格；角色在画面中的大小和位置尽量稳定，只改变表情和动作。',
    '构图要求：正方形构图，单一完整场景，角色居中并留出安全边距，背景干净简洁，缩小到 240 像素仍能看清表情。',
    '交付要求：只生成一张完整单帧画面，不生成拼图、多格漫画、分镜表、边框、字幕、水印或 UI。不要出现任何文字。',
    total > 1 && index === total - 1
      ? '循环要求：最后一帧的姿态要能自然回到第一帧，方便 GIF 无缝循环。'
      : '动画要求：动作方向清晰，方便与前后帧形成连贯动画。'
  ].join('\n');
}

function normalizeProtocol(value) {
  const protocol = String(value || 'auto');
  return ALLOWED_PROTOCOLS.has(protocol) ? protocol : 'auto';
}

function isDefaultEndpoint(baseUrl) {
  try {
    const candidate = new URL(baseUrl);
    const fallback = new URL(DEFAULT_BASE_URL);
    candidate.hash = '';
    fallback.hash = '';
    return candidate.toString().replace(/\/$/, '') === fallback.toString().replace(/\/$/, '');
  } catch {
    return false;
  }
}

function blockedIp(address) {
  if (!address) return true;
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

async function assertSafeRemoteUrl(rawUrl, label = '接口地址') {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw httpError(400, `${label}无效或过长。`, 'invalid_endpoint');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, `${label}格式不正确，请填写完整的 HTTPS URL。`, 'invalid_endpoint');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw httpError(400, `${label}必须是 HTTPS URL。`, 'invalid_endpoint');
  }
  if (url.protocol === 'http:' && !ALLOW_PRIVATE_MODEL_URL) {
    throw httpError(400, `出于安全考虑，${label}必须使用 HTTPS。`, 'insecure_endpoint');
  }
  if (url.username || url.password) {
    throw httpError(400, `不要在${label}中包含用户名或密码。`, 'invalid_endpoint');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata.google.internal') {
    throw httpError(400, `出于安全限制，${label}不能指向本机或内网。`, 'private_endpoint');
  }

  let addresses;
  try {
    addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw httpError(400, `无法解析${label}的域名，请检查地址。`, 'invalid_endpoint');
  }
  if (!addresses.length) throw httpError(400, `${label}的域名没有可用地址。`, 'invalid_endpoint');
  if (!ALLOW_PRIVATE_MODEL_URL && addresses.some((entry) => blockedIp(entry.address))) {
    throw httpError(400, `出于安全限制，${label}不能指向本机、内网或保留地址。`, 'private_endpoint');
  }
  return url;
}

const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 15000;

/**
 * 从用户提供的链接拉取一张图片。
 * 沿用 assertSafeRemoteUrl 的内网拦截，并额外做了三件事：
 * 1. 禁止跟随重定向 —— 否则可以先给一个公网地址、再 302 到 127.0.0.1 绕开校验；
 * 2. 校验 content-type 必须是图片；
 * 3. 流式累计字节数，content-length 缺失时也能在超限的第一时间中断。
 */
async function fetchRemoteImage(rawUrl, label = '图片链接') {
  const url = await assertSafeRemoteUrl(rawUrl, label);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
      headers: { accept: 'image/*' }
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时' : '网络不可达或被拒绝';
    throw httpError(400, `${label}无法访问：${reason}。`, 'image_unreachable');
  }
  if (!response.ok) {
    throw httpError(400, `${label}返回 ${response.status}，请确认链接可以直接打开。`, 'image_unreachable');
  }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) {
    throw httpError(400, `${label}指向的不是图片（返回 ${type || '未知类型'}）。`, 'image_not_image');
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_REMOTE_IMAGE_BYTES) {
    throw httpError(400, `${label}对应的图片超过 15 MB。`, 'image_too_large');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      throw httpError(400, `${label}对应的图片超过 15 MB。`, 'image_too_large');
    }
    chunks.push(chunk);
  }
  if (!total) throw httpError(400, `${label}返回了空内容。`, 'image_empty');
  return { buffer: Buffer.concat(chunks), mime: type.split(';')[0].trim() };
}

function inferProtocol(url) {
  const pathname = url.pathname.toLowerCase();
  if (pathname.includes('hunyuan-image') || pathname.endsWith('/v35-generation')) return 'hunyuan';
  if (pathname.endsWith('/chat/completions')) return 'openai-chat';
  if (pathname.includes('/images/')) return 'openai-images';
  return 'openai-images';
}

function withPathSuffix(url, suffix) {
  const next = new URL(url.toString());
  next.pathname = `${next.pathname.replace(/\/+$/, '')}${suffix}`;
  return next;
}

function resolveImageEndpoint(baseUrl, requestedProtocol, hasReference) {
  const base = new URL(baseUrl);
  const protocol = requestedProtocol === 'auto' ? inferProtocol(base) : requestedProtocol;
  let endpoint;
  if (protocol === 'hunyuan') {
    endpoint = /\/v35-generation\/?$/i.test(base.pathname)
      ? base
      : withPathSuffix(base, '/wand/hunyuan-image/v35-generation');
  } else if (protocol === 'openai-chat') {
    endpoint = /\/chat\/completions\/?$/i.test(base.pathname)
      ? base
      : withPathSuffix(base, '/chat/completions');
  } else {
    const editPath = hasReference ? '/images/edits' : '/images/generations';
    if (/\/images\/(generations|edits)\/?$/i.test(base.pathname)) {
      endpoint = new URL(base.toString());
      endpoint.pathname = base.pathname.replace(/\/images\/(generations|edits)\/?$/i, editPath);
    } else {
      endpoint = withPathSuffix(base, editPath);
    }
  }
  return { endpoint, protocol };
}

async function readResponseBody(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 40 * 1024 * 1024) throw httpError(502, '模型接口返回内容过大。');
  const text = await response.text();
  if (Buffer.byteLength(text) > 40 * 1024 * 1024) throw httpError(502, '模型接口返回内容过大。');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (const line of dataLines.reverse()) {
      const raw = line.replace(/^data:\s*/, '').trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        data = JSON.parse(raw);
        break;
      } catch {
        // 继续寻找有效的 JSON 数据帧
      }
    }
  }
  return { data, text };
}

function upstreamMessage(data, text) {
  const message = data?.error?.message || data?.message || data?.error?.code;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  if (data?.error && typeof data.error === 'string') return data.error.slice(0, 300);
  if (text && !text.trim().startsWith('<')) return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  return '';
}

function assertUpstreamOk(response, data, text) {
  if (response.ok && !data?.error) return;
  const detail = upstreamMessage(data, text);
  if (response.status === 401 || response.status === 403) {
    throw httpError(response.status, '接口 API Key 无效或没有该模型的调用权限。', 'invalid_api_key');
  }
  if (response.status === 404) {
    throw httpError(404, '接口路径或模型不存在，请检查 Base URL 与模型 ID。', 'invalid_model_endpoint');
  }
  if (response.status === 422) {
    throw httpError(422, '内容未通过模型服务的安全审核。', 'content_filter');
  }
  if (response.status === 429) {
    throw httpError(429, '模型服务当前并发已满或额度不足，请稍后重试。', 'rate_limited');
  }
  if (data?.error?.code === 'content_filter') {
    throw httpError(422, '内容未通过模型服务的安全审核。', 'content_filter');
  }
  throw httpError(502, detail ? `模型调用失败：${detail}` : `模型调用失败（HTTP ${response.status}）。`, 'upstream_error');
}

function imageSourceFromValue(value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
    const markdownImage = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(value);
    if (markdownImage) return markdownImage[1];
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.b64_json === 'string') return `data:image/png;base64,${value.b64_json}`;
  if (typeof value.result === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(value.result) && value.result.length > 100) {
    return `data:image/png;base64,${value.result.replace(/\s/g, '')}`;
  }
  if (typeof value.url === 'string') return value.url;
  if (value.image_url?.url) return imageSourceFromValue(value.image_url.url);
  if (value.image?.url) return imageSourceFromValue(value.image.url);
  return '';
}

function extractImageSource(payload) {
  const candidates = [
    payload?.choices?.[0]?.delta?.image,
    payload?.choices?.[0]?.message?.images?.[0],
    payload?.choices?.[0]?.message?.content,
    payload?.data?.[0],
    payload?.images?.[0],
    payload?.image,
    payload?.output?.[0],
    payload?.output?.image
  ];
  for (const candidate of candidates) {
    const source = imageSourceFromValue(candidate);
    if (source) return source;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const nested = imageSourceFromValue(entry);
        if (nested) return nested;
      }
    }
  }
  return '';
}

async function postModelJson(endpoint, apiKey, payload) {
  const url = await assertSafeRemoteUrl(endpoint.toString());
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(210000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw httpError(504, '模型接口响应超时，请稍后重试。', 'upstream_timeout');
    throw httpError(502, '无法连接自定义模型接口，请检查地址或网络。', 'upstream_network');
  }
  const { data, text } = await readResponseBody(response);
  assertUpstreamOk(response, data, text);
  return { data, response };
}

async function requestGeneratedImage({ baseUrl, protocol, model, apiKey, prompt, reference }) {
  const { endpoint, protocol: resolvedProtocol } = resolveImageEndpoint(baseUrl, protocol, Boolean(reference));
  await assertSafeRemoteUrl(endpoint.toString());

  if (resolvedProtocol === 'hunyuan') {
    const content = [{ type: 'text', text: prompt }];
    if (reference?.dataUrl) content.push({ type: 'image_url', image_url: { url: reference.dataUrl } });
    const { data } = await postModelJson(endpoint, apiKey, {
      model,
      size: '1024x1024',
      messages: [{ role: 'user', content }]
    });
    const source = extractImageSource(data);
    if (!source) throw httpError(502, '模型接口没有返回图片，请检查接口协议是否匹配。', 'no_image');
    return source;
  }

  if (resolvedProtocol === 'openai-chat') {
    const content = [{ type: 'text', text: prompt }];
    if (reference?.dataUrl) content.push({ type: 'image_url', image_url: { url: reference.dataUrl } });
    const payload = {
      model,
      stream: false,
      messages: [{ role: 'user', content }]
    };
    if (/gpt-image/i.test(model)) payload.modalities = ['image', 'text'];
    let result;
    try {
      result = await postModelJson(endpoint, apiKey, payload);
    } catch (error) {
      if (payload.modalities && error.status === 502 && /modalit|param|unsupported/i.test(error.message)) {
        delete payload.modalities;
        result = await postModelJson(endpoint, apiKey, payload);
      } else {
        throw error;
      }
    }
    const source = extractImageSource(result.data);
    if (!source) throw httpError(502, '聊天接口没有返回图片。请确认该模型支持图片输出，或改用 OpenAI 图像协议。', 'no_image');
    return source;
  }

  const url = await assertSafeRemoteUrl(endpoint.toString());
  let response;
  try {
    if (reference?.buffer) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', '1024x1024');
      form.append('n', '1');
      form.append('image', new Blob([reference.buffer], { type: 'image/jpeg' }), 'reference.jpg');
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(210000)
      });
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ model, prompt, size: '1024x1024', n: 1 }),
        redirect: 'error',
        signal: AbortSignal.timeout(210000)
      });
    }
  } catch (error) {
    if (error.name === 'TimeoutError') throw httpError(504, '模型接口响应超时，请稍后重试。', 'upstream_timeout');
    throw httpError(502, '无法连接自定义模型接口，请检查地址或网络。', 'upstream_network');
  }
  const { data, text } = await readResponseBody(response);
  assertUpstreamOk(response, data, text);
  const source = extractImageSource(data);
  if (!source) throw httpError(502, '模型接口没有返回图片，请检查接口协议和响应格式。', 'no_image');
  return source;
}

async function downloadImage(source) {
  if (typeof source === 'string' && source.startsWith('data:image/')) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(source);
    if (!match) throw httpError(502, '模型返回的 Base64 图片格式无效。');
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw httpError(502, '模型返回的图片体积异常。');
    return buffer;
  }
  const url = await assertSafeRemoteUrl(source);
  let response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  } catch {
    throw httpError(502, '生成图片下载失败，请重试。');
  }
  if (!response.ok) throw httpError(502, `生成图片下载失败（${response.status}）。`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 30 * 1024 * 1024) throw httpError(502, '生成图片体积异常。');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw httpError(502, '生成图片体积异常。');
  return buffer;
}

async function runGeneration(job, session, options) {
  job.status = 'running';
  job.startedAt = Date.now();
  try {
    for (let index = 0; index < options.frameCount; index += 1) {
      job.current = index + 1;
      job.message = `正在绘制第 ${index + 1} / ${options.frameCount} 帧`;
      const prompt = buildFramePrompt({ ...options, index, total: options.frameCount });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const imageSource = await requestGeneratedImage({
            baseUrl: options.baseUrl,
            protocol: options.protocol,
            model: options.model,
            apiKey: options.apiKey,
            prompt,
            reference: options.reference
          });
          const buffer = await downloadImage(imageSource);
          const frame = await saveUploadedFrame(session, buffer, frameDirection(index, options.frameCount).name);
          job.frames.push(framePublic(session.id, frame));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (![429, 500, 502, 504].includes(error.status) || attempt === 1) break;
          await new Promise((resolve) => setTimeout(resolve, 1600));
        }
      }
      if (lastError) throw lastError;
      job.progress = Math.round(((index + 1) / options.frameCount) * 100);
    }
    job.status = 'done';
    job.progress = 100;
    job.message = `${options.frameCount} 帧已生成，可以合成 GIF 了。`;
  } catch (error) {
    job.status = 'error';
    job.message = error.message || '生成失败，请重试。';
    job.errorCode = error.code || '';
  } finally {
    options.apiKey = '';
    options.reference = null;
  }
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function runProcess(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('媒体处理超时，请减少帧数或尺寸后重试。'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `FFmpeg 退出码 ${code}`));
    });
  });
}

async function renderGif({ frames, width, fps, holdMs, quality, maxKb }) {
  const dir = path.dirname(frames[0].path);
  const filterFile = path.join(dir, `filter-${randomUUID().slice(0, 8)}.txt`);
  const output = path.join(dir, 'emoji.gif');
  const qualityMap = {
    high: { colors: 256, dither: 'sierra2_4a' },
    medium: { colors: 128, dither: 'bayer:bayer_scale=3' },
    low: { colors: 64, dither: 'none' }
  };
  let targetWidth = width;
  let q = qualityMap[quality] || qualityMap.high;
  let finalInfo = null;

  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const inputs = frames.flatMap((frame) => [
        '-loop', '1', '-t', (holdMs / 1000).toFixed(3), '-i', frame.path
      ]);
      const chain = [
        `${frames.map((_, index) => `[${index}:v]`).join('')}concat=n=${frames.length}:v=1:a=0[cat]`,
        `[cat]fps=${fps},scale=${targetWidth}:${targetWidth}:flags=lanczos,setsar=1,split[s0][s1]`,
        `[s0]palettegen=max_colors=${q.colors}:stats_mode=diff[p]`,
        `[s1][p]paletteuse=dither=${q.dither}:diff_mode=rectangle[out]`
      ].join(';');
      await fsp.writeFile(filterFile, chain, 'utf8');
      await runProcess(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error',
        ...inputs,
        '-filter_complex_script', filterFile,
        '-map', '[out]',
        '-loop', '0',
        '-y', output
      ]);
      const stats = await fsp.stat(output);
      const info = await sharp(output, { animated: true }).metadata();
      const pageCount = info.pages || frames.length;
      finalInfo = {
        bytes: stats.size,
        width: info.width || targetWidth,
        height: info.pageHeight || Math.round((info.height || targetWidth * pageCount) / pageCount),
        pages: pageCount
      };
      if (!maxKb || stats.size <= maxKb * 1024 || (targetWidth <= 120 && q.colors <= 32)) break;
      targetWidth = Math.max(120, Math.round(targetWidth * 0.8 / 2) * 2);
      q = {
        colors: Math.max(32, Math.floor(q.colors * 0.7)),
        dither: q.colors <= 64 ? 'none' : 'bayer:bayer_scale=3'
      };
    }
    return { output, ...finalInfo };
  } finally {
    await fsp.rm(filterFile, { force: true });
  }
}

function normalizeNumber(value, fallback, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw httpError(400, `${label}需在 ${min} 到 ${max} 之间。`);
  }
  return number;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: DEFAULT_MODEL, ffmpeg: true, managedKey: Boolean(process.env.TOKENHUB_API_KEY) });
});

app.get('/api/config', (req, res) => {
  res.json({
    model: DEFAULT_MODEL,
    modelLabel: 'Hy Image 3.5 preview',
    defaultBaseUrl: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    defaultProtocol: DEFAULT_PROTOCOL,
    managedKey: Boolean(process.env.TOKENHUB_API_KEY),
    customEndpoint: true,
    protocols: [
      { value: 'auto', label: '自动识别' },
      { value: 'hunyuan', label: '混元 v3.5' },
      { value: 'openai-images', label: 'OpenAI 图像' },
      { value: 'openai-chat', label: '聊天式生图' }
    ],
    maxFrames: MAX_FRAMES,
    maxReferenceMb: 15
  });
});

app.post('/api/sessions', asyncRoute(async (req, res) => {
  const session = await createSession();
  res.status(201).json({ session: sessionPublic(session) });
}));

app.post('/api/import', rateLimit, upload.array('frames', MAX_FRAMES), asyncRoute(async (req, res) => {
  // 前端可能传文件、传链接，或两者混合；链接按换行/逗号分隔，也接受 JSON 数组
  let urlList = [];
  const rawUrls = String(req.body.urls || '').trim();
  if (rawUrls) {
    if (rawUrls.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawUrls);
        if (Array.isArray(parsed)) urlList = parsed.map((item) => String(item).trim()).filter(Boolean);
      } catch {
        throw httpError(400, '图片链接列表格式不正确。');
      }
    } else {
      urlList = rawUrls.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    }
  }
  // 宁可报错也不静默截断：否则用户以为 9 张都导入了，实际只进来 8 张
  if (urlList.length > MAX_FRAMES) {
    throw httpError(400, `一次最多导入 ${MAX_FRAMES} 个链接，当前有 ${urlList.length} 个。`);
  }

  const files = req.files || [];
  if (!files.length && !urlList.length) throw httpError(400, '请选择图片，或粘贴至少一个图片链接。');
  const session = req.body.sessionId
    ? getSession(safeId(req.body.sessionId))
    : await createSession();
  if (session.frames.length + files.length + urlList.length > MAX_FRAMES) {
    throw httpError(400, `分镜台最多保留 ${MAX_FRAMES} 帧，请先删除不需要的分镜。`);
  }
  for (const file of files) {
    await saveUploadedFrame(session, file.buffer, '自定义分镜');
  }
  // 逐张拉取：并发拉多个外链容易同时触发对方限流，串行更稳且进度可预期
  for (const [index, item] of urlList.entries()) {
    const remote = await fetchRemoteImage(item, `第 ${index + 1} 个分镜链接`);
    await saveUploadedFrame(session, remote.buffer, '链接分镜');
  }
  res.json({ session: sessionPublic(session) });
}));

app.post('/api/generate', rateLimit, upload.single('reference'), asyncRoute(async (req, res) => {
  const baseUrl = String(req.body.baseUrl || DEFAULT_BASE_URL).trim().slice(0, 2048);
  const model = String(req.body.model || DEFAULT_MODEL).trim().slice(0, 120);
  const protocol = normalizeProtocol(req.body.protocol);
  const suppliedKey = String(req.body.apiKey || '').trim().slice(0, 4096);
  const managedKey = !suppliedKey && isDefaultEndpoint(baseUrl) ? String(process.env.TOKENHUB_API_KEY || '').trim() : '';
  const apiKey = suppliedKey || managedKey;
  if (!apiKey) {
    throw httpError(400, '请填写接口 API Key。平台配置的密钥仅用于默认 TokenHub 接口。', 'missing_api_key');
  }
  if (!model) throw httpError(400, '请填写模型 ID。', 'missing_model');
  const prompt = String(req.body.prompt || '').trim();
  if (prompt.length < 2 || prompt.length > 2000) {
    throw httpError(400, '请用 2 到 2000 个字符描述想要的表情。');
  }
  const frameCount = normalizeNumber(req.body.frameCount || 6, 6, 2, MAX_FRAMES, '分镜数量');
  if (!Number.isInteger(frameCount)) throw httpError(400, '分镜数量必须是整数。');
  const style = String(req.body.style || '3D黏土质感').slice(0, 80);
  const motion = String(req.body.motion || 'Q弹夸张').slice(0, 80);
  const referenceUrl = String(req.body.referenceUrl || '').trim();
  let reference = await prepareReference(req.file);
  // 用户粘贴链接时，图片由服务端去拉：浏览器直接 fetch 外部图片多半会被 CORS 拦下
  if (!reference && referenceUrl) {
    const remote = await fetchRemoteImage(referenceUrl, '参考图链接');
    reference = await prepareReference({ buffer: remote.buffer, mimetype: remote.mime });
  }
  const endpointPreview = resolveImageEndpoint(baseUrl, protocol, Boolean(reference));
  await assertSafeRemoteUrl(endpointPreview.endpoint.toString());
  const session = await createSession();

  if (reference) {
    const refFile = 'reference.jpg';
    await fsp.writeFile(path.join(session.dir, refFile), reference.buffer);
    session.referenceFile = refFile;
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    sessionId: session.id,
    status: 'queued',
    progress: 0,
    current: 0,
    total: frameCount,
    model,
    protocol: endpointPreview.protocol,
    message: `任务已创建，准备调用 ${model}…`,
    frames: [],
    createdAt: Date.now()
  };
  jobs.set(jobId, job);

  runGeneration(job, session, {
    apiKey,
    baseUrl,
    model,
    protocol,
    prompt,
    style,
    motion,
    frameCount,
    reference
  });

  res.status(202).json({ jobId, sessionId: session.id, model, protocol: endpointPreview.protocol });
}));

app.get('/api/jobs/:jobId', asyncRoute(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) throw httpError(404, '生成任务不存在或已过期。');
  const session = getSession(job.sessionId);
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    current: job.current,
    total: job.total,
    message: job.message,
    model: job.model || '',
    protocol: job.protocol || '',
    errorCode: job.errorCode || '',
    session: { ...sessionPublic(session), frames: job.frames.length ? job.frames : sessionPublic(session).frames }
  });
}));

app.delete('/api/frames/:sessionId/:frameId', asyncRoute(async (req, res) => {
  const session = getSession(safeId(req.params.sessionId));
  const index = session.frames.findIndex((frame) => frame.id === req.params.frameId);
  if (index === -1) throw httpError(404, '分镜不存在。');
  const [frame] = session.frames.splice(index, 1);
  await fsp.rm(path.join(session.dir, 'frames', frame.file), { force: true });
  res.json({ session: sessionPublic(session) });
}));

app.post('/api/compose', rateLimit, asyncRoute(async (req, res) => {
  const session = getSession(safeId(req.body.sessionId));
  const order = Array.isArray(req.body.order) ? req.body.order.slice(0, MAX_FRAMES) : [];
  if (order.length < 2) throw httpError(400, '至少需要两帧才能合成动态 GIF。');
  const width = normalizeNumber(req.body.width || 320, 320, 120, 720, '输出尺寸');
  const fps = normalizeNumber(req.body.fps || 10, 10, 4, 20, '帧率');
  const holdMs = normalizeNumber(req.body.holdMs || 220, 220, 80, 1200, '单帧停留时间');
  const maxKb = req.body.maxMb ? normalizeNumber(req.body.maxMb, 1, 0.2, 8, '体积上限') * 1024 : 0;
  const quality = ['high', 'medium', 'low'].includes(req.body.quality) ? req.body.quality : 'high';
  const byId = new Map(session.frames.map((frame) => [frame.id, frame]));
  const frames = order.map((id) => {
    const frame = byId.get(id);
    if (!frame) throw httpError(400, '分镜顺序中包含失效的图片，请刷新后重试。');
    return { ...frame, path: path.join(session.dir, 'frames', frame.file) };
  });

  let result;
  try {
    result = await renderGif({
      frames,
      width: Math.round(width / 2) * 2,
      fps: Math.round(fps),
      holdMs,
      quality,
      maxKb
    });
  } catch (error) {
    throw httpError(500, `GIF 合成失败：${error.message}`);
  }

  res.json({
    gif: {
      url: `/api/media/${session.id}/emoji.gif?v=${Date.now()}`,
      downloadUrl: `/api/download/${session.id}/emoji.gif`,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      pages: result.pages,
      underLimit: maxKb ? result.bytes <= maxKb * 1024 : null
    }
  });
}));

app.get('/api/download/:sessionId/frames.zip', asyncRoute(async (req, res) => {
  const session = getSession(safeId(req.params.sessionId));
  if (!session.frames.length) throw httpError(404, '没有可导出的分镜。');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="gifmoji-frames-${Date.now()}.zip"`);
  const zipfile = new ZipFile();
  zipfile.outputStream.on('error', (error) => {
    if (!res.headersSent) res.status(500).json({ error: '分镜打包失败。' });
    else res.destroy(error);
  });
  res.on('close', () => {
    if (!res.writableEnded) zipfile.outputStream.destroy();
  });
  zipfile.outputStream.pipe(res);
  session.frames.forEach((frame, index) => {
    zipfile.addFile(
      path.join(session.dir, 'frames', frame.file),
      `${String(index + 1).padStart(2, '0')}-${frame.caption}.png`
    );
  });
  zipfile.end();
}));

app.get('/api/download/:sessionId/emoji.gif', asyncRoute(async (req, res) => {
  const session = getSession(safeId(req.params.sessionId));
  const file = path.join(session.dir, 'frames', 'emoji.gif');
  try {
    await fsp.access(file);
  } catch {
    throw httpError(404, '请先合成 GIF。');
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Disposition', `attachment; filename="gifmoji-${Date.now()}.gif"`);
  res.sendFile(file);
}));

app.get('/api/media/:sessionId/:file', asyncRoute(async (req, res) => {
  const session = getSession(safeId(req.params.sessionId));
  const file = String(req.params.file || '');
  if (!/^(frame-[a-f0-9]{8}\.png|reference\.jpg|emoji\.gif)$/.test(file)) {
    throw httpError(404, '文件不存在。');
  }
  const inFramesDir = file.startsWith('frame-') || file === 'emoji.gif';
  const target = path.join(session.dir, inFramesDir ? 'frames' : '', file);
  try {
    await fsp.access(target);
  } catch {
    throw httpError(404, '文件不存在。');
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(target);
}));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在。' });
  if (req.method === 'GET' && req.accepts('html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '单张图片不能超过 15 MB。' });
    return res.status(400).json({ error: '图片上传失败，请减少数量或体积。' });
  }
  const status = error.status || 500;
  if (status >= 500 && process.env.NODE_ENV !== 'test') {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}:`, error.message);
  }
  res.status(status).json({ error: error.message || '服务暂时不可用。', code: error.code || '' });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const [id, job] of jobs) {
    if (now - job.createdAt > SESSION_TTL_MS) jobs.delete(id);
  }
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start > 30 * 60 * 1000) rateBuckets.delete(ip);
  }
}, 30 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GIFMOJI Studio listening on 0.0.0.0:${PORT}`);
  console.log(`Model: ${DEFAULT_MODEL}`);
  console.log(`Managed API key: ${process.env.TOKENHUB_API_KEY ? 'yes' : 'no'}`);
});
