// giflite.js（方案 C）单元测试。
// 浏览器 API 用 sharp + 最小 Canvas 桩替代：真实解码 PNG，真实走量化/抖动/LZW/GIF 组装。
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// ---- 最小 DOM 桩：只实现 giflite 用到的那几个方法 ----
class FakeContext {
  constructor(width, height) { this.width = width; this.height = height; this.changed = false; }
  clearRect() { this.changed = true; }
  drawImage(image, dx, dy, dw, dh) {
    this.dx = dx; this.dy = dy; this.dw = dw; this.dh = dh;
    this.source = image;
    this.changed = true;
  }
  getImageData(x, y, width, height) {
    if (!this.source) throw new Error('getImageData 之前必须先 drawImage');
    // 用 sharp 做最近邻重采样，模拟浏览器 drawImage 的铺满行为
    const { data, info } = this.source.resized;
    const target = Buffer.alloc(width * height * 4);
    for (let ty = 0; ty < height; ty += 1) {
      // drawImage 可能超出画布（居中裁切），只取落在画布内的部分
      const sy = Math.floor(((ty - this.dy) * info.height) / this.dh);
      for (let tx = 0; tx < width; tx += 1) {
        const sx = Math.floor(((tx - this.dx) * info.width) / this.dw);
        const to = (ty * width + tx) * 4;
        if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) {
          target[to] = target[to + 1] = target[to + 2] = 255;
          target[to + 3] = 0; // 未被覆盖的像素保持透明，交给白底合成逻辑处理
          continue;
        }
        const from = (sy * info.width + sx) * info.channels;
        target[to] = data[from];
        target[to + 1] = data[from + 1];
        target[to + 2] = data[from + 2];
        target[to + 3] = info.channels === 4 ? data[from + 3] : 255;
      }
    }
    return { data: target, width, height };
  }
}

class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this._ctx = null; }
  getContext() {
    if (!this._ctx) this._ctx = new FakeContext(this.width, this.height);
    return this._ctx;
  }
}

/** 生成一张纯色（可带方块）的 PNG data URL，并在桩里挂上已解码像素 */
async function makeImage(hex, size = 400) {
  const png = await sharp({
    create: { width: size, height: size, channels: 3, background: hex }
  }).png().toBuffer();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const image = {
    width: size,
    height: size,
    crossOrigin: '',
    decoding: '',
    set src(value) { this._src = value; queueMicrotask(() => this.onload && this.onload()); },
    get src() { return this._src; }
  };
  image.resized = { data, info };
  return { image, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}

/** 一次性装好全局桩，并把 dataURL 映射到预解码的图片对象 */
async function withDom(images) {
  const pool = new Map();
  for (const item of images) pool.set(item.dataUrl, item.image);

  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = new FakeCanvas();
      return canvas;
    }
  };
  globalThis.Image = class {
    constructor() {
      const self = this;
      return new Proxy(self, {
        set(target, key, value) {
          if (key === 'src') {
            const hit = pool.get(value);
            if (!hit) { queueMicrotask(() => self.onerror && self.onerror()); return true; }
            target.resized = hit.resized;
            target.width = hit.width;
            target.height = hit.height;
            queueMicrotask(() => self.onload && self.onload());
            return true;
          }
          target[key] = value;
          return true;
        }
      });
    }
  };
}

const giflite = await import('../public/giflite.js');
const FIXTURES = await Promise.all(['#ff5c8a', '#6ee7a8', '#7aa2ff'].map((c) => makeImage(c)));
await withDom(FIXTURES);
const URLS = FIXTURES.map((f) => f.dataUrl);

/** 解析 GIF 头与逻辑屏幕尺寸，并统计图像描述符数量（= 实际帧数） */
function parseGif(buffer) {
  const sig = buffer.subarray(0, 6).toString('latin1');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  let frames = 0;
  let hasGce = false;
  for (let i = 0; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9) hasGce = true;
    if (buffer[i] === 0x2c) {
      // 0x2C 也可能出现在压缩数据里，粗筛后要求后面的宽高都在画布内
      const w = buffer.readUInt16LE(i + 5);
      const h = buffer.readUInt16LE(i + 7);
      if (w === width && h === height) frames += 1;
    }
  }
  return {
    sig,
    width,
    height,
    gct: Boolean(packed & 0x80),
    trailer: buffer[buffer.length - 1] === 0x3b,
    frames,
    hasGce
  };
}

test('合成 GIF 产出合法 GIF89a，尺寸与帧数与输入一致', async () => {
  const result = await giflite.composeGif({ urls: URLS, width: 240 });
  const buffer = Buffer.from(await result.blob.arrayBuffer());
  const gif = parseGif(buffer);

  assert.equal(gif.sig, 'GIF89a');
  assert.equal(gif.width, 240);
  assert.equal(gif.height, 240);
  assert.equal(gif.frames, 3, '三张输入应产出三帧');
  assert.equal(gif.hasGce, true, '应包含图形控制扩展（帧延迟）');
  assert.equal(gif.trailer, true, 'GIF 必须以 0x3B 结尾');
  assert.equal(result.pages, 3);
  assert.equal(result.bytes, buffer.length);
  assert.equal(result.underLimit, null, '未设体积上限时 underLimit 应为 null');
});

test('少于两帧时明确报错，而不是产出坏文件', async () => {
  await assert.rejects(
    () => giflite.composeGif({ urls: [URLS[0]] }),
    /至少需要两帧/
  );
});

test('体积上限生效：超限时降分辨率直到命中目标', async () => {
  const loose = await giflite.composeGif({ urls: URLS, width: 320, quality: 'high' });
  // 用固定且明显低于原始体积的上限，确保必须经过降级才能达标
  const strictKb = 1;
  assert.ok(loose.bytes > strictKb * 1024, `前提：原始体积应超过 ${strictKb}KB，实际 ${loose.bytes} 字节`);

  const tight = await giflite.composeGif({ urls: URLS, width: 320, quality: 'high', maxKb: strictKb });

  assert.ok(tight.bytes <= strictKb * 1024, `应压到 ${strictKb}KB 以内，实际 ${tight.bytes} 字节`);
  assert.equal(tight.underLimit, true);
  assert.ok(tight.width < loose.width, `降级必须真的调低分辨率，旧 ${loose.width} 新 ${tight.width}`);
  // 降级后仍必须是合法 GIF，且帧数不变
  const gif = parseGif(Buffer.from(await tight.blob.arrayBuffer()));
  assert.equal(gif.sig, 'GIF89a');
  assert.equal(gif.frames, 3);
  assert.equal(gif.width, tight.width);
});

test('进度回调落在 0..1 且以 1 收尾', async () => {
  const seen = [];
  await giflite.composeGif({ urls: URLS, width: 160, onProgress: (r) => seen.push(r) });
  assert.ok(seen.length >= 3, '应多次上报进度');
  assert.equal(seen[seen.length - 1], 1);
  // 多轮回退时 pass 之间允许回退（重新降级重算），但单轮内必须单调不减
  assert.ok(seen.every((r) => r >= 0 && r <= 1), `进度必须在 0..1 之间，实际 ${seen.join(',')}`);
});

test('体积上限命中后不再继续降级，避免无谓画质损失', async () => {
  // 给一个足够宽松的上限，首轮就应达标，分辨率保持原样
  const result = await giflite.composeGif({ urls: URLS, width: 320, quality: 'high', maxKb: 4096 });
  assert.equal(result.width, 320, '首轮达标时不应降分辨率');
  assert.equal(result.underLimit, true);
});

test('分镜 ZIP 条目名会清洗非法字符，避免路径穿越', async () => {
  const blobs = [
    { name: '../../etc/passwd.png', blob: new Blob([Buffer.from('a')]) },
    { name: 'a/b\\c:d*e?f"g<h>i|j.png', blob: new Blob([Buffer.from('b')]) },
    { name: '', blob: new Blob([Buffer.from('c')]) }
  ];
  const zip = Buffer.from(await (await giflite.zipImages(blobs)).arrayBuffer());

  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'ZIP 本地文件头签名');
  const text = zip.toString('latin1');
  assert.ok(!text.includes('../'), '不得出现向上穿越路径');
  assert.ok(!text.includes('a/b'), '斜杠必须被替换');
  assert.ok(text.includes('frame.png'), '空文件名应回落到 frame.png');
});
