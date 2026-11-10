# GIFMOJI · 表情动画工坊

根据参考图和一句提示词生成连贯分镜，再用 FFmpeg 合成适合微信使用的循环 GIF。

## 功能

- 上传一张 JPG / PNG / WebP 参考图，保持角色和画风一致。
- 通过 `hy-image-v3.5-preview` 生成 4 / 6 / 8 帧情绪分镜。
- 拖拽调整帧顺序，删除崩坏帧，导入自己的分镜继续合成。
- 输出 240 / 320 / 480 / 640 px 正方形 GIF，可调帧率、单帧停留时间和 256 / 128 / 64 色调色板。
- 可设置目标文件体积，自动降低尺寸与颜色进行压缩。
- 下载 GIF、全部分镜 ZIP，并附微信自定义表情导入步骤。

## 模型配置

页面中的「模型与接口」支持两种模式：

- **混元 TokenHub（默认）**：`https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation`，模型 `hy-image-v3.5-preview`。
- **自定义接口**：填写 Base URL（或完整接口地址）、模型 ID 和 API Key，并选择接口协议。

自定义接口支持：

| 协议 | 请求地址 | 参考图处理 |
|---|---|---|
| 混元 v3.5 | `/v35-generation` | `messages + image_url` |
| OpenAI 图像 | `/images/generations` 或 `/images/edits` | 有参考图时自动使用 multipart `/images/edits` |
| 聊天式生图 | `/chat/completions` | 参考图作为 `image_url` 传入 |
| 自动识别 | 根据 URL 路径判断 | 按判断结果处理 |

接口鉴权统一使用 `Authorization: Bearer <API Key>`。返回图片支持 `url`、`b64_json`、聊天消息图片和混元 `delta.image.url` 等常见格式。

配置的 Base URL、模型和协议会保存在浏览器本地；API Key 只保存在当前标签页，由页面显式发起请求。**服务端配置的 TokenHub 密钥只会用于默认官方地址，绝不会转发给自定义域名。**

## 运行

```bash
npm install
TOKENHUB_API_KEY=你的密钥 npm start
```

打开 `http://localhost:3000`。

未在服务端配置 `TOKENHUB_API_KEY` 时，页面会要求使用者填写自己的接口密钥。切换自定义模型时会清空已输入的密钥，避免密钥被误发到其他服务商。

可选环境变量：

| 变量 | 用途 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | `3000` |
| `TOKENHUB_API_KEY` | 服务端托管的默认 TokenHub 密钥 | 空 |
| `TOKENHUB_URL` | 默认 TokenHub 生图地址 | 官方地址 |
| `DEFAULT_IMAGE_MODEL` | 默认模型 ID | `hy-image-v3.5-preview` |
| `ALLOW_PRIVATE_MODEL_URL` | 是否允许连接本机/内网模型，仅开发测试使用 | `false` |
| `FFMPEG_PATH` | FFmpeg 可执行文件路径 | `ffmpeg` |
| `DATA_DIR` | 分镜和 GIF 临时目录 | 系统临时目录 |

## 两种部署形态

同一套前端支持两种运行方式，**按「有没有后端」自动切换引擎**，无需用户手动选择：

| 形态 | 页面来源 | 生图 | GIF 合成 | 页面标识 |
|---|---|---|---|---|
| **本地 / 后端托管**（本仓库 `npm start`、WorkBuddy 部署） | `server.js` 托管 `public/` | 服务端 `/api/generate` | **FFmpeg**（`palettegen` + `paletteuse`） | `LOCAL SERVER` · `已连接 · 同源` |
| **GitHub Pages（纯静态）** | `docs/` 目录 | 浏览器直连模型接口 | **方案 C：浏览器 Canvas + 自研 GIF 编码** | `GITHUB PAGES` · `未连接` |

判定依据只有一个：`api.isReady()`。有后端就用 FFmpeg，没有就用浏览器本地编码。合成按钮副标题与页脚会实时显示当前引擎（`FFMPEG 渲染` / `浏览器本地合成`，页脚 `FFMPEG` / `CANVAS`）。

静态托管时仍然可以填「服务连接」里的后端地址，填了并连通就升级为 FFmpeg，不填也能完整出图。

### 两种引擎的差异

| | FFmpeg（后端） | 方案 C（浏览器） |
|---|---|---|
| 依赖 | 系统 FFmpeg ≥ 4.0 | 无，纯 JS |
| 调色板 | 全局 `palettegen stats_mode=diff` + `paletteuse diff_mode=rectangle` | 中位切分（median-cut）+ Floyd–Steinberg 抖动 |
| 缩放 | `scale` 双三次 | Canvas `drawImage` 重采样 |
| 体积控制 | FFmpeg 多轮参数搜索 | 逐步降分辨率与色数，命中目标体积即停 |
| 4 帧素材典型产物 | 240×240 / 约 16 KB / 7 帧 | 240×240 / 约 3 KB / 3 帧 |
| 适用 | 正式出图、追求画质 | 零部署、免后端、隐私不出浏览器 |

> 关于为什么不用 ffmpeg.wasm：`@ffmpeg/core@0.12.10` 的 wasm 有 31 MB，且**不含** `palettegen` / `paletteuse` / `dither` / `filter_complex`，无法复刻当前画质，所以静态版走了自研编码器这条路线。

### 跨域

后端已开放 CORS（`Access-Control-Allow-Origin`、`OPTIONS` 预检 204），静态站点可直接调用。生产环境建议用 `CORS_ORIGIN` 白名单限制来源：

```bash
CORS_ORIGIN=https://thinkingstill.github.io npm start
```

### 同步两份前端

`docs/` 是 GitHub Pages 用的副本，只允许两处差异：`index.html` 的 `data-env="static"` 与相对路径。改完 `public/` 后执行：

```bash
node scripts/sync-docs.mjs   # 自动复制 + 改写路径，并生成 .nojekyll
```

`npm test` 会逐文件比对 `docs/` 与 `public/` 的 `app.js`、`backend.js`、`giflite.js`、`directgen.js`、`styles.css`，不一致直接失败；CI 里还有一道同等校验，会当场重新生成并检查工作区是否干净，忘了同步会在流水线上直接拦下。

## 开发与测试

```bash
npm install
npm run test:unit   # 方案 C 编码器单测：量化 / 抖动 / LZW / GIF 合法性 / 体积降级 / ZIP 命名
npm test            # 冒烟测试：上传分镜 → FFmpeg 合成 GIF → 校验下载
npm run test:all    # 两者串行执行，CI 等价
npm start           # 本地启动
```

冒烟测试会自行拉起一个仅监听 `127.0.0.1` 的服务实例，使用随机临时目录，**不需要任何模型密钥**，因此可以安全地在 CI 中运行。

单元测试用 `sharp` 真实解码 PNG，并自带一个最小 Canvas 桩来模拟浏览器环境，所以 `giflite.js` 能在 Node 里跑真实的量化与编码路径，而不是只做字符串断言。

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main`、发起 PR 或手动触发时运行：

| 任务 | 内容 |
|---|---|
| `test` | Node 20 / 22 矩阵：安装 FFmpeg → `npm ci` → 依赖审计 → 语法检查 → `docs/` 同步校验 → 前端编码器单测 → 冒烟测试 |
| `secret-scan` | 扫描全部提交历史中的 PAT / API Key / sharecode 等疑似密钥，并禁止提交 `.env`、依赖与构建产物 |
| `ci-status` | 汇总结果，可作为分支保护的必过检查 |

CI 只做校验与测试，**不包含部署步骤**：本项目在 WorkBuddy 上的托管产物与访问地址不会进入代码库。

### 公共访问入口

GitHub Actions 本身只提供结果页面，**不提供可编程访问的运行入口**。需要对外展示的状态，用下面两种公开地址：

| 用途 | 地址 |
|---|---|
| 全部运行记录 | `https://github.com/thinkingstill/gifmoji-studio/actions` |
| 该工作流历史 | `https://github.com/thinkingstill/gifmoji-studio/actions/workflows/ci.yml` |
| 官方状态徽章（SVG） | `https://github.com/thinkingstill/gifmoji-studio/actions/workflows/ci.yml/badge.svg` |
| 自定义状态徽章 | `https://raw.githubusercontent.com/thinkingstill/gifmoji-studio/main/.ci-status/badge.svg` |
| 机器可读状态 | `https://raw.githubusercontent.com/thinkingstill/gifmoji-studio/main/.ci-status/status.json` |

后两项由 `.github/workflows/badge.yml` 在每次 CI 结束后写入，字段包括 `conclusion`、`runNumber`、`runUrl`、`commit`、`updatedAt`。

**限制**：仓库为 Public，上述页面无需登录即可查看，但 CI 日志同样公开；Actions 运行记录目前只保留约 90 天。

## 自定义接口安全

服务端会代理自定义模型地址，因此启用了以下限制：

- 自定义接口必须使用 HTTPS，本机和内网测试需显式开启 `ALLOW_PRIVATE_MODEL_URL=true`。
- 域名解析到回环、内网、链路本地、保留地址或云元数据地址时直接拒绝。
- 禁止携带用户名密码的 URL，禁止跟随重定向。
- 自定义接口不能使用平台配置的 TokenHub 密钥。

## 技术说明

- 前端为原生 HTML / CSS / JavaScript，移动端和桌面端响应式布局。
- 服务端为 Node.js + Express，生图任务异步执行，前端轮询进度。
- 图片使用 Sharp 统一缩放并转为 PNG；GIF 采用 FFmpeg `palettegen + paletteuse` 两步调色板流程，避免直接编码造成严重偏色。
- 分镜文件保留 24 小时，之后自动清理。
- WorkBuddy 普通网页托管不会自动注入客户端生图额度，因此网页运行时需要 TokenHub API Key。

## 微信导入

下载 GIF 后保存到手机相册，在微信聊天框点击笑脸 → 心形表情面板 → 添加 → 从相册选择。不同微信版本对文件体积的要求可能不同；提示过大时使用 240 px、均衡画质和 1 MB 体积上限重新合成。
