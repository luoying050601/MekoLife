# YmetaLife

个人自用的 2D 多人在线空间，基于 Phaser 3、Socket.IO 和 LiveKit。
支持角色移动、文字聊天、房间语音及屏幕共享。

## 本地运行

需要 Node.js 20+ 和 npm。

```bash
npm ci
cp .env.example .env
npm run dev:all
```

打开 http://localhost:5173，后端默认使用 3000 端口。
语音和屏幕共享需要在 `.env` 中配置你自己的 `LIVEKIT_URL`、
`LIVEKIT_API_KEY` 和 `LIVEKIT_API_SECRET`。
`VITE_SOCKET_URL` 仅在前后端分开部署时按需设置。

## 构建与运行

```bash
npm run build
NODE_ENV=production npm start
```

生产模式由后端提供 `dist/` 静态文件。也可使用仓库中的 Dockerfile 构建。

## 部署到 Vercel 和 Render

仓库已包含 Vercel 与 Render 配置。Render 会在部署时安装构建依赖、构建前端并由后端同源托管，因此直接打开 Render 服务根地址（例如 `https://ymetalife-server.onrender.com/`）就是完整游戏页面；`/health` 只用于检查服务状态。若修改了 `render.yaml`，请在 Render Blueprint 页面执行 Manual sync 并等待部署成功。

也可将同一 GitHub 仓库导入 Vercel，Framework Preset 选择 Vite，并添加环境变量 `VITE_SOCKET_URL`，值为 Render 服务地址（不要在末尾加 `/`）。重新部署 Vercel 后，也可通过 Vercel 分配的 `*.vercel.app` 地址访问前端。自定义前端域名需要在 Render 的 `CORS_ORIGINS` 中添加完整来源，例如 `https://game.example.com`，多个来源用逗号分隔。

Render 免费实例空闲时会休眠，首次访问可能需要等待唤醒。多人移动和文字聊天无需额外密钥；语音与屏幕共享需在 Render 环境变量中设置 `LIVEKIT_URL`、`LIVEKIT_API_KEY` 和 `LIVEKIT_API_SECRET`。

注意：公开部署前请先确认 [来源与许可记录](PROVENANCE.md) 中提到的原项目代码及素材授权。该记录说明相关授权尚未确认。

## 提交到个人仓库

提交源代码、`package-lock.json`、配置模板及文档。
`.env`、`node_modules/`、`dist/`、`.vercel/` 和 `.wrangler/` 已排除。
首次推送前确认远程地址指向自己的仓库，并检查暂存区没有密钥。

## 开发文档

- [代码结构](docs/code-overview.md)
- [地图编辑](docs/map-authoring-guide.md)
- [文字聊天](docs/chat-guide.md)
- [语音](docs/voice-guide.md)
- [屏幕共享](docs/screenshare-guide.md)

## 来源与许可

本项目以 AbistLife 代码为基础整理，用于个人自用开发。
原项目代码的权利归属和使用授权尚待确认；本仓库未新增开源许可证。
第三方组件与素材的许可证独立适用，详见 [来源说明](PROVENANCE.md)。
