# 音声ガイド

MekoLife の音声は **LiveKit SFU のみ** です。WebRTC mesh のコードはリポジトリに残していますが、実行パスでは使いません。

---

## 1. 全体像

```
┌─────────────┐     Socket.IO（位置・チャット・入退室）     ┌─────────────┐
│  プレイヤー A  │ ◄──────────────────────────────────────► │  サーバー     │
└──────┬──────┘   POST /api/livekit-token                 └──────▲──────┘
       │                                                          │
       │              音声（LiveKit SFU）                           │
       └──────────────────────► LiveKit ◄─────────────────────────┘
                              プレイヤー B
```

- 音声メディアは **LiveKit** が中継する。Socket.IO は JWT 発行と部屋同期だけ。
- ポリシー: `src/game/voice/voiceConstants.ts` の `getVoiceBackendPolicySummary()` → `voice_policy=livekit_only`
- `.env` の `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` が **必須**。未設定時は `Voice: set LIVEKIT_* on server`

### 部屋ごとの動作

| 場所 | バックエンド | 実装 |
|------|-------------|------|
| corridor | なし | `VoiceChatRouter` が LiveKit を leave |
| room1〜room4 | LiveKit SFU | `LiveKitVoiceSession`（ルーム名 `mekolife_<roomId>`） |

タイル部屋を越えると `onLocalTileRoomChanged()` が **leave → 新しい roomId で join** する。人数による WebRTC 切替はしない。

---

## 2. 「部屋」の 2 つの意味（重要）

| 種類 | 決め方 | 用途 |
|------|--------|------|
| **タイル部屋** | マップ上の座標 `(x, y)` から `room1`〜`room4` または `corridor` を判定 | **どの LiveKit ルームに入るか** |
| **Socket 部屋** | `join_room` でサーバーに送った `roomId` | チャット等の転送範囲 |

通常、プレイヤーがタイル部屋の境界を越えると `applyLocalRoomChange()` が走り、**Socket 部屋も同じ ID に更新** される（`transport.joinRoom()` を再送）。

- **廊下（corridor）** では LiveKit に接続しない。
- タイル部屋 `room1` などに入った瞬間、`onLocalTileRoomChanged()` 経由でその部屋の LiveKit ルームへ再接続する。

---

## 3. 接続が始まるタイミング

### 3.1 ゲーム開始時（自動）

1. `MainScene` 起動 → Socket 接続 → `join_room`
2. サーバーから `current_players` を受信（初回 roster）
3. 最大 **4 秒** 待ってから `VoiceChatRouter.autoJoinVoiceMuted()`
4. 初期位置が廊下なら **接続しない**。部屋にいれば LiveKit に **ミュート** で参加

関連コード: `MainScene.bootVoiceAndDebug()`, `INITIAL_ROSTER_WAIT_MS = 4000`

### 3.2 廊下からタイル部屋へ歩いて入ったとき

- `applyLocalRoomChange()` → `VoiceChatRouter.onLocalTileRoomChanged()`
- LiveKit を leave したうえで、新しい `roomId` で join

### 3.3 タイル部屋から廊下へ出たとき

- 同上で leave。`voice_backend=none`

### 3.4 相手が別のタイル部屋へ移動したとき

- 相手は別の LiveKit ルームに入るため、こちらからは聞こえなくなる（SFU 側のルーム分離）

---

## 4. 関連コンポーネント一覧

| ファイル | 役割 |
|----------|------|
| `src/game/voice/LiveKitVoiceSession.ts` | LiveKit 接続・マイク・リモート音声 |
| `src/game/voice/VoiceChatRouter.ts` | LiveKit 参加、部屋移動、UI 連携 |
| `src/game/voice/voiceConstants.ts` | `livekit_only` ポリシー |
| `src/game/scenes/MainScene.ts` | roster 更新、部屋判定 |
| `server/index.js` | LiveKit JWT（`POST /api/livekit-token`） |
| `src/game/voice/WebRtcMeshVoiceSession.ts` | mesh 本体（**未使用・コード残置**） |

---

## 5. デバッグコマンド

画面右下 Debug Console で確認できる。

| コマンド | 内容 |
|----------|------|
| `voice` | 現在のバックエンドとステータス文言 |
| `vstatus` | ステータス行のみ |
| `vpeers` | 接続中 peer の一覧と状態 |
| `vinfo` | 詳細診断 |
| `count` | 同房参加者数 |
| `vpolicy` | `livekit_only` ポリシー表示 |
| `vmesh` | mesh 内部トレース（未使用パス） |

期待される `vpolicy` 出力: `voice_policy=livekit_only`

---

## 6. 接続しない・切れる典型パターン

| 状況 | 結果 |
|------|------|
| 廊下（corridor）にいる | 意図的に LiveKit 非接続 |
| `LIVEKIT_*` 未設定 | `voice_backend=none`、`Voice: set LIVEKIT_* on server` |
| マイク拒否 | LiveKit 参加失敗 |
| 別のタイル部屋にいる | 別 LiveKit ルームのため聞こえない |

---

## 7. 接続チェックリスト

同房で音声がつながるには、おおむね次をすべて満たす。

1. 両者とも **同じタイル部屋**（`room1`〜`room4`）にいる
2. サーバーに `LIVEKIT_*` が設定されている
3. 両者とも LiveKit に接続済み（`voice_backend=livekit`）
4. マイクを **unmute** している（初期状態はミュート）

---

## 8. 検証手順（1〜2 人）

人数しきい値の切替確認は不要。LiveKit が 1 人から動くことを見る。

### 8.1 準備

1. `.env` に `LIVEKIT_*` を設定
2. `npm install` → `npm run dev:all`
3. `http://localhost:5173` を **2 つのブラウザ** で開く
4. Debug Console（画面右下）を表示

### 8.2 手順

| ステップ | 操作 | 期待 |
|----------|------|------|
| 1 | 両者が廊下 | `voice_backend=none`、共有ボタン無効 |
| 2 | 同じ `room1` に入る | `voice_backend=livekit`、`vpolicy=livekit_only` |
| 3 | 両方 unmute | 互いに聞こえる |
| 4 | 一方が `room2` へ | 聞こえなくなる |
| 5 | 再び同じ部屋 | 聞こえる |

LiveKit 未設定時は部屋に入っても `voice_backend=none` と設定エラー表示。WebRTC mesh には落ちない。

### 8.3 合格基準

- 1〜2 人で `livekit` になる（人数を 5 まで増やさなくてよい）
- 廊下では接続しない
- 部屋を越えると相手に聞こえない
- `vpolicy` が `voice_policy=livekit_only`
- UI フリーズやコンソールエラーがない

### 8.4 トラブルシューティング

| 症状 | 対処 |
|------|------|
| `voice_backend=none`（部屋にいる） | `.env` の `LIVEKIT_*` とサーバー再起動 |
| 部屋を移動しても古い部屋の声が残る | `onLocalTileRoomChanged` の再接続を確認 |
| Debug Console が見えない | ページ下部の `<pre>` を確認。F12 で JS エラー確認 |

---

## 関連ドキュメント

- [code-overview.md](./code-overview.md) — プロジェクト全体の通信スキーマ
- [screenshare-guide.md](./screenshare-guide.md) — 画面共有（同じ LiveKit only ポリシー）
