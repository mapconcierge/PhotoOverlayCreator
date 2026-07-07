# PhotoOverlayCreator

Google Earth Pro の「写真オーバーレイ（PhotoOverlay）編集」に近い UI/UX をウェブ上で再現し、
ストリートレベル画像を 3D 地図空間に配置・調整して、KML / KMZ の `PhotoOverlay` を
生成・再編集できる完全静的ウェブアプリケーションです。GitHub Pages 上でそのまま動作します。

## DEMO Site
https://mapconcierge.github.io/PhotoOverlayCreator/


## 主な機能

- 画像（JPEG / PNG / WebP / HEIF / TIFF）の読み込みと 3D 地図上への配置
- Exif GPS の自動読み取り → 撮影地点へ地図移動・初期配置
- 2:1（Equirectangular）画像の自動判定 → `<shape>sphere</shape>`（球面パノラマ）出力の選択
- KML `PhotoOverlay` の座標・姿勢モデルを区別して編集
  - `<Camera>`：カメラ位置・姿勢（longitude / latitude / altitude / heading / tilt / roll / altitudeMode）
  - `<Point>`：PhotoOverlay 自体の配置位置
  - `<ViewVolume>`：leftFov / rightFov / topFov / bottomFov / near
    （UI では Horizontal / Vertical FOV + 縦横比固定 + 詳細設定で個別編集）
- **写真の 3D 表示**：Google Earth Pro と同様に、写真をカメラ前方の 3D 空間に
  立てて表示（WebGL カスタムレイヤ。heading / tilt / roll / 非対称 FOV を反映）
- **写真ビュー**：画像読込・KMZ 読込時に KML の Camera 視点へ自動移動し、
  写真を画面中央に表示（「📷 写真ビュー」ボタンでいつでも再現）
- 地図上での編集：Point / Camera マーカーのドラッグ、地図クリックでの Point 設定、
  視錐台（heading / tilt / roll ラベル付き）と写真表示のリアルタイム更新
- **ミニ地図（直下視）**：左ペインに選択中 PhotoOverlay の Camera / Point / FOV 範囲を
  真上から表示。マーカーのドラッグで位置を簡易調整可能
- **ストリートビュー連携**：Google Street View / Mapillary を地図下部に表示し、
  地上視点で写真の位置合わせが可能（「視点を Camera へ適用」で位置・方位・傾きを反映）
- KML / KMZ（doc.kml + images/）の生成・ダウンロード
- 既存 KMZ の読み込み → PhotoOverlay の復元・再編集・再出力（複数対応、並び替え・複製・削除）
- JPEG への GPS Exif（GPSLatitude / GPSLongitude / GPSAltitude ほか）書き込み
- 設定の JSON 保存・読み込み
- 3D 地形（raster-dem、誇張率変更可）・陰影・3D 建物・航空写真レイヤ切替

## ファイル構成

```text
/
├── index.html   … UI（3ペイン構成）と CDN 読込
├── style.css    … スタイル（レスポンシブ対応）
├── main.js      … アプリ本体（素の JavaScript、ビルド不要）
└── README.md
```

## ローカル実行方法

ES 環境やビルドは不要ですが、`file://` 直接オープンでは一部機能（fetch 等）が
制限されるため、簡易 HTTP サーバー経由でのアクセスを推奨します。

```bash
# リポジトリのルートで
python3 -m http.server 8080
# → http://localhost:8080 をブラウザで開く
```

Node.js の場合:

```bash
npx serve .
```

## GitHub Pages への公開手順

1. このリポジトリを GitHub へ push する
2. リポジトリの **Settings → Pages** を開く
3. **Source** で `Deploy from a branch` を選択
4. **Branch** で `main` / `/(root)` を選択して **Save**
5. 数分後に `https://<ユーザー名>.github.io/PhotoOverlayCreator/` で公開される

すべて CDN 読込・静的ファイルのみで構成されているため、ビルドステップや
GitHub Actions の設定は不要です。

## 使用ライブラリ（CDN・バージョン固定）

| ライブラリ | バージョン | 用途 | CDN |
|---|---|---|---|
| MapLibre GL JS | 5.6.0 | 3D 地図描画（roll 対応）・ミニ地図 | unpkg |
| JSZip | 3.10.1 | KMZ の生成・解凍 | cdnjs |
| piexifjs | 1.0.6 | JPEG Exif GPS 書き込み | jsDelivr |
| ExifReader | 4.23.3 | 画像メタデータ（Exif GPS 等）読み取り | jsDelivr |
| Mapillary JS | 4.1.2 | Mapillary ストリートビュー表示 | unpkg |
| Google Maps JavaScript API | weekly | Google Street View 表示（利用時のみ動的ロード） | Google |

## ストリートビュー連携

ヘッダーの「ストリートビュー」からプロバイダを選択すると、地図下部に
ストリートビューパネルが表示されます。地上視点を確認しながら
「視点を Camera へ適用」ボタンで、その位置・方位・傾きを選択中
PhotoOverlay の Camera に反映できます（高度は地上 2.5m / relativeToGround）。

| プロバイダ | 必要なもの | 備考 |
|---|---|---|
| Google Street View | Google Maps JavaScript API キー | [Google Cloud Console](https://console.cloud.google.com/) で取得（課金設定が必要）。キーなしでも「Googleマップで開く」で新しいタブに表示可能 |
| Mapillary | アクセストークン（無料） | [Mapillary Developers](https://www.mapillary.com/dashboard/developers) でクライアントトークンを取得 |

- キー・トークンはブラウザの `localStorage` にのみ保存され、それぞれの API 以外へ送信されません
- 本体アプリは引き続きキー不要で動作します（ストリートビューはオプション機能）

## 使用データソース

| データ | 提供元 | 備考 |
|---|---|---|
| ベクトル地図 | [OpenFreeMap](https://openfreemap.org/)（Liberty スタイル） | キー不要 |
| 航空写真 | Esri World Imagery | ArcGIS Online タイルサービス |
| 空中写真（日本） | 国土地理院 全国最新写真（シームレス） | 地理院タイル |
| ミニ地図（直下視） | [OpenStreetMap](https://www.openstreetmap.org/) 標準レイヤ（OSM Carto） | [タイル利用ポリシー](https://operations.osmfoundation.org/policies/tiles/)に従うこと |
| 地形 DEM | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/)（Terrarium 形式） | Mapterhorn Terrain 互換の raster-dem。キー不要・CORS 対応 |

## KML / KMZ 出力仕様

- 名前空間は KML 2.2（`<kml xmlns="http://www.opengis.net/kml/2.2">`）
- 各 PhotoOverlay は `name` / `description` / `visibility` / `color`（不透明度）/
  `Camera` / `Icon` / `rotation` / `ViewVolume` / `Point` / `shape` を持つ
- FOV は `leftFov / rightFov / bottomFov / topFov / near` として出力
  （UI の Horizontal / Vertical FOV は対称な left/right・top/bottom に変換）
- 球面パノラマは `<shape>sphere</shape>`、通常画像は `<shape>rectangle</shape>`
- KMZ の構造:

```text
output.kmz
├── doc.kml
└── images/
    ├── image-001.jpg
    ├── image-002.jpg
    └── ...
```

- KML 内の `<Icon><href>` は KMZ 内の相対パス（`images/image-001.jpg`）を参照
- 複数 PhotoOverlay はすべて 1 つの KML / KMZ に出力
- 単体 KML 出力には画像は含まれません（Google Earth で開く場合は KMZ を推奨）

## Exif GPS 書き込みの対応状況

| 形式 | 読込・表示 | KML / KMZ 出力 | GPS Exif 書き込み |
|---|---|---|---|
| JPEG | ✅ | ✅ | ✅ 正式対応 |
| PNG | ✅ | ✅ | ❌（ボタン無効化・注意表示） |
| WebP | ✅ | ✅ | ❌ |
| HEIF / HEIC | △ ブラウザ依存 | ✅ | ❌ |
| TIFF | △ ブラウザ依存 | ✅ | ❌ |

- 書き込む GPS タグ: `GPSLatitude(Ref)` / `GPSLongitude(Ref)` / `GPSAltitude(Ref)`
- 座標は度・分・秒（Rational）形式に変換して記録します
- 書き込み結果は元ファイルを変更せず、新しい JPEG としてダウンロードされます
- 書き込まれる位置は選択中 PhotoOverlay の **Camera 位置**（撮影地点）です

## 既知の制約・未対応事項

- **Bing Aerial**：Microsoft Bing Maps のタイル利用には API キーとセッション管理が
  必須のため、静的サイトでは提供していません（UI 上は無効化して明示）。
- **Roll の地図反映**：MapLibre GL JS v5 の roll に対応していますが、ブラウザや
  バージョンにより反映されない場合、roll は KML 出力値として保持され、地図上では
  視錐台ラベル（`R:xx°`）による補助表示のみになります。
- **写真の 3D 表示**：写真は WebGL カスタムレイヤで「カメラ前方 dist（カメラ→
  Point 間の距離、無効時は near×2）の位置に立つ平面」として描画します。
  Google Earth の写真ビューと同様、写真は常に地形・建物より手前に表示されます
  （地図のニアクリップ面より手前に置かれるため、深度比較を行いません）。
- **tilt の同期範囲**：MapLibre の pitch は最大 85° のため、Camera の tilt が
  それを超える場合（例: 水平よりやや上向きの 90.85°）、写真ビューの視点は
  85° で頭打ちになります（KML 値は保持され、写真平面の姿勢には正しく反映）。
- **写真ビューとセンター標高**：写真ビュー時はカメラ高度を正確に再現するため
  「センター点の地面吸着」を一時解除します（ユーザーが地図操作を始めると復帰）。
- **Google Earth Pro の KMZ 互換**：`<Style><IconStyle>` 内のアイコンと写真本体の
  `<Icon>` を区別して解析します。`<gx:altitudeMode>relativeToSeaFloor` は
  relativeToGround として読み込みます（GE Pro の「地面より上」に相当）。
- **HEIF / HEIC・TIFF の表示**:ブラウザのデコーダ対応に依存します（Safari は
  HEIC 表示可、Chrome / Firefox は不可のことが多い）。読み込めない場合は
  JPEG / PNG への変換を促すエラーを表示します。
- **カメラ高度⇔ズームの換算**:地図同期時の高度はメルカトル近似による概算です。
- **JSON 設定の読み込み**:JSON には画像バイナリを含まないため、復元後に各
  PhotoOverlay の「画像を差し替え」から画像を再読込してください（KMZ には
  画像が同梱されるため、KMZ での保存を推奨）。
- **タイルの CORS**:企業ネットワーク等でタイル取得がブロックされた場合は
  画面右下に警告を表示します。別のベースマップへの切り替えをお試しください。
- **Google Street View**:Google Maps JavaScript API の利用規約・課金体系に
  従ってください。API キーには HTTP リファラ制限を設定することを推奨します。
- **Mapillary**:付近に投稿画像が無い場所では表示できません（検索範囲 約±300m）。
  Mapillary の視点情報（tilt）は画像により取得できない場合があり、その際は
  heading（方位）のみ Camera へ反映されます。
- Google Earth（デスクトップ版）は PhotoOverlay の表示に最も忠実です。
  Google Earth Web は PhotoOverlay の表示が限定的な場合があります。

## ライセンス

[LICENSE](LICENSE) を参照してください。
地図データ・タイルの利用にあたっては各提供元の利用規約に従ってください。
