/**
 * 浏览器端 GIF 合成器（方案 C）。
 *
 * 纯前端、零依赖：canvas 缩放 → 中位切分量化 → 抖动映射 → 手写 GIF89a 字节流。
 * 用于没有后端 FFmpeg 的静态托管（GitHub Pages）场景。
 *
 * 质量取舍：
 * - 后端 FFmpeg 使用 palettegen(stats_mode=diff) + paletteuse，逐帧统计差异，颜色更准；
 * - 这里为整组帧共用一张调色板，质量略低但无需服务端，且体积可控。
 */

/** 是否需要抖动，以及抖动强度（0 表示不抖动） */
const DITHER = {
  high: { floyd: true, strength: 1 },
  medium: { floyd: true, strength: 0.75 },
  low: { floyd: false, strength: 0 }
};

const COLOR_BY_QUALITY = { high: 256, medium: 128, low: 64 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('分镜图片加载失败，可能是跨域限制或链接失效。'));
    image.src = src;
  });
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 把若干张图片统一缩放并取出像素数据 */
async function collectFrames(urls, size) {
  const images = await Promise.all(urls.map(loadImage));
  const canvas = canvasOf(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const result = [];
  for (const image of images) {
    ctx.clearRect(0, 0, size, size);
    // 与后端一致：居中裁切并铺满正方形
    const scale = Math.max(size / image.width, size / image.height);
    const drawWidth = Math.round(image.width * scale);
    const drawHeight = Math.round(image.height * scale);
    ctx.drawImage(image, Math.round((size - drawWidth) / 2), Math.round((size - drawHeight) / 2), drawWidth, drawHeight);
    const { data } = ctx.getImageData(0, 0, size, size);
    // GIF 不支持半透明，先做一次白底合成
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) {
        const alpha = data[i + 3] / 255;
        data[i] = Math.round(data[i] * alpha + 255 * (1 - alpha));
        data[i + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
        data[i + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
        data[i + 3] = 255;
      }
    }
    result.push(data);
  }
  return result;
}

/**
 * 中位切分量化：把整组帧的像素放进一个桶，反复按最大跨度通道切分，
 * 直到达到目标颜色数，每桶取平均色作为调色板项。
 */
function buildPalette(frames, maxColors, sampleStep) {
  const buckets = [];
  const pixels = [];
  for (const data of frames) {
    for (let i = 0; i < data.length; i += 4 * sampleStep) {
      pixels.push(data[i], data[i + 1], data[i + 2]);
    }
  }
  const makeBucket = (indices) => {
    let rMin = 255; let rMax = 0; let gMin = 255; let gMax = 0; let bMin = 255; let bMax = 0;
    let rSum = 0; let gSum = 0; let bSum = 0;
    for (const index of indices) {
      const r = pixels[index * 3];
      const g = pixels[index * 3 + 1];
      const b = pixels[index * 3 + 2];
      if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      if (g < gMin) gMin = g; if (g > gMax) gMax = g;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
      rSum += r; gSum += g; bSum += b;
    }
    return {
      indices,
      range: Math.max(rMax - rMin, gMax - gMin, bMax - bMin),
      axis: (rMax - rMin) >= (gMax - gMin) && (rMax - rMin) >= (bMax - bMin) ? 0 : ((gMax - gMin) >= (bMax - bMin) ? 1 : 2),
      avg: [Math.round(rSum / indices.length), Math.round(gSum / indices.length), Math.round(bSum / indices.length)]
    };
  };

  const all = new Array(pixels.length / 3);
  for (let i = 0; i < all.length; i += 1) all[i] = i;
  buckets.push(makeBucket(all));

  while (buckets.length < maxColors) {
    let target = -1;
    let widest = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];
      if (bucket.indices.length > 1 && bucket.range > widest) {
        widest = bucket.range;
        target = i;
      }
    }
    if (target === -1) break;
    const bucket = buckets.splice(target, 1)[0];
    const axis = bucket.axis;
    bucket.indices.sort((left, right) => pixels[left * 3 + axis] - pixels[right * 3 + axis]);
    const middle = Math.floor(bucket.indices.length / 2);
    buckets.push(makeBucket(bucket.indices.slice(0, middle)));
    buckets.push(makeBucket(bucket.indices.slice(middle)));
  }

  return buckets.map((bucket) => bucket.avg);
}

/** 预建颜色查找表：把 RGB 各通道压缩到 5 位，加速最近色搜索 */
function buildColorCache(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const [pr, pg, pb] = palette[i];
      const dr = r - pr; const dg = g - pg; const db = b - pb;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache.set(key, best);
    return best;
  };
}

/** 抖动映射：Floyd–Steinberg 误差扩散，把像素映射为调色板索引 */
function mapToIndexes(data, size, palette, dither) {
  const nearest = buildColorCache(palette);
  const indexes = new Uint8Array(size * size);
  const strength = dither.strength;
  const useFloyd = dither.floyd && strength > 0;
  // 用浮点缓冲保存扩散误差，避免逐像素量化误差累积偏差
  const buffer = useFloyd ? Float32Array.from(data) : data;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const r = Math.max(0, Math.min(255, Math.round(buffer[offset])));
      const g = Math.max(0, Math.min(255, Math.round(buffer[offset + 1])));
      const b = Math.max(0, Math.min(255, Math.round(buffer[offset + 2])));
      const index = nearest(r, g, b);
      indexes[y * size + x] = index;
      if (!useFloyd) continue;
      const [pr, pg, pb] = palette[index];
      const er = (r - pr) * strength;
      const eg = (g - pg) * strength;
      const eb = (b - pb) * strength;
      const spread = (px, py, factor) => {
        if (px < 0 || px >= size || py >= size) return;
        const position = (py * size + px) * 4;
        buffer[position] += er * factor;
        buffer[position + 1] += eg * factor;
        buffer[position + 2] += eb * factor;
      };
      spread(x + 1, y, 7 / 16);
      spread(x - 1, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + 1, y + 1, 1 / 16);
    }
  }
  return indexes;
}

/** LZW 压缩，GIF 要求的最小长度编码 */
function lzwEncode(indexes, colorCount) {
  const minCodeSize = Math.max(2, Math.ceil(Math.log2(Math.max(2, colorCount))));
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  let prefix = indexes[0];
  for (let i = 1; i < indexes.length; i += 1) {
    const k = indexes[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode += 1;
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      emit(clearCode);
      dict = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);

  return { minCodeSize, bytes: out };
}

/** 组装 GIF89a：逻辑屏幕 → 全局调色板 → Netscape 循环块 → 每帧图像 */
function assembleGif({ size, palette, frames, delayCs }) {
  const bytes = [];
  const push = (...values) => bytes.push(...values);
  const pushShort = (value) => push(value & 0xff, (value >> 8) & 0xff);

  // 调色板必须是 2 的幂，最少 2 项
  let paletteBits = 1;
  while ((1 << paletteBits) < palette.length && paletteBits < 8) paletteBits += 1;
  const paletteSize = 1 << paletteBits;

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  pushShort(size);
  pushShort(size);
  push(0xf0 | (paletteBits - 1), 0, 0); // 全局调色板 + 颜色深度
  for (let i = 0; i < paletteSize; i += 1) {
    const color = palette[i] || [0, 0, 0];
    push(color[0], color[1], color[2]);
  }

  // Netscape 2.0：无限循环
  push(0x21, 0xff, 0x0b);
  push(0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30);
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const indexes of frames) {
    // 图形控制扩展：帧延迟（单位 1/100 秒）
    push(0x21, 0xf9, 0x04, 0x04);
    pushShort(delayCs);
    push(0x00, 0x00);
    // 图像描述符
    push(0x2c);
    pushShort(0);
    pushShort(0);
    pushShort(size);
    pushShort(size);
    push(0x00);
    const { minCodeSize, bytes: data } = lzwEncode(indexes, paletteSize);
    push(minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      push(chunk.length, ...chunk);
    }
    push(0x00);
  }

  push(0x3b); // 结束符
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

/**
 * 合成入口。
 * @param {object} options
 * @param {string[]} options.urls 分镜地址（按播放顺序）
 * @param {number} options.width 输出边长
 * @param {number} options.fps 帧率
 * @param {number} options.holdMs 单帧停留时间
 * @param {'high'|'medium'|'low'} options.quality 画质
 * @param {number} [options.maxKb] 目标体积上限（KB），0 表示不限制
 * @param {(progress:number)=>void} [options.onProgress]
 */
export async function composeGif({ urls, width = 320, fps = 10, holdMs = 220, quality = 'high', maxKb = 0, onProgress = () => {} }) {
  if (!Array.isArray(urls) || urls.length < 2) {
    throw new Error('至少需要两帧才能合成动态 GIF。');
  }

  let size = Math.max(120, Math.min(720, Math.round(width)));
  let colorTarget = COLOR_BY_QUALITY[quality] || COLOR_BY_QUALITY.high;
  let dither = DITHER[quality] || DITHER.high;
  // 每帧显示时长 = 停留时间 + 该帧帧率对应时长，贴近 FFmpeg 的 concat+fps 效果
  const delayCs = Math.max(2, Math.round((holdMs + 1000 / fps) / 10));
  const pages = 0;
  let blob = null;

  for (let pass = 0; pass < 4; pass += 1) {
    onProgress(0.1 + pass * 0.05);
    const frames = await collectFrames(urls, size);
    onProgress(0.35);
    const palette = buildPalette(frames, Math.min(colorTarget, 256), frames.length > 4 ? 3 : 1);
    onProgress(0.5);
    const indexed = [];
    for (let i = 0; i < frames.length; i += 1) {
      indexed.push(mapToIndexes(frames[i], size, palette, dither));
      onProgress(0.5 + (0.45 * (i + 1)) / frames.length);
    }
    blob = assembleGif({ size, palette, frames: indexed, delayCs });
    onProgress(0.97);
    if (!maxKb || blob.size <= maxKb * 1024) break;
    // 超限：逐级降尺寸与颜色，与后端策略保持一致
    size = Math.max(120, Math.round((size * 0.8) / 2) * 2);
    colorTarget = Math.max(32, Math.floor(colorTarget * 0.7));
    if (colorTarget <= 64) dither = DITHER.low;
  }

  onProgress(1);
  return {
    blob,
    bytes: blob.size,
    width: size,
    height: size,
    pages,
    underLimit: maxKb ? blob.size <= maxKb * 1024 : null
  };
}

/** 把若干图片文件/地址打包成 ZIP（ZIP32，store 模式，足够图片使用） */
export async function zipImages(entries) {
  const encoder = new TextEncoder();
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);      // 版本
    view.setUint16(6, 0x0800, true); // UTF-8 文件名
    view.setUint16(8, 0, true);       // store
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, dataBytes.length, true);
    view.setUint32(22, dataBytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, dataBytes);

    const record = new Uint8Array(46 + nameBytes.length);
    const recView = new DataView(record.buffer);
    recView.setUint32(0, 0x02014b50, true);
    recView.setUint16(4, 20, true);
    recView.setUint16(6, 20, true);
    recView.setUint16(8, 0x0800, true);
    recView.setUint16(10, 0, true);
    recView.setUint32(16, crc, true);
    recView.setUint32(20, dataBytes.length, true);
    recView.setUint32(24, dataBytes.length, true);
    recView.setUint16(28, nameBytes.length, true);
    recView.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    central.push(record);

    offset += local.length + dataBytes.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

/** 把远程图片取回为 Blob（同源或允许跨域的地址可用） */
export async function fetchAsBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`获取图片失败（${res.status}）`);
  return res.blob();
}
