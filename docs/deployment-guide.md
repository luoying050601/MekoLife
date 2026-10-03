# YmetaLife 部署与线上配置笔记

本文记录当前项目的 GitHub、Render、Vercel 和 LiveKit 配置。推荐先使用 Render 的同源部署方式：一个 Render 服务同时提供游戏页面、HTTP API 和 Socket.IO。

## 当前线上地址

- 游戏页面：<https://ymetalife-server.onrender.com/>
- 后端健康检查：<https://ymetalife-server.onrender.com/health>，正常应返回 `{"ok":true}`。
- 可选 Vercel 前端：<https://ym-eta-life.vercel.app/>
- GitHub 仓库：<https://github.com/luoying050601/YMetaLife>

Render 免费实例空闲后会休眠，首次访问可能需要等待唤醒。

## 免费额度与适用范围

额度和服务条款会调整；以下按 **2026-10-03** 查阅的平台官方说明整理，部署前及使用中应以各平台 Dashboard 的 Usage/Billing 页面为准。

### Render Free

- Web Service 每个 workspace 每个日历月有 **750 小时** Free instance hours；同一 workspace 的免费服务共享额度。实例休眠时不消耗运行小时，耗尽后免费 Web Services 会暂停到下月额度重置。
- 免费 Web Service 在 **15 分钟没有入站 HTTP 请求或 WebSocket 消息**后会休眠；下次请求通常要等约一分钟唤醒。多人游戏在线时的 WebSocket 消息属于活动，但空房间时可能休眠。
- 免费规格约为 **0.1 CPU、512 MB 内存**；服务可能被重启，文件系统是临时的，不能把运行时写入的文件当持久数据保存。
- 出站带宽与构建流水线分钟数也计入 workspace 月度包含量。达到相应额度时，服务或新构建可能被暂停；在 Billing 页面查看实时用量和告警。
- Render 将免费服务定位为测试、爱好项目或预览用途，不建议承载有可用性承诺的正式生产业务。本项目当前房间/玩家状态保存在内存，服务重启后会清空。

官方说明：[Render Free instances](https://render.com/docs/free)。

### Vercel Hobby

- Hobby 是面向个人、非商业项目的免费方案。官方条款将 Hobby 使用限制为个人非商业用途。
- 官方额度包括每日最多 **100 次部署**、每次构建最长 **45 分钟**；另有按月计算的 CDN 请求、传输量等额度。超额后通常要等额度周期恢复，或升级方案。
- 本项目 Vercel 端只托管静态 Vite 前端；游戏 API、Socket.IO 和实时服务仍由 Render/LiveKit 承载，因此 Render 与 LiveKit 的额度才是多人在线和语音体验的主要约束。

官方说明：[Vercel Hobby plan](https://vercel.com/docs/plans/hobby) 和 [Vercel limits](https://vercel.com/docs/limits)。

### LiveKit Build 免费层

LiveKit 当前 Build 方案标示 **$0/月**，包含 **5,000 WebRTC participant minutes/月、100 并发连接、50 GB 下行传输**。这里的 participant minutes 按参与者连接时间累加，例如 2 人各连接 30 分钟约使用 60 participant minutes。超额规则、费用和功能以 LiveKit 控制台当前方案为准；LiveKit 额度与 Render/Vercel 额度相互独立。

官方方案：[LiveKit pricing](https://livekit.com/pricing)。

## Render：同源前后端（推荐）

1. 在 Render 导入 GitHub 仓库 `luoying050601/YMetaLife`，选择 `main` 分支和根目录的 `render.yaml` Blueprint。
2. Blueprint 创建的 Web Service 名称为 `ymetalife-server`。构建命令必须是 `npm ci --include=dev && npm run build`，启动命令是 `npm start`，健康检查路径是 `/health`。
3. `--include=dev` 很重要：Render 服务使用 `NODE_ENV=production`，普通 `npm ci` 会跳过 Vite 和 TypeScript，导致前端无法构建。
4. 等待 Render 状态变为 **Deploy succeeded**。日志应包含 `Static UI: dist/ (production)`。
5. 打开服务根地址 `https://ymetalife-server.onrender.com/`。它应显示 YmetaLife 名称输入页；进入后，页面、API 和 Socket.IO 都通过同一域名工作。

修改 `render.yaml` 后，在 Render Blueprint 页面执行 **Manual sync**，并确认最新部署成功。只推送代码不代表 Blueprint 中的服务配置一定已经同步。

## Vercel：独立部署前端（可选）

Render 根地址已能提供完整游戏。只有需要单独使用 Vercel 前端域名时，才需要此方式：

1. 将同一个 GitHub 仓库导入 Vercel，Framework Preset 使用 Vite，构建命令为 `npm run build`，输出目录为 `dist`。
2. 在 Vercel 项目的 Production 环境变量中设置 `VITE_SOCKET_URL`，值为 `https://ymetalife-server.onrender.com`，不要在末尾加 `/`。
3. 保存变量后重新部署。Vite 会在构建时把该公开 URL 写入前端资源，所以修改变量后必须重新构建部署。
4. Vercel 默认的 `*.vercel.app` 来源由后端允许。若改用自定义前端域名，在 Render 环境变量 `CORS_ORIGINS` 中填写完整来源，例如 `https://game.example.com`；多个来源用逗号分隔。变量变更后保存并等待 Render 重新部署。

`VITE_SOCKET_URL` 是公开的服务地址，不是密钥。不要把任何 LiveKit Secret 放进 Vercel 前端变量。

## LiveKit：语音与屏幕共享

多人移动、在线列表和文字聊天不需要 LiveKit。语音和屏幕共享需要一个 LiveKit Cloud 项目。将 LiveKit 控制台提供的以下值设置在 **Render Web Service → Environment**：

- `LIVEKIT_URL`：LiveKit WebSocket 地址，通常以 `wss://` 开头。
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_MAX_PARTICIPANTS`：每个 LiveKit 房间的最大连接数；当前设为 `5`。
- `LIVEKIT_TOKEN_TTL`：访问 token 有效期；当前设为 `6h`。

凭据位置：在 LiveKit Cloud 打开 `YMetaLife` 项目 → **Settings → API keys → Create key**。`LIVEKIT_URL` 从项目连接信息中复制；API Key 和 API Secret 成对使用。若旧 key 的 Secret 已无法查看，创建新 key 并将新的一对值更新到 Render；确认新部署正常后，再撤销不再使用的旧 key。

保存后等待 Render 重启/部署，再到游戏的 `room1` 至 `room4` 测试。走廊 `corridor` 不会加入 LiveKit 房间。麦克风默认静音，需要用户点击麦克风按钮并授权浏览器访问麦克风；屏幕共享也需要浏览器授权。

不要把 `LIVEKIT_API_SECRET` 发到聊天、提交到 GitHub，或填写在 Vercel。只在 Render 的私密环境变量设置中填写。

### 当前代码参数与一起确认的调整项

- JWT 有效期：由 Render `LIVEKIT_TOKEN_TTL` 设置，当前为 `6h`。这是浏览器拿到的访问凭据有效时间；LiveKit 会在已连接期间刷新 token，断线重连也会重新取 token。
- 每个 LiveKit 房间最多 `LIVEKIT_MAX_PARTICIPANTS=5` 个连接。房间配置在创建房间时生效；调高/调低后，已存在的房间可能仍沿用原限制，等房间关闭并重新创建后才应用新值。
- 发布权限按房间类型收紧：普通游戏房间只允许麦克风；`screenshare_` 房间只允许屏幕和屏幕音频。两类房间都允许订阅。
- LiveKit token 接口只接受地图使用的 `room1`–`room4` 和对应的 `screenshare_room1`–`screenshare_room4`，避免客户端请求任意 room ID 创建额外媒体房间。
- 目前没有账号登录/身份验证；公开玩家可为这些公开游戏房间请求 LiveKit token。每房间 5 人上限是连接数限制，不是账号身份验证。
- LiveKit 房间名：`mekolife_<roomId>`。地图 `room1` 至 `room4` 分别进入不同房间，走廊不连接 LiveKit。
- 客户端 Room 使用 `adaptiveStream: true`、`dynacast: true`；麦克风默认静音。Render `LIVEKIT_*` 变量只控制连接凭据，不控制房间人数或 token 时长。

当前一起确定的目标是：每个房间最多 5 个连接、语音与屏幕共享都开放、token 有效期 6 小时。若将来要调整，可在 Render Environment 修改 `LIVEKIT_MAX_PARTICIPANTS` 或 `LIVEKIT_TOKEN_TTL`；需要重新部署。不要只为“用满免费额度”放宽并发限制。当前公开试玩若没有登录验证，任何访问者都能申请加入其指定的房间，因此不适合存放私密会议内容。

## 验证与排错

- `/health` 返回 `{"ok":true}`：Render 后端进程可用；这不是游戏页面。
- Render 根地址标题应为 `YmetaLife`，页面应有名称输入框和「はじめる」按钮。
- 若 Render 根地址仍显示 “YmetaLife server” 的 API 提示页：检查 Build Command 是否包含 `npm ci --include=dev && npm run build`，再 Manual sync 并确认部署日志中的 `Static UI: dist/ (production)`。
- 若 Vercel 页面能打开但无法连接服务器：确认 Production 的 `VITE_SOCKET_URL` 值正确并重新部署；自定义域名还要检查 Render 的 `CORS_ORIGINS`。
- 若语音提示未配置：检查 Render 上的三个 `LIVEKIT_*` 变量是否齐全，然后重新部署服务。
- 浏览器首次打开或免费实例休眠后，可能需要等待 Render 唤醒；可先打开 `/health` 确认服务已启动，再刷新游戏页。

公开发布前也请查看 [来源与许可记录](../PROVENANCE.md)。
