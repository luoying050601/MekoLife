# MekoLife

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
