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
