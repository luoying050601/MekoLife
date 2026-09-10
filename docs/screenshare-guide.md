# 画面共有ガイド

MekoLife における **画面共有（LiveKit only）** のポリシーと検証手順です。WebRTC P2P / FrameRelay のコードは残していますが、実行パスでは使いません。

---

## 1. ポリシー概要

| 場所 | バックエンド | 送信トランスポート |
|------|--------------|--------------------|
| corridor | なし | 共有ボタン無効 |
| room1〜room4 | `livekit` | LiveKit SFU |

- 音声と同じ `voice_policy=livekit_only`
- LiveKit 接続・publish 失敗時は **エラー表示**（P2P / FrameRelay にフォールバックしない）
- 異なるルーム間では画面共有は **表示されない**（ルーム分離）
- `.env` の `LIVEKIT_*` が必須

関連コード:

| ファイル | 役割 |
|----------|------|
| `src/game/screenshare/ScreenShareController.ts` | 発信 / 受信 / 許諾フロー |
| `src/game/screenshare/LiveKitScreenShareSession.ts` | LiveKit publish / subscribe |
| `src/game/screenshare/ViewerOverlay.ts` | 共有映像の表示 |
| `src/game/screenshare/WebRTCSession.ts` / `FrameRelay.ts` | 未使用（コード残置） |

---

## 2. デバッグコマンド

Debug Console（画面右下）で使用:

| コマンド | 内容 |
|----------|------|
| `count` | ルーム参加者数 |
| `share` | 画面共有の内部ステータス / ポリシー / トランスポート |
| `voice` | 現在の音声バックエンド |
| `vpolicy` | `voice_policy=livekit_only` |

---

## 3. 検証の準備

1. `.env` に `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` を設定
2. `npm install` → `npm run dev:all`
3. `http://localhost:5173` を **2 つのブラウザ** で開く
4. Debug Console を表示

---

## 4. 検証シナリオ

### シナリオ A: 1〜2 人（LiveKit）

1. 両者が同じ `room1` に入る
2. Player1 が画面共有を開始
3. `count` / `share` を実行

**期待:**

- `share` が `preferred=livekit` と `policy=livekit_only`
- 共有中は `sender_transport=livekit`
- Player2 に映像が表示される

### シナリオ B: 廊下

1. 共有中のプレイヤーが corridor に出る（または共有前に廊下にいる）

**期待:**

- 廊下では共有開始ボタンが無効
- 視聴側に廊下からの共有は出ない

### シナリオ C: ルーム分離

1. Player1 は `room1`、Player2 は `room2`
2. Player1 が画面共有を開始

**期待:**

- `room2` に共有映像が表示されない

### シナリオ D: LiveKit 未設定

1. `LIVEKIT_*` を外して共有を試す

**期待:**

- エラー表示（P2P peer / FrameRelay が立たない）
- `share` の `rtc_peers=0`

### シナリオ E: 乗っ取り / 並行フロー（オプション）

同房で 2 人が共有したとき、request ダイアログと状態遷移（deny / takeover / parallel）が動くことを確認する。

---

## 5. 結果記録表

| ステップ | 状況 | 期待 preferred | 期待 sender transport | 実際 | ✓ |
|----------|------|----------------|----------------------|------|---|
| A1 | 同房 2 人 | livekit | livekit | | ☐ |
| B1 | 廊下 | none | — | | ☐ |
| C1 | 別ルーム | room-isolated | room-isolated | | ☐ |
| D1 | LIVEKIT 未設定 | error | none | | ☐ |

---

## 6. 合格基準

- 1〜2 人でも `preferred=livekit` / `sender_transport=livekit`
- `vpolicy` が `voice_policy=livekit_only`
- ルーム境界を越えた共有漏れがない
- LiveKit 失敗時に WebRTC へ落ちない
- `count` / `share` / `vpolicy` の出力が再現可能

---

## 関連ドキュメント

- [code-overview.md](./code-overview.md) — 画面共有フロー概要（ユースケース C）
- [voice-guide.md](./voice-guide.md) — 音声（同じ LiveKit only ポリシー）
