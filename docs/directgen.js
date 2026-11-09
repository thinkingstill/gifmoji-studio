/**
 * 纯前端分镜生成（GitHub Pages 等无后端场景）。
 *
 * 说明：模型接口不在静态站点自身域名下，直接调用会被 CORS 拦截，密钥也会暴露在页面里。
 * 因此这里只在没有后端时使用：由页面向模型接口直连，要求该接口允许浏览器跨域访问。
 * 后端可用时始终优先走服务端，避免密钥进入前端。
 */

const MAX_FRAMES = 8;

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

const SEQUENCES = {
  2: [0, 7],
  3: [0, 3, 7],
  4: [0, 1, 3, 7],
  5: [0, 1, 2, 3, 7],
  6: [0, 1, 2, 3, 5, 7],
  7: [0, 1, 2, 3, 4, 5, 7],
  8: [0, 1, 2, 3, 4, 5, 6, 7]
};

/** 与 server.js 的 frameDirection 保持一致，保证两种模式的分镜节奏相同 */
export function frameBeat(index, total) {
  if (total <= 1) return BEATS[0];
  const sequence = SEQUENCES[total] || BEATS.map((_, i) => i);
  return BEATS[sequence[index] ?? Math.min(index, BEATS.length - 1)];
}

export function buildFramePrompt({ prompt, style, motion, index, total }) {
  const beat = frameBeat(index, total);
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

function detectProtocol(baseUrl, requested) {
  if (requested && requested !== 'auto') return requested;
  const url = String(baseUrl || '');
  if (/hunyuan-image|\/v35-generation/i.test(url)) return 'hunyuan';
  if (/\/images\/(generations|edits)/i.test(url)) return 'openai-images';
  if (/\/chat\/completions/i.test(url)) return 'openai-chat';
  return 'openai-images';
}

function endsWith(baseUrl, suffix) {
  return new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(baseUrl);
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('参考图读取失败。'));
    reader.readAsDataURL(file);
  });
}

/** 从各种模型响应里尽力找出图片地址或 base64 */
function pickImage(payload) {
  if (!payload) return '';
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.b64_json === 'string' && node.b64_json.length > 100) return `data:image/png;base64,${node.b64_json}`;
    if (typeof node.url === 'string' && /^https?:|^data:image\//i.test(node.url)) {
      if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(node.url) || node.url.startsWith('data:image/')) return node.url;
    }
    if (typeof node.image_url === 'string') return node.image_url;
    if (node.image_url && typeof node.image_url === 'object' && typeof node.image_url.url === 'string') return node.image_url.url;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
      else if (typeof value === 'string' && /^https?:\/\/\S+\.(png|jpe?g|webp)(\?\S*)?$/i.test(value)) return value;
    }
  }
  return '';
}

async function requestHunyuan({ baseUrl, apiKey, model, prompt, reference }) {
  const content = [{ type: 'text', text: prompt }];
  if (reference) content.push({ type: 'image_url', image_url: { url: reference } });
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${text.slice(0, 160)}`);
  return pickImage(safeJson(text));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 有些接口返回 SSE，尽力从 data: 行里提取
    const line = text.split('\n').reverse().find((item) => item.trim().startsWith('data:'));
    if (line) {
      try {
        return JSON.parse(line.replace(/^data:\s*/, ''));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function requestOpenAiImages({ baseUrl, apiKey, model, prompt, reference }) {
  if (reference) {
    const blob = await (await fetch(reference)).blob();
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('image', blob, 'reference.png');
    const editsUrl = /\/images\/edits\/?$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl.replace(/\/+$/, '').replace(/\/images\/generations$/i, '/images/edits')}`;
    const res = await fetch(endsWith(editsUrl, '/images/generations') ? editsUrl.replace(/generations$/i, 'edits') : editsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`接口返回 ${res.status}：${JSON.stringify(data).slice(0, 160)}`);
    return pickImage(data);
  }
  const url = endsWith(baseUrl, '/images/edits') ? baseUrl.replace(/edits$/i, 'generations') : baseUrl;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024', response_format: 'url' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${JSON.stringify(data).slice(0, 160)}`);
  return pickImage(data);
}

async function requestChat({ baseUrl, apiKey, model, prompt, reference }) {
  const content = [{ type: 'text', text: prompt }];
  if (reference) content.push({ type: 'image_url', image_url: { url: reference } });
  const url = endsWith(baseUrl, '/chat/completions') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${text.slice(0, 160)}`);
  return pickImage(safeJson(text));
}

/**
 * 逐帧生成分镜，返回 dataURL 列表。
 * 浏览器直连要求模型接口带 CORS 头，否则会失败并给出明确提示。
 */
export async function generateFrames({ baseUrl, apiKey, model, protocol, prompt, style, motion, frameCount, reference, onProgress = () => {} }) {
  const total = Math.max(2, Math.min(MAX_FRAMES, Number(frameCount) || 6));
  const type = detectProtocol(baseUrl, protocol);
  const referenceData = reference ? await fileToDataUrl(reference) : '';
  const urls = [];

  for (let index = 0; index < total; index += 1) {
    const beat = frameBeat(index, total);
    onProgress({ progress: Math.round((index / total) * 100), current: index, total, message: `正在生成「${beat.name}」第 ${index + 1} 帧…` });
    const framePrompt = buildFramePrompt({ prompt, style, motion, index, total });
    let url = '';
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const options = { baseUrl, apiKey, model, prompt: framePrompt, reference: referenceData };
        url = type === 'hunyuan'
          ? await requestHunyuan(options)
          : type === 'openai-chat'
            ? await requestChat(options)
            : await requestOpenAiImages(options);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (lastError) {
      const hint = /Failed to fetch|NetworkError|Load failed/i.test(lastError.message)
        ? '（浏览器直连被拦截，通常是接口未允许跨域访问；可改用后端服务模式）'
        : '';
      throw new Error(`第 ${index + 1} 帧生成失败：${lastError.message}${hint}`);
    }
    if (!url) throw new Error(`第 ${index + 1} 帧没有返回图片，请检查模型是否支持出图。`);
    urls.push({ url, caption: beat.name });
  }

  onProgress({ progress: 100, current: total, total, message: `${total} 帧已生成。` });
  return urls;
}
