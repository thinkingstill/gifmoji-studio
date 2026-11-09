/**
 * 后端服务地址适配层。
 *
 * - 本地部署（由 server.js 提供 /api）：默认走同源相对路径，开箱即用。
 * - GitHub Pages 等纯静态托管：没有后端，需要用户在「服务连接」里填写后端地址，
 *   生图与 FFmpeg 合成都会转发到该地址。
 *
 * 作用范围：本文件只改写 API 与后端静态资源的前缀，不改动任何业务逻辑。
 */

const STORAGE_KEY = 'gifmoji-backend-url';

const state = {
  /** 用户填写的后端地址；空字符串表示同源 */
  base: '',
  /** 同源后端是否可用（静态托管时探测结果恒为 false） */
  sameOriginAvailable: false,
  /** 用户指定的后端是否已连通 */
  customReady: false,
  /** 是否处于纯静态托管环境 */
  hosted: false
};

function normalize(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

/** 只有在填了后端地址、且同源不可用（或地址与同源不同）时才走自定义地址 */
function useCustom() {
  return Boolean(state.base);
}

function load() {
  try {
    state.base = normalize(localStorage.getItem(STORAGE_KEY) || '');
  } catch {
    state.base = '';
  }
}

export function setBackend(value) {
  load();
  state.base = normalize(value);
  state.customReady = false;
  try {
    if (state.base) localStorage.setItem(STORAGE_KEY, state.base);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式下无法持久化，本次会话仍然生效
  }
  return state.base;
}

/** 后端正处于可用状态（同源或用户指定的自定义地址） */
export function isReady() {
  return state.sameOriginAvailable || state.customReady;
}

export function getBackend() {
  return state.base;
}

export function isHosted() {
  return state.hosted;
}

/** 把 /api/... 之类的相对路径解析成真正要请求的地址 */
export function resolve(path) {
  if (!path.startsWith('/api/')) return path;
  return useCustom() ? `${state.base}${path}` : path;
}

/** 后端返回的绝对/相对路径（如图片 url、下载链接）补全前缀 */
export function resolveAsset(url) {
  if (!url) return url;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  if (!url.startsWith('/api/')) return url;
  return useCustom() ? `${state.base}${url}` : url;
}

/**
 * 探测某个地址是否为可用的 GIFMOJI 后端。
 * 返回 { ok, managedKey, model, reason }
 */
export async function probe(base) {
  const target = `${normalize(base)}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(target, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `后端返回 ${res.status}` };
    const data = await res.json();
    if (!data || data.ok !== true) return { ok: false, reason: '返回内容不是 GIFMOJI 后端' };
    return { ok: true, managedKey: Boolean(data.managedKey), model: data.model || '', ffmpeg: Boolean(data.ffmpeg) };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '连接超时' : '无法连接（可能是跨域限制或地址错误）';
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动时初始化：
 * - 先按同源探测一次；
 * - 同源不可用而用户填过地址，则使用用户地址并探测；
 * - 把结论写入状态，供界面展示。
 */
export async function init() {
  // 静态托管（GitHub Pages）由页面声明 data-env="static"，此时同源必然没有 /api
  state.hosted = document.documentElement.dataset.env === 'static';
  if (state.hosted) {
    load();
    const custom = state.base ? await probe(state.base) : { ok: false, reason: '未填写后端地址' };
    state.customReady = custom.ok;
    return { mode: custom.ok ? 'custom' : 'unset', hosted: true, sameOrigin: { ok: false }, custom, base: state.base };
  }
  return refresh();
}

/** 重新探测（不重读本地存储，供"测试连接"复用） */
export async function refresh() {
  const sameOrigin = await probe('');
  state.sameOriginAvailable = sameOrigin.ok;

  if (sameOrigin.ok && !state.base) {
    return { mode: 'same-origin', hosted: state.hosted, sameOrigin };
  }
  if (state.base) {
    const custom = await probe(state.base);
    state.customReady = custom.ok;
    // 自定义地址不可用但同源可用时，回退到同源
    if (!custom.ok && sameOrigin.ok) {
      state.base = '';
      return { mode: 'same-origin', hosted: state.hosted, sameOrigin, customFallback: true };
    }
    return { mode: custom.ok ? 'custom' : 'broken', hosted: state.hosted, sameOrigin, custom, base: state.base };
  }
  if (sameOrigin.ok) {
    return { mode: 'same-origin', hosted: state.hosted, sameOrigin };
  }
  return { mode: 'unset', hosted: state.hosted, sameOrigin };
}
