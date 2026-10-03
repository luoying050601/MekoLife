<!--
   title: YmetaLife コードリーディングガイド
  audience: 新規参加者 / コードを久しぶりに触る人 / エージェント補助
  revision: 2026-06-21
-->

# YmetaLife コードリーディングガイド

YmetaLife は **Phaser 3 製の 2D 多人数バーチャル空間** です。1 枚のタイルマップ上を全員が歩き回りながら、位置・チャット・画面共有・音声をリアルタイムに同期します。本書はリポジトリを初めて開く人が "どこから読むと迷わないか" を案内するための地図です。

## いきなり動かす

```
npm install
npm run dev:all
```

- フロントエンド: `http://localhost:5173`（名前入力 → ゲーム UI）
- バックエンド: `http://localhost:3000`（Socket.IO / LiveKit JWT API のみ。ゲーム UI はない）

Node.js 20+ を推奨。音声・画面共有には `.env.example` を `.env` にコピーし `LIVEKIT_*` を設定する（必須）。

## 頭に入れておく 2 つの「部屋」

このプロジェクトには **見た目上の全員共有マップ** と **メディア・チャットの部屋** が共存します。ここを混同するとバグ調査で迷子になります。

| 概念 | 決め方 | 影響範囲 |
| --- | --- | --- |
| **グローバルマップ** | 全プレイヤーが同じ Phaser ワールドに存在 | スプライト表示、`player_moved` は **全クライアントへ broadcast** |
| **タイル部屋** | 座標 `(x, y)` が Tiled の `room1`〜`room4` 矩形内か、`corridor` か | LiveKit ルーム、画面共有の視聴対象、チャット配信 |
| **Socket 部屋** | `join_room` の `roomId`（通常はタイル部屋 ID と同期） | サーバーがシグナリング・チャットを中継する範囲 |

プレイヤーがタイル部屋の境界を越えると `MainScene.applyLocalRoomChange()` が走り、**Socket 部屋も同じ ID に更新** されます（`transport.joinRoom()` を再送）。

- **廊下（corridor）**: LiveKit 非接続、画面共有不可、DM 候補は全オンラインプレイヤー
- **room1〜room4**: 同房メンバーだけが音声・画面共有・ルームチャットの対象
- 画面上部の `N participants` は **全オンライン人数**。Debug の `count` は **同房人数（自分含む）**

詳細は [voice-guide.md](./voice-guide.md) §2、[map-authoring-guide.md](./map-authoring-guide.md) を参照。

## アプリの層構造

クライアントは "UI 層 → ゲーム層 → 通信層 → メディア層" の 4 段で組まれています。下に行くほど外部依存（Socket.IO / WebRTC / LiveKit）が強くなります。

```
┌──────────────────── UI 層 (DOM) ────────────────────────────────┐
│  name-overlay   top-bar (room / count)   global-panel           │
│  game-layout    chat-panel   bottom-bar (voice / share)         │
│  debug-console (+ debug-room-panel)                             │
└─────────────────────────┬───────────────────────────────────────┘
                          │ events / DOM bind
                          ▼
┌──────────────────── ゲーム層 (Phaser) ──────────────────────────┐
│  MainScene ──── PlayerEntity                                    │
│      │  Tiled map / 衝突 / 座標 → タイル部屋判定                  │
└──────┼──────────────────────────┬────────────────────────────────┘
       │                          │
       ▼                          ▼
┌──── 通信層 ─────────────┐  ┌──────── メディア層 ─────────────────┐
│ SocketTransport         │  │ VoiceChatRouter                     │
│ serverOrigin            │◀─┤   └─ LiveKitVoiceSession            │
│ applyApiBaseQuery (?api=)│  │ ScreenShareController               │
└─────────┬───────────────┘  │   └─ LiveKitScreenShareSession      │
          │                  │   (WebRTC mesh / P2P / FrameRelay は未使用) │
          │                  └─────────┬───────────────────────────┘
          │ websocket                  │
          ▼                            ▼
   ┌──────────────┐             ┌──────────────┐
   │ Express +    │             │ LiveKit SFU  │
   │ Socket.IO    │             │ (room1〜4)   │
   │ (:3000)      │             └──────────────┘
   └──────────────┘
```

## ディレクトリの読み方

`src/` 以下は **責務単位でフォルダ分離** されています。最初に追いかけるのは `main.ts → MainScene.ts` の 2 ファイルで十分です。

```
src/
├─ main.ts                          # 入口。名前入力→Transport→Phaser→チャット UI
├─ style.css                        # 全 DOM UI の見た目
└─ game/
   ├─ devWarn.ts                    # 開発時 warn（本番では no-op）
   ├─ scenes/MainScene.ts           # ★ 中核。マップ・移動・部屋・統合
   ├─ entities/PlayerEntity.ts      # スプライト / 名前ラベル / 発話表示
   ├─ ui/ParticipantVolumeMenu.ts   # 参加者クリック時の音量スライダー
   ├─ network/
   │  ├─ SocketTransport.ts         # GameTransport の Socket.IO 実装
   │  ├─ serverOrigin.ts            # ?api= / VITE_SOCKET_URL / sessionStorage
   │  ├─ applyApiBaseQuery.ts       # 起動直後に ?api= を取り込む（import 順重要）
   │  └─ types.ts                   # Player / Chat / Signaling の型
   ├─ voice/
   │  ├─ VoiceChatRouter.ts         # LiveKit 参加/部屋移動、UI、音量
   │  ├─ voiceConstants.ts          # livekit_only ポリシー
   │  ├─ WebRtcMeshVoiceSession.ts  # P2P mesh（未使用・コード残置）
   │  ├─ LiveKitVoiceSession.ts
   │  ├─ VoiceSpeakingMonitor.ts    # 発話検知（LiveKit / mesh）
   │  ├─ LocalMutedMicMonitor.ts     # ミュート中の口パク検知
   │  ├─ voiceConnectionChecklist.ts # Debug `vcheck` 用条件一覧
   │  ├─ voicePeerDebug.ts          # Debug `vpeers` 表示整形
   │  └─ voiceMicIcons.ts           # ミュートボタン SVG
   ├─ screenshare/
   │  ├─ ScreenShareController.ts   # 発信 / 受信 / 許諾 / backend 切替
   │  ├─ LiveKitScreenShareSession.ts
   │  ├─ WebRTCSession.ts           # RTCPeerConnection 生成（音声と共用）
   │  ├─ ViewerOverlay.ts           # 共有映像オーバーレイ
   │  ├─ FrameRelay.ts              # 静止画フレーム fallback
   │  └─ types.ts
   └─ debug/
      ├─ DebugConsole.ts            # 画面右下の /command UI
      └─ DebugRoomEvents.ts         # タイル部屋遷移ログ
server/
└─ index.js                         # Express + Socket.IO + LiveKit JWT
map/
├─ MekoLifeMapData.json            # Tiled エクスポート
└─ roguelikeSheet_transparent_32.png
index.html                          # DOM 骨格（Phaser は #game-root のみ）
```

## ユースケース別フロー

### A. 入室してプレイヤーが表示されるまで

1. `main.ts` がフォーム送信を受け、`SocketTransport.connect()` で websocket を張る
2. Phaser 起動 → `MainScene` が初期座標から **タイル部屋**（多くは `corridor`）を判定
3. `transport.joinRoom({ roomId, name })` — `roomId` はタイル部屋 ID
4. サーバー (`server/index.js`) が `current_players` を返す（**他ルームのプレイヤーも含む全員** + `myRoomId`）
5. `MainScene` が全員の `PlayerEntity` を生成（グローバルマップ表示）
6. 最大 **4 秒** 待ってから `VoiceChatRouter.autoJoinVoiceMuted()`（`INITIAL_ROSTER_WAIT_MS`）

### B. 音声・画面共有（LiveKit only）

`VoiceChatRouter` と `ScreenShareController` は **LiveKit SFU のみ** を使う（`voice_policy=livekit_only`）。人数による WebRTC 切替はしない。

```
corridor          → LiveKit 非接続（音声なし・画面共有なし）
room1〜room4      → LiveKit（音声 + 画面共有）
タイル部屋を越える → leave → 新しい roomId で join
```

- LiveKit 接続・publish 失敗時は **WebRTC / FrameRelay にフォールバックしない**
- WebRTC mesh / P2P のファイルと Socket 信令は残してあるが、実行パスからは使わない
- `LIVEKIT_*` が未設定だと音声も画面共有も動かない

検証手順: [voice-guide.md](./voice-guide.md)、[screenshare-guide.md](./screenshare-guide.md)

### C. 画面共有のリクエスト → 受諾

1. 共有開始ボタン → `getDisplayMedia` → `ScreenShareController.startShare()`
2. 既に同房で共有中の人がいる場合、サーバーが `screen_share_request` を中継しダイアログ表示
3. 受け手は `deny / takeover / parallel` で応答
4. `LiveKitScreenShareSession` で publish / subscribe（LiveKit ルーム名は `screenshare_<roomId>`）
5. LiveKit 失敗時はエラー表示（P2P / FrameRelay は使わない）

### D. チャット・DM

- ルームチャット: 同房（Socket 部屋）への broadcast — 仕様は [chat-guide.md](./chat-guide.md)
- DM: `@名前` メンション。corridor では全オンライン、タイル部屋では同房メンバーが候補

## 通信スキーマの位置

Socket イベントの型は `src/game/network/types.ts` に集約されています。変更時は **このファイル + `SocketTransport.ts` + `server/index.js` の 3 か所を必ず同期** してください。

| プレフィックス | 用途 |
| --- | --- |
| `join_room` / `current_players` / `player_joined` / `player_left` | 入退室・部屋変更 |
| `player_move` / `player_moved` | 位置同期（**全クライアントへ** broadcast） |
| `chat_message` / `dm_message` | ルームチャット / DM |
| `screen_share_*` | 画面共有制御 + WebRTC シグナリング + FrameRelay |
| `voice_webrtc_*` | mesh 音声の WebRTC シグナリング |
| `voice_mic_state` / `voice_muted_speaking` | リモートのミュート状態・ミュート中発話表示 |

## サーバ側 (`server/index.js`) のポイント

- `GET /` — Socket/API 専用である旨の案内 HTML
- `GET /health` → `{ ok: true }`
- `POST /api/livekit-token` — `LIVEKIT_*` から JWT 生成。ルーム名 `mekolife_<roomId>`
- Socket CORS: `localhost:5173` / `127.0.0.1:*` / `*.trycloudflare.com`
- **メディア本体は流さない**。シグナリングとチャットのリレーのみ
- `join_room` 再送時: 旧 Socket 部屋から `player_left`、受信していた画面共有を `screen_share_stop_all`

## デバッグの入口

画面右下 Debug Console（`DebugConsole.ts`）。`/dinfo` または `help` で一覧。

| コマンド | 内容 |
| --- | --- |
| `count` | 同房参加者数 |
| `voice` / `connection` | バックエンド + ステータス + 接続者 |
| `vstatus` | ステータス行のみ |
| `vinfo` | 音声詳細診断 |
| `vpeers` / `vmesh` | peer 一覧 / mesh 内部 trace（mesh は未使用） |
| `vcheck` / `vconds` | WebRTC 接続条件チェック（mesh 用・未使用） |
| `vpolicy` | `livekit_only` |
| `mic` | バックエンド + ミュート状態 |
| `share` | 画面共有内部状態 |
| `room` / `self` / `pos` / `remotes` / `net` | 部屋・自分・座標・他者・Socket |
| `env` / `clearsocket` | ビルドモード / trycloudflare URL クリア |

タイル部屋遷移は Debug パネル左の **Room log**（`DebugRoomEvents.ts`）にも出ます。


## 関連ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [voice-guide.md](./voice-guide.md) | LiveKit 音声・部屋移動の検証 |
| [screenshare-guide.md](./screenshare-guide.md) | 画面共有 backend 切替の検証 |
| [chat-guide.md](./chat-guide.md) | チャット / DM 仕様 |
| [map-authoring-guide.md](./map-authoring-guide.md) | Tiled マップ・部屋矩形の作り方 |
