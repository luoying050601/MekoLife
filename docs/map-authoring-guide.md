# Tiled マップ制作ガイド

このプロジェクトの Phaser 3 側は `map/MekoLifeMapData.json` を読み込み、Tiled のレイヤー名とオブジェクト名を使って描画・衝突・部屋判定を行います。

## 基本設定

- マップのタイルサイズは `32 x 32 px` にする。
- Tileset は `16 x 16 px` 元画像を2倍化した `32 x 32 px` タイル画像を使う。
- マップは `infinite: false` の固定サイズで書き出す。
- Tileset 名は `roguelikeSheet_transparent_32`、画像は `roguelikeSheet_transparent_32.png` を使う。
- Phaser 側の移動・衝突はワールド座標のピクセル単位で処理されるため、マップを広げる場合もタイル数を増やすだけでよい。

## 必須レイヤー

| レイヤー名 | 種別 | 用途 |
| --- | --- | --- |
| `background` | Tile Layer | 床・装飾など、プレイヤーが歩ける見た目のベース |
| `Wall` | Tile Layer | 置いたタイルがすべて当たり判定になる壁・机・仕切り |
| `Rooms` | Object Layer | 部屋判定用の矩形。既存マップ互換で `MekoLifeMapData` の Object Layer も可 |

## 部屋オブジェクト

- Object Layer に矩形オブジェクトを置き、名前を `room1`、`room2`、`room3`、`room4` にする。
- 名前は大文字小文字を問わないが、コード上は `room1` のように小文字へ正規化される。
- 部屋同士の間は、プレイヤーが通れる廊下として矩形外にしておく。
- 現状は `room1`〜`room4` だけが音声・参加者リストの部屋として扱われ、それ以外は `corridor` になる。

## 拡張時のおすすめ

- 大きいマップにする場合は、現在の `80 x 44` タイルから横・縦へ増やしてよい。
- プレイヤーは `42 x 42 px` なので、通路幅は最低 `2` タイル、快適には `3` タイル以上にする。
- `Wall` レイヤーはタイル単位で連続配置すると、Phaser 側で矩形にまとめて軽く処理される。
- 壁にしたくない見た目の装飾は `Wall` に置かず、ベースレイヤーか別の装飾レイヤーに置く。
- 部屋を増やす場合は、Tiled の矩形追加だけでなく `MainScene` の `roomOrder` と通信・UI の部屋扱いも拡張する。

## 書き出し

- JSON は `map/MekoLifeMapData.json` にエクスポートする。
- 画像パスは JSON から見て `roguelikeSheet_transparent_32.png` のままにする。
- PR では Tiled から再エクスポートしたことを明記する。
