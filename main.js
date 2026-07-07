/* =============================================================================
 * PhotoOverlay Creator — main.js
 *
 * Google Earth Pro の「写真オーバーレイ編集」に近い UI/UX をウェブ上で再現し、
 * KML / KMZ の PhotoOverlay を生成・再編集する完全静的アプリケーション。
 *
 * 構成:
 *   1. 定数・ユーティリティ
 *   2. 通知（トースト）
 *   3. アプリ状態（データモデル）
 *   4. 地図ラッパー層（MapLibre → 将来の Mapbox 移行を考慮）
 *   5. ベースマップ・地形・建物
 *   6. PhotoOverlay の地図表示（マーカー・視錐台・画像面）
 *   7. UI ⇔ データモデル同期
 *   8. 画像読込・Exif GPS 読込・360°判定
 *   9. KML / KMZ 出力
 *  10. KMZ / KML 読込（再編集）
 *  11. JPEG Exif GPS 書き込み
 *  12. JSON 設定の保存・読込
 *  13. 初期化
 * ========================================================================== */

'use strict';

/* =============================================================================
 * 1. 定数・ユーティリティ
 * ========================================================================== */

const EARTH_RADIUS = 6378137; // WGS84 赤道半径 [m]
const DEFAULT_CENTER = { lng: 139.7671, lat: 35.6812 }; // 初期表示: 東京駅付近
const MAX_SAFE_PIXELS = 50_000_000; // これを超える画像は警告（約50MP）

// Exif GPS 書き込みを正式対応とする MIME タイプ
const EXIF_WRITABLE_TYPES = ['image/jpeg'];

const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** UUID を生成する（crypto.randomUUID 非対応環境のフォールバック付き） */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** XML 特殊文字をエスケープする */
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 始点から距離・方位で移動した地点を求める（平面近似・編集用途には十分）
 * @param {number} lng 経度 [deg]
 * @param {number} lat 緯度 [deg]
 * @param {number} dist 距離 [m]
 * @param {number} bearing 方位 [deg, 北=0 時計回り]
 * @returns {[number, number]} [lng, lat]
 */
function destination(lng, lat, dist, bearing) {
  const b = deg2rad(bearing);
  const dLat = (dist * Math.cos(b)) / EARTH_RADIUS;
  const dLng = (dist * Math.sin(b)) / (EARTH_RADIUS * Math.cos(deg2rad(lat)));
  return [lng + rad2deg(dLng), lat + rad2deg(dLat)];
}

/** Blob をファイルとしてダウンロードさせる */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ダウンロード開始後に解放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ファイルサイズを人が読める形式へ */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* =============================================================================
 * 2. 通知（トースト）
 * ========================================================================== */

/**
 * 画面右下へ通知を表示する。console にも出力する。
 * @param {string} message 表示メッセージ
 * @param {'info'|'success'|'warn'|'error'} type 種別
 */
function notify(message, type = 'info') {
  const logFn = { error: 'error', warn: 'warn' }[type] || 'log';
  console[logFn](`[PhotoOverlayCreator] ${message}`);

  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  const ttl = type === 'error' ? 9000 : 5000;
  setTimeout(() => el.remove(), ttl);
}

/* =============================================================================
 * 3. アプリ状態（データモデル）
 * ========================================================================== */

/**
 * PhotoOverlay の内部データモデルを新規作成する。
 * 仕様書 §12 のモデルに準拠。
 */
function createOverlayModel(partial = {}) {
  const base = {
    id: uuid(),
    name: 'PhotoOverlay',
    description: '',
    imageFile: null,      // File | Blob | null
    imageUrl: '',         // blob: URL
    imagePath: '',        // KMZ 内相対パス (images/xxx.jpg)
    imageWidth: 0,
    imageHeight: 0,
    imageType: '',
    isPanoCandidate: false, // 360°(2:1) 候補か

    shape: 'rectangle',
    rotation: 0,
    opacity: 1,
    visible: true,

    camera: {
      longitude: DEFAULT_CENTER.lng,
      latitude: DEFAULT_CENTER.lat,
      altitude: 50,
      altitudeMode: 'absolute',
      heading: 0,
      tilt: 90,
      roll: 0,
    },
    point: {
      longitude: DEFAULT_CENTER.lng,
      latitude: DEFAULT_CENTER.lat,
      altitude: 0,
      altitudeMode: 'absolute',
    },
    viewVolume: {
      leftFov: -30,
      rightFov: 30,
      topFov: 20,
      bottomFov: -20,
      near: 10,
    },
  };
  // 深いマージ（camera / point / viewVolume）
  const model = { ...base, ...partial };
  model.camera = { ...base.camera, ...(partial.camera || {}) };
  model.point = { ...base.point, ...(partial.point || {}) };
  model.viewVolume = { ...base.viewVolume, ...(partial.viewVolume || {}) };
  return model;
}

/** アプリ全体の状態 */
const state = {
  overlays: [],        // PhotoOverlay モデルの配列（表示順 = KML 出力順）
  selectedId: null,    // 選択中の overlay id
  overlayCounter: 0,   // 名前の連番用
  suppressMapSync: false, // UI→地図反映中に moveend で書き戻さないためのフラグ
};

function getSelected() {
  return state.overlays.find((o) => o.id === state.selectedId) || null;
}

/* =============================================================================
 * 4. 地図ラッパー層
 *
 * 将来的な Mapbox GL JS への移行を考慮し、アプリ本体は MapLibre API を直接
 * 触らず、この MapWrapper を介して地図を操作する。
 * ========================================================================== */

class MapWrapper {
  /**
   * @param {string} containerId 地図コンテナ要素の id
   */
  constructor(containerId) {
    this._containerId = containerId;
    this._map = null;
    this._markers = new Map(); // markerId -> maplibregl.Marker
    this._rollSupported = false;
  }

  /** 地図を初期化する。WebGL 非対応なら例外を投げる。 */
  init(styleSpec, center, zoom) {
    if (!MapWrapper.isWebGLSupported()) {
      throw new Error('このブラウザは WebGL に対応していないため、3D地図を表示できません。');
    }
    this._map = new maplibregl.Map({
      container: this._containerId,
      style: styleSpec,
      center: [center.lng, center.lat],
      zoom,
      pitch: 45,
      maxPitch: 85,
      // MapLibre v5 系は roll をサポートする
      rollEnabled: true,
      attributionControl: { compact: true },
    });
    this._map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this._map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    this._rollSupported = typeof this._map.setRoll === 'function';

    // タイル読み込みエラー（CORS 等）をユーザーへ通知（連発を防ぐため間引く）
    let lastTileErrorAt = 0;
    this._map.on('error', (e) => {
      const now = Date.now();
      if (now - lastTileErrorAt < 8000) return;
      lastTileErrorAt = now;
      const msg = e?.error?.message || '';
      if (/tile|source|fetch|load/i.test(msg)) {
        notify(`地図タイルの読み込みに失敗しました（CORS・ネットワーク制約の可能性）: ${msg}`, 'warn');
      }
    });
    return this;
  }

  static isWebGLSupported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  get raw() { return this._map; } // 逃げ道（内部専用）
  get rollSupported() { return this._rollSupported; }

  on(event, handler) { this._map.on(event, handler); return this; }
  once(event, handler) { this._map.once(event, handler); return this; }

  /** 地図カメラ状態の取得 { lng, lat, zoom, bearing, pitch, roll } */
  getCamera() {
    const c = this._map.getCenter();
    return {
      lng: c.lng,
      lat: c.lat,
      zoom: this._map.getZoom(),
      bearing: this._map.getBearing(),
      pitch: this._map.getPitch(),
      roll: this._rollSupported ? this._map.getRoll() : 0,
    };
  }

  /** 地図カメラ状態の設定（未指定項目は維持） */
  setCamera({ lng, lat, zoom, bearing, pitch, roll }, animate = false) {
    const opts = {};
    if (lng !== undefined && lat !== undefined) opts.center = [lng, lat];
    if (zoom !== undefined) opts.zoom = zoom;
    if (bearing !== undefined) opts.bearing = bearing;
    if (pitch !== undefined) opts.pitch = clamp(pitch, 0, 85);
    if (roll !== undefined && this._rollSupported) opts.roll = roll;
    animate ? this._map.easeTo(opts) : this._map.jumpTo(opts);
  }

  flyTo(lng, lat, zoom) {
    this._map.flyTo({ center: [lng, lat], zoom });
  }

  setStyle(styleSpec) { this._map.setStyle(styleSpec, { diff: false }); }

  addSource(id, spec) { if (!this._map.getSource(id)) this._map.addSource(id, spec); }
  removeSource(id) { if (this._map.getSource(id)) this._map.removeSource(id); }
  getSource(id) { return this._map.getSource(id); }
  addLayer(spec, before) { if (!this._map.getLayer(spec.id)) this._map.addLayer(spec, before); }
  removeLayer(id) { if (this._map.getLayer(id)) this._map.removeLayer(id); }
  hasLayer(id) { return !!this._map.getLayer(id); }
  setLayerVisibility(id, visible) {
    if (this._map.getLayer(id)) {
      this._map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
  setPaint(id, prop, value) {
    if (this._map.getLayer(id)) this._map.setPaintProperty(id, prop, value);
  }

  setTerrain(sourceId, exaggeration) {
    this._map.setTerrain(sourceId ? { source: sourceId, exaggeration } : null);
  }

  /** DOM 要素マーカーを追加（ドラッグ対応） */
  addMarker(markerId, lngLat, element, { draggable = false, onDragEnd = null } = {}) {
    this.removeMarker(markerId);
    const marker = new maplibregl.Marker({ element, draggable })
      .setLngLat(lngLat)
      .addTo(this._map);
    if (onDragEnd) marker.on('dragend', () => onDragEnd(marker.getLngLat()));
    this._markers.set(markerId, marker);
    return marker;
  }

  moveMarker(markerId, lngLat) {
    const m = this._markers.get(markerId);
    if (m) m.setLngLat(lngLat);
  }

  removeMarker(markerId) {
    const m = this._markers.get(markerId);
    if (m) { m.remove(); this._markers.delete(markerId); }
  }

  removeMarkersByPrefix(prefix) {
    for (const [id, m] of [...this._markers]) {
      if (id.startsWith(prefix)) { m.remove(); this._markers.delete(id); }
    }
  }
}

/** アプリ全体で共有する地図インスタンス */
let mapW = null;

/* =============================================================================
 * 5. ベースマップ・地形・建物
 * ========================================================================== */

// 地形 DEM（Terrarium 形式）。Mapterhorn Terrain 互換の raster-dem として
// AWS Open Data の Terrain Tiles を使用（キー不要・CORS 対応）。
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_ATTRIBUTION =
  'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles (Mapzen/AWS)</a>';

const BASEMAPS = {
  openfreemap: {
    label: 'OpenFreeMap ベクトル',
    // OpenFreeMap Liberty スタイル（キー不要）
    style: 'https://tiles.openfreemap.org/styles/liberty',
    vector: true,
  },
  esri: {
    label: 'Esri World Imagery',
    style: null, // ラスタスタイルは動的生成
    rasterTiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxzoom: 19,
    vector: false,
  },
  gsi: {
    label: '国土地理院 シームレス空中写真',
    style: null,
    rasterTiles: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院 全国最新写真（シームレス）</a>',
    maxzoom: 18,
    vector: false,
  },
  // Bing Aerial は Microsoft の API キーとセッション管理が必須のため、
  // 静的サイトでは提供しない（README 参照）。UI 上は無効化済み。
};

/** ラスタベースマップ用のスタイルオブジェクトを生成する */
function buildRasterStyle(def) {
  return {
    version: 8,
    // 記号フォント用 glyphs（symbol レイヤで必要）
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: [def.rasterTiles],
        tileSize: 256,
        maxzoom: def.maxzoom || 19,
        attribution: def.attribution || '',
      },
    },
    layers: [
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}

/** 現在の UI 設定（地形・陰影・建物） */
const mapSettings = {
  basemap: 'openfreemap',
  terrainEnabled: true,
  exaggeration: 1.0,
  hillshade: false,
  buildings: true,
};

/**
 * スタイル読み込み後に、DEM・地形・陰影・3D建物・PhotoOverlay 表示レイヤを
 * すべて再構築する。setStyle はカスタムレイヤを消すため、切替のたびに呼ぶ。
 */
function rebuildCustomLayers() {
  // --- DEM ソース（terrain 用と hillshade 用は別ソースにする） ---
  mapW.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: [DEM_TILES],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution: DEM_ATTRIBUTION,
  });
  mapW.addSource('hillshade-dem', {
    type: 'raster-dem',
    tiles: [DEM_TILES],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
  });

  applyTerrain();

  // --- 陰影（hillshade） ---
  mapW.addLayer({
    id: 'hillshade-layer',
    type: 'hillshade',
    source: 'hillshade-dem',
    paint: { 'hillshade-exaggeration': 0.4 },
  });
  mapW.setLayerVisibility('hillshade-layer', mapSettings.hillshade);

  // --- 3D 建物（ベクトルソースがある場合のみ） ---
  addBuildingsLayer();

  // --- PhotoOverlay 用ソース・レイヤ ---
  mapW.addSource('frustum-src', { type: 'geojson', data: emptyFC() });
  mapW.addLayer({
    id: 'frustum-fill',
    type: 'fill',
    source: 'frustum-src',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#4c8dff', 'fill-opacity': 0.15 },
  });
  mapW.addLayer({
    id: 'frustum-line',
    type: 'line',
    source: 'frustum-src',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#4c8dff', 'line-width': 2 },
  });
  mapW.addLayer({
    id: 'frustum-label',
    type: 'symbol',
    source: 'frustum-src',
    filter: ['==', ['get', 'kind'], 'label'],
    layout: {
      'text-field': ['get', 'text'],
      'text-size': 11,
      'text-anchor': 'top',
      'text-offset': [0, 0.6],
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#4c8dff',
      'text-halo-color': '#000000',
      'text-halo-width': 1,
    },
  });

  // 3D 写真ビルボード（WebGL カスタムレイヤ）
  mapW.addLayer(photoBillboardLayer);
  refreshMapVisuals();
}

/** 3D 建物レイヤを追加（OpenMapTiles 互換のベクトルソースを自動検出） */
function addBuildingsLayer() {
  const style = mapW.raw.getStyle();
  if (!style?.sources) return;
  const vectorSourceId = Object.keys(style.sources).find(
    (k) => style.sources[k].type === 'vector'
  );
  if (!vectorSourceId) return; // ラスタベースマップでは建物なし

  mapW.addLayer({
    id: 'poc-3d-buildings',
    type: 'fill-extrusion',
    source: vectorSourceId,
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-extrusion-color': '#9fa8b5',
      'fill-extrusion-height': [
        'coalesce', ['get', 'render_height'], ['get', 'height'], 8,
      ],
      'fill-extrusion-base': [
        'coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0,
      ],
      'fill-extrusion-opacity': 0.85,
    },
  });
  mapW.setLayerVisibility('poc-3d-buildings', mapSettings.buildings);
}

/** 地形の有効/無効・誇張率を反映する */
function applyTerrain() {
  try {
    mapW.setTerrain(mapSettings.terrainEnabled ? 'terrain-dem' : null,
      mapSettings.exaggeration);
  } catch (e) {
    console.warn('terrain 設定に失敗:', e);
  }
}

/** ベースマップを切り替える */
function setBasemap(key) {
  const def = BASEMAPS[key];
  if (!def) return;
  mapSettings.basemap = key;
  const styleSpec = def.vector ? def.style : buildRasterStyle(def);
  mapW.setStyle(styleSpec);
  // setStyle 後にカスタムレイヤを再構築
  mapW.once('style.load', () => {
    rebuildCustomLayers();
    const bTgl = document.getElementById('buildings-toggle');
    bTgl.disabled = !def.vector;
    bTgl.title = def.vector ? '' : '3D建物はベクトル地図（OpenFreeMap）選択時のみ利用できます';
    if (!def.vector) notify('このベースマップでは 3D 建物を表示できません（ベクトルタイル非搭載）', 'info');
  });
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

/* =============================================================================
 * 6. PhotoOverlay の地図表示（マーカー・視錐台・画像面）
 * ========================================================================== */

/** Camera マーカー・Point マーカーを含む地図表示を全 overlay 分更新する */
function refreshMapVisuals() {
  if (!mapW?.raw?.isStyleLoaded) return;

  // --- マーカー ---
  const liveIds = new Set(state.overlays.map((o) => o.id));
  // 消えた overlay のマーカーを削除
  mapW.removeMarkersByPrefix('gone-'); // no-op プレースホルダ
  for (const ov of state.overlays) {
    upsertOverlayMarkers(ov);
  }
  // state に無い id のマーカーを掃除
  for (const [mid] of mapW._markers) {
    const ovId = mid.replace(/^(cam|pt)-/, '');
    if (!liveIds.has(ovId)) mapW.removeMarker(mid);
  }

  // --- 視錐台 GeoJSON ---
  const src = mapW.getSource('frustum-src');
  if (src) src.setData(buildFrustumFC());

  // --- 3D 写真ビルボード（テクスチャ元画像を準備して再描画を要求） ---
  for (const ov of state.overlays) ensureImageElement(ov);
  mapW.raw.triggerRepaint();

  // --- ミニ地図（左ペイン） ---
  updateMiniMap();
}

/** 1 overlay 分の Camera / Point マーカーを作成・更新する */
function upsertOverlayMarkers(ov) {
  const camId = `cam-${ov.id}`;
  const ptId = `pt-${ov.id}`;
  const dimClass = ov.visible ? '' : ' dim';
  const isSelected = ov.id === state.selectedId;

  // Camera マーカー（📷）
  if (!mapW._markers.has(camId)) {
    const el = document.createElement('div');
    el.className = 'marker-camera';
    el.textContent = '📷';
    el.title = `Camera: ${ov.name}（ドラッグでカメラ位置を移動）`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${ov.name} のカメラ位置マーカー`);
    el.addEventListener('click', (e) => { e.stopPropagation(); selectOverlay(ov.id); });
    mapW.addMarker(camId, [ov.camera.longitude, ov.camera.latitude], el, {
      draggable: true,
      onDragEnd: (lngLat) => {
        ov.camera.longitude = lngLat.lng;
        ov.camera.latitude = lngLat.lat;
        selectOverlay(ov.id);
        updateFormFromModel();
        refreshMapVisuals();
      },
    });
  } else {
    mapW.moveMarker(camId, [ov.camera.longitude, ov.camera.latitude]);
  }
  const camEl = mapW._markers.get(camId).getElement();
  camEl.className = `marker-camera${dimClass}`;
  camEl.style.outline = isSelected ? '2px solid #fff' : 'none';

  // Point マーカー（🖼 / 🌐）
  if (!mapW._markers.has(ptId)) {
    const el = document.createElement('div');
    el.className = 'marker-point';
    el.setAttribute('role', 'button');
    el.addEventListener('click', (e) => { e.stopPropagation(); selectOverlay(ov.id); });
    mapW.addMarker(ptId, [ov.point.longitude, ov.point.latitude], el, {
      draggable: true,
      onDragEnd: (lngLat) => {
        ov.point.longitude = lngLat.lng;
        ov.point.latitude = lngLat.lat;
        selectOverlay(ov.id);
        updateFormFromModel();
        refreshMapVisuals();
      },
    });
  } else {
    mapW.moveMarker(ptId, [ov.point.longitude, ov.point.latitude]);
  }
  const ptEl = mapW._markers.get(ptId).getElement();
  ptEl.className = `marker-point${ov.shape === 'sphere' ? ' sphere' : ''}${dimClass}`;
  ptEl.textContent = ov.shape === 'sphere' ? '🌐' : '🖼';
  ptEl.title = `Point: ${ov.name}（ドラッグで配置位置を移動）` +
    (ov.shape === 'sphere' ? ' / 球面パノラマ' : '');
  ptEl.setAttribute('aria-label', `${ov.name} の配置位置マーカー`);
}

/**
 * 全 overlay の視錐台（frustum）表現を GeoJSON で生成する。
 * - 扇形ポリゴン: heading ± hFov/2 の可視範囲
 * - 中心線: heading 方向
 * - ラベル: heading / tilt / roll の値を表示（tilt の視覚的確認用）
 * 視錐台の長さは tilt に応じて変化させ、tilt を平面上でも読み取れるようにする。
 */
function buildFrustumFC() {
  const features = [];
  for (const ov of state.overlays) {
    if (!ov.visible || ov.shape === 'sphere') continue; // sphere はマーカー表現のみ
    const { longitude: lng, latitude: lat, heading, tilt, roll, altitude } = ov.camera;
    const hFov = ov.viewVolume.rightFov - ov.viewVolume.leftFov;

    // 視錐台の描画長: 高度と tilt から概算（tilt 90°=水平で最大）
    const alt = Math.max(altitude, 5);
    const tiltFactor = clamp(Math.sin(deg2rad(clamp(tilt, 0, 90))), 0.1, 1);
    const len = clamp(alt * 2 * tiltFactor + 30, 40, 5000);

    // 扇形（fan）ポリゴン
    const steps = 16;
    const ring = [[lng, lat]];
    for (let i = 0; i <= steps; i++) {
      const b = heading - hFov / 2 + (hFov * i) / steps;
      ring.push(destination(lng, lat, len, b));
    }
    ring.push([lng, lat]);
    features.push({
      type: 'Feature',
      properties: { kind: 'fan', id: ov.id },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });

    // 中心線（heading 方向）
    features.push({
      type: 'Feature',
      properties: { kind: 'axis', id: ov.id },
      geometry: {
        type: 'LineString',
        coordinates: [[lng, lat], destination(lng, lat, len * 1.15, heading)],
      },
    });

    // ラベル（heading / tilt / roll）
    features.push({
      type: 'Feature',
      properties: {
        kind: 'label',
        id: ov.id,
        text: `H:${heading.toFixed(1)}°  T:${tilt.toFixed(1)}°  R:${roll.toFixed(1)}°`,
      },
      geometry: { type: 'Point', coordinates: destination(lng, lat, len * 0.55, heading) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/* ---- 3D 写真ビルボード（WebGL カスタムレイヤ） ---------------------------
 * Google Earth Pro と同様に、写真をカメラ前方の 3D 空間に「立てて」表示する。
 * MapLibre の image ソースは地表にドレープされてしまうため、カスタムレイヤで
 * heading / tilt / roll / 非対称 FOV を反映したテクスチャ付き平面を描画する。
 * ------------------------------------------------------------------------- */

/** overlayId -> { tex: WebGLTexture, url: string } */
const billboardTextures = new Map();

/** 3 次元ベクトルの外積 */
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Camera の altitudeMode を考慮した絶対高度[m]を返す（地形は best effort） */
function overlayCameraAbsAlt(ov) {
  const { altitudeMode, altitude, longitude, latitude } = ov.camera;
  if (altitudeMode === 'absolute') return altitude;
  let ground = 0;
  try {
    ground = mapW.raw.queryTerrainElevation([longitude, latitude]) || 0;
  } catch { /* 地形未ロード時は 0 */ }
  if (altitudeMode === 'clampToGround') return ground + 2;
  return ground + altitude; // relativeToGround
}

/** 画像面までの表示距離[m]: カメラ→Point の距離。無効なら near×2（最低 30m） */
function billboardDistance(ov) {
  const cam = ov.camera;
  const dLngM = (ov.point.longitude - cam.longitude) *
    Math.cos(deg2rad(cam.latitude)) * 111319.49;
  const dLatM = (ov.point.latitude - cam.latitude) * 111319.49;
  const d = Math.hypot(dLngM, dLatM);
  return d > Math.max(ov.viewVolume.near, 1) ? d : Math.max(ov.viewVolume.near * 2, 30);
}

/**
 * 写真平面の 4 頂点（Mercator 座標 + UV）を TRIANGLE_STRIP 順で生成する。
 * KML Camera 定義: heading=北から時計回り, tilt 0=直下・90=水平, roll=視線軸回転。
 */
function billboardVertices(ov) {
  const cam = ov.camera;
  const vv = ov.viewVolume;
  const dist = billboardDistance(ov);

  const h = deg2rad(cam.heading);
  const t = deg2rad(cam.tilt);
  const r = deg2rad(cam.roll);

  // ENU（東・北・上）基底での視線ベクトル
  const f = [Math.sin(h) * Math.sin(t), Math.cos(h) * Math.sin(t), -Math.cos(t)];
  const right0 = [Math.cos(h), -Math.sin(h), 0];
  const up0 = cross3(right0, f);
  // roll を視線軸回りの回転として適用
  const cr = Math.cos(r), sr = Math.sin(r);
  const right = right0.map((v, i) => v * cr + up0[i] * sr);
  const up = up0.map((v, i) => v * cr - right0[i] * sr);

  // 非対称 FOV に対応した画像面の端オフセット
  const L = dist * Math.tan(deg2rad(vv.leftFov));
  const R = dist * Math.tan(deg2rad(vv.rightFov));
  const T = dist * Math.tan(deg2rad(vv.topFov));
  const B = dist * Math.tan(deg2rad(vv.bottomFov));

  const corner = (side, vert) => [
    f[0] * dist + right[0] * side + up[0] * vert,
    f[1] * dist + right[1] * side + up[1] * vert,
    f[2] * dist + right[2] * side + up[2] * vert,
  ];

  const base = maplibregl.MercatorCoordinate.fromLngLat(
    [cam.longitude, cam.latitude], Math.max(overlayCameraAbsAlt(ov), 0));
  const s = base.meterInMercatorCoordinateUnits();
  // Mercator は y が南向きに増えるため north 成分は符号反転
  const toMerc = (v) => [base.x + v[0] * s, base.y - v[1] * s, base.z + v[2] * s];

  const tl = toMerc(corner(L, T));
  const tr = toMerc(corner(R, T));
  const bl = toMerc(corner(L, B));
  const br = toMerc(corner(R, B));

  // TRIANGLE_STRIP: TL, TR, BL, BR / UV は画像の上端が topFov 側
  return new Float32Array([
    tl[0], tl[1], tl[2], 0, 0,
    tr[0], tr[1], tr[2], 1, 0,
    bl[0], bl[1], bl[2], 0, 1,
    br[0], br[1], br[2], 1, 1,
  ]);
}

/** overlay の画像テクスチャを取得（未生成・URL 変更時は作り直す） */
function getBillboardTexture(gl, ov) {
  const cached = billboardTextures.get(ov.id);
  if (cached && cached.url === ov.imageUrl) return cached.tex;
  if (cached) {
    try { gl.deleteTexture(cached.tex); } catch { /* コンテキスト消失時は無視 */ }
    billboardTextures.delete(ov.id);
  }
  const img = ov._imgEl;
  if (!img || !img.complete || !img.naturalWidth) return null; // 読込中
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  billboardTextures.set(ov.id, { tex, url: ov.imageUrl });
  return tex;
}

/** overlay 削除時にテクスチャを解放する */
function disposeBillboardTexture(ovId) {
  const cached = billboardTextures.get(ovId);
  if (!cached) return;
  billboardTextures.delete(ovId);
  const gl = photoBillboardLayer._gl;
  if (gl) { try { gl.deleteTexture(cached.tex); } catch { /* 無視 */ } }
}

/** テクスチャ描画用の HTMLImageElement を overlay に用意する */
function ensureImageElement(ov) {
  if (!ov.imageUrl) { ov._imgEl = null; return; }
  if (ov._imgEl && ov._imgEl.src === ov.imageUrl) return;
  const img = new Image();
  img.onload = () => mapW?.raw?.triggerRepaint();
  img.src = ov.imageUrl;
  ov._imgEl = img;
}

/** MapLibre カスタムレイヤ本体（全 rectangle overlay を毎フレーム描画） */
const photoBillboardLayer = {
  id: 'photo-billboards',
  type: 'custom',
  renderingMode: '3d',

  onAdd(map, gl) {
    this._gl = gl;
    if (this._program) return; // setStyle 後も GL コンテキストは同一なので再利用
    const vsSource = `
      attribute vec3 a_pos;
      attribute vec2 a_uv;
      uniform mat4 u_matrix;
      varying vec2 v_uv;
      void main() {
        v_uv = a_uv;
        vec4 p = u_matrix * vec4(a_pos, 1.0);
        // 写真はカメラ近傍（地図のニアクリップ面より手前）に置かれることが
        // 多いため、z をクリップ範囲内へクランプして近面クリップを回避する。
        // 画面上の位置(x,y)は変わらない。
        p.z = clamp(p.z, -0.999 * p.w, 0.999 * p.w);
        gl_Position = p;
      }`;
    const fsSource = `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform float u_opacity;
      varying vec2 v_uv;
      void main() {
        // テクスチャは premultiplied alpha でアップロード済み
        gl_FragColor = texture2D(u_tex, v_uv) * u_opacity;
      }`;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('shader compile error:', gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    this._program = gl.createProgram();
    gl.attachShader(this._program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(this._program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(this._program);
    this._aPos = gl.getAttribLocation(this._program, 'a_pos');
    this._aUv = gl.getAttribLocation(this._program, 'a_uv');
    this._uMatrix = gl.getUniformLocation(this._program, 'u_matrix');
    this._uOpacity = gl.getUniformLocation(this._program, 'u_opacity');
    this._uTex = gl.getUniformLocation(this._program, 'u_tex');
    this._buf = gl.createBuffer();
  },

  render(gl, args) {
    // MapLibre v5 は projection data オブジェクト、v4 以前は行列を直接渡す
    const matrix = args?.defaultProjectionData?.mainMatrix || args;
    if (!matrix || !this._program) return;

    gl.useProgram(this._program);
    gl.uniformMatrix4fv(this._uMatrix, false, matrix);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
    gl.disable(gl.CULL_FACE);
    // Google Earth の写真ビューと同様、写真は常に地形・建物の手前に表示する
    // （近面クリップ回避のため z をクランプしており、深度比較は意味を持たない）
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.enableVertexAttribArray(this._aPos);
    gl.enableVertexAttribArray(this._aUv);
    gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(this._aUv, 2, gl.FLOAT, false, 20, 12);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._uTex, 0);

    for (const ov of state.overlays) {
      if (!ov.visible || ov.shape !== 'rectangle' || !ov.imageUrl) continue;
      const tex = getBillboardTexture(gl, ov);
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1f(this._uOpacity, ov.opacity);
      gl.bufferData(gl.ARRAY_BUFFER, billboardVertices(ov), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.depthMask(true);
  },
};

/**
 * 選択中 overlay のカメラ視点へ地図カメラを移動し、写真を画面中央に表示する
 * （Google Earth Pro の「写真ビュー」相当）。写真の FOV が地図の FOV より
 * 広い場合は、全体が収まるよう視線方向の後方へ下がる。
 */
function viewPhotoFromCamera(ov) {
  if (!ov) return;
  const cam = ov.camera;
  const vv = ov.viewVolume;
  const alt = overlayCameraAbsAlt(ov);
  const dist = billboardDistance(ov);

  // 写真平面の半サイズ[m]
  const halfH = dist * (Math.tan(deg2rad(vv.topFov)) - Math.tan(deg2rad(vv.bottomFov))) / 2;
  const halfW = dist * (Math.tan(deg2rad(vv.rightFov)) - Math.tan(deg2rad(vv.leftFov))) / 2;

  // 地図カメラの FOV（MapLibre 既定は垂直 約36.87°）
  let mapVFovDeg = 36.87;
  try { mapVFovDeg = mapW.raw.getVerticalFieldOfView?.() ?? 36.87; } catch { /* 既定値 */ }
  const canvas = mapW.raw.getCanvas();
  const vHalf = deg2rad(mapVFovDeg / 2);
  // キャンバスが極端に小さい・細長い場合（非表示タブ等）は既定のアスペクト比を使う
  let aspect = canvas.width / Math.max(canvas.height, 1);
  if (!Number.isFinite(aspect) || canvas.width < 100 || aspect < 0.4 || aspect > 5) {
    aspect = 16 / 9;
  }
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const needDist = Math.max(halfH / Math.tan(vHalf), halfW / Math.tan(hHalf)) * 1.2;
  const back = Math.max(0, needDist - dist);

  // 視線の逆方向へ back だけ後退（水平成分と高度成分に分解）
  const t = deg2rad(cam.tilt);
  const [lng2, lat2] = destination(
    cam.longitude, cam.latitude, -back * Math.sin(t), cam.heading);
  const alt2 = Math.max(alt + back * Math.cos(t), 2);

  state.suppressMapSync = true;
  try {
    // 地形有効時、MapLibre は既定でセンター標高を地面へ吸着させるため、
    // カメラ高度が意図せず変わる。写真ビュー中は吸着を解除し、
    // ユーザーが地図操作を始めたら元へ戻す。
    if (typeof mapW.raw.setCenterClampedToGround === 'function') {
      mapW.raw.setCenterClampedToGround(false);
      if (!state._reclampHooked) {
        state._reclampHooked = true;
        mapW.on('movestart', (e) => {
          if (e.originalEvent) { // ユーザー操作由来のときのみ
            try { mapW.raw.setCenterClampedToGround(true); } catch { /* 無視 */ }
          }
        });
      }
    }
    let opts;
    if (typeof mapW.raw.calculateCameraOptionsFromCameraLngLatAltRotation === 'function') {
      // MapLibre v5: カメラの位置・高度・姿勢から CameraOptions を直接計算
      opts = mapW.raw.calculateCameraOptionsFromCameraLngLatAltRotation(
        [lng2, lat2], alt2, cam.heading, clamp(cam.tilt, 0, 85), cam.roll);
    } else {
      // フォールバック: カメラ位置から視線方向の注視点を求めて計算
      const lookDist = Math.max(dist, 50);
      const [tlng, tlat] = destination(lng2, lat2, lookDist * Math.sin(t), cam.heading);
      const tAlt = alt2 - lookDist * Math.cos(t);
      opts = mapW.raw.calculateCameraOptionsFromTo(
        new maplibregl.LngLat(lng2, lat2), alt2, new maplibregl.LngLat(tlng, tlat), tAlt);
    }
    mapW.raw.jumpTo(opts);
  } catch (e) {
    console.warn('写真ビューへの移動に失敗、通常移動へフォールバック:', e);
    mapW.setCamera({
      lng: cam.longitude, lat: cam.latitude,
      zoom: altitudeToZoom(Math.max(alt, 50), cam.latitude),
      bearing: cam.heading, pitch: clamp(cam.tilt, 0, 85),
    });
  } finally {
    setTimeout(() => { state.suppressMapSync = false; }, 300);
  }
}

/* =============================================================================
 * 6.5 ミニ地図（左ペイン・二次元直下視）
 *
 * 選択中 PhotoOverlay の Camera / Point を真上から確認・ドラッグ移動できる
 * 小型の 2D 地図。FOV 範囲を扇形で塗りつぶし表示する。
 * ========================================================================== */

let miniMap = null;
const miniMarkers = { cam: null, pt: null };
let miniLastSelectedId = null;

/** 扇形（FOV）リングを生成する */
function fanRing(lng, lat, heading, hFov, len, steps = 20) {
  const ring = [[lng, lat]];
  for (let i = 0; i <= steps; i++) {
    ring.push(destination(lng, lat, len, heading - hFov / 2 + (hFov * i) / steps));
  }
  ring.push([lng, lat]);
  return ring;
}

/** ミニ地図用の FOV GeoJSON（選択中 overlay のみ） */
function miniFrustumFC(ov) {
  if (!ov || !ov.visible) return emptyFC();
  const { longitude: lng, latitude: lat, heading } = ov.camera;
  const dist = billboardDistance(ov);
  let ring;
  if (ov.shape === 'sphere') {
    // 球面パノラマは全方位なので円で表現
    const r = Math.max(dist * 0.6, 15);
    ring = [];
    for (let i = 0; i <= 32; i++) ring.push(destination(lng, lat, r, (360 * i) / 32));
  } else {
    const hFov = ov.viewVolume.rightFov - ov.viewVolume.leftFov;
    ring = fanRing(lng, lat, heading, hFov, Math.max(dist * 1.2, 30));
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [ring] } }],
  };
}

// ミニ地図の背景: OSM 標準レイヤ（OSM Carto）
const MINI_MAP_STYLE = {
  version: 8,
  sources: {
    'osm-carto': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm-carto', type: 'raster', source: 'osm-carto' }],
};

/** ミニ地図を初期化する（OSM 標準レイヤ・回転なしの直下視固定） */
function initMiniMap() {
  if (!MapWrapper.isWebGLSupported()) return;
  try {
    miniMap = new maplibregl.Map({
      container: 'mini-map',
      style: MINI_MAP_STYLE,
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: 14,
      pitch: 0,
      maxPitch: 0,          // 常に直下視
      dragRotate: false,
      attributionControl: { compact: true },
    });
    miniMap.touchZoomRotate.disableRotation();
    miniMap.keyboard.disableRotation?.();

    miniMap.on('load', () => {
      miniMap.addSource('mini-frustum', { type: 'geojson', data: emptyFC() });
      miniMap.addLayer({
        id: 'mini-frustum-fill', type: 'fill', source: 'mini-frustum',
        paint: { 'fill-color': '#4c8dff', 'fill-opacity': 0.3 },
      });
      miniMap.addLayer({
        id: 'mini-frustum-line', type: 'line', source: 'mini-frustum',
        paint: { 'line-color': '#4c8dff', 'line-width': 1.5 },
      });
      updateMiniMap();
    });

    // メイン地図と同じトグルで、ミニ地図クリックでも Point を設定できる
    miniMap.on('click', (e) => {
      if (!$('click-point-toggle').checked) return;
      const ov = getSelected();
      if (!ov) return;
      ov.point.longitude = e.lngLat.lng;
      ov.point.latitude = e.lngLat.lat;
      updateFormFromModel();
      afterModelChange();
    });
  } catch (e) {
    console.warn('ミニ地図の初期化に失敗:', e);
    miniMap = null;
  }
}

/** ミニ地図のマーカー・FOV・表示範囲を選択中 overlay に合わせて更新する */
function updateMiniMap() {
  if (!miniMap) return;
  const ov = getSelected();

  // FOV 扇形
  const src = miniMap.getSource('mini-frustum');
  if (src) src.setData(miniFrustumFC(ov));

  if (!ov) {
    miniMarkers.cam?.remove(); miniMarkers.cam = null;
    miniMarkers.pt?.remove(); miniMarkers.pt = null;
    miniLastSelectedId = null;
    return;
  }

  // Camera マーカー（初回のみ生成、ドラッグでモデル更新）
  if (!miniMarkers.cam) {
    const el = document.createElement('div');
    el.className = 'marker-camera mini';
    el.textContent = '📷';
    el.title = 'Camera（ドラッグで移動）';
    el.setAttribute('aria-label', 'ミニ地図のカメラ位置マーカー');
    miniMarkers.cam = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([ov.camera.longitude, ov.camera.latitude])
      .addTo(miniMap);
    miniMarkers.cam.on('dragend', () => {
      const sel = getSelected();
      if (!sel) return;
      const p = miniMarkers.cam.getLngLat();
      sel.camera.longitude = p.lng;
      sel.camera.latitude = p.lat;
      updateFormFromModel();
      afterModelChange();
      maybeSyncMapFromCamera(sel);
    });
  } else {
    miniMarkers.cam.setLngLat([ov.camera.longitude, ov.camera.latitude]);
  }

  // Point マーカー
  if (!miniMarkers.pt) {
    const el = document.createElement('div');
    el.className = 'marker-point mini';
    el.title = 'Point（ドラッグで移動）';
    el.setAttribute('aria-label', 'ミニ地図の配置位置マーカー');
    miniMarkers.pt = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat([ov.point.longitude, ov.point.latitude])
      .addTo(miniMap);
    miniMarkers.pt.on('dragend', () => {
      const sel = getSelected();
      if (!sel) return;
      const p = miniMarkers.pt.getLngLat();
      sel.point.longitude = p.lng;
      sel.point.latitude = p.lat;
      updateFormFromModel();
      afterModelChange();
    });
  } else {
    miniMarkers.pt.setLngLat([ov.point.longitude, ov.point.latitude]);
  }
  const ptEl = miniMarkers.pt.getElement();
  ptEl.textContent = ov.shape === 'sphere' ? '🌐' : '🖼';
  ptEl.className = `marker-point mini${ov.shape === 'sphere' ? ' sphere' : ''}`;

  // 選択が変わったときのみ両マーカーが収まるよう表示範囲を調整
  if (miniLastSelectedId !== ov.id) {
    miniLastSelectedId = ov.id;
    const b = new maplibregl.LngLatBounds();
    b.extend([ov.camera.longitude, ov.camera.latitude]);
    b.extend([ov.point.longitude, ov.point.latitude]);
    miniMap.fitBounds(b, { padding: 50, maxZoom: 17, duration: 300 });
  }
}

/* =============================================================================
 * 6.6 ストリートビュー（Google Street View / Mapillary）
 *
 * 地上視点で写真の位置合わせを行うための表示。Google Street View は
 * Google Maps JavaScript API キー、Mapillary はアクセストークンが必要
 * （いずれもユーザー入力・localStorage 保存。詳細は README）。
 * ========================================================================== */

const streetView = {
  provider: 'none',
  googleKey: localStorage.getItem('poc-google-api-key') || '',
  googlePano: null,
  googleLoading: null, // ロード中 Promise
  mapillaryToken: localStorage.getItem('poc-mapillary-token') || '',
  mapillaryViewer: null,
};

/** コンテナへプレースホルダ文言を表示する */
function svPlaceholder(html) {
  $('streetview-container').innerHTML =
    `<div class="sv-placeholder">${html}</div>`;
}

/** 既存のビューアを破棄してコンテナを空にする */
function destroyStreetViewers() {
  if (streetView.mapillaryViewer) {
    try { streetView.mapillaryViewer.remove(); } catch { /* 無視 */ }
    streetView.mapillaryViewer = null;
  }
  streetView.googlePano = null; // Google は DOM 破棄のみで良い
  $('streetview-container').innerHTML = '';
}

/** プロバイダ切替（none | google | mapillary） */
function setStreetViewProvider(provider) {
  streetView.provider = provider;
  const panel = $('streetview-panel');
  const centerPane = $('center-pane') || document.getElementById('center-pane');

  destroyStreetViewers();
  $('sv-google-config').hidden = provider !== 'google';
  $('sv-mapillary-config').hidden = provider !== 'mapillary';
  panel.hidden = provider === 'none';
  centerPane.classList.toggle('with-sv', provider !== 'none');
  mapW?.raw?.resize();

  if (provider === 'google') {
    if (streetView.googleKey) {
      initGoogleStreetView();
    } else {
      svPlaceholder('Google Street View の表示には Google Maps JavaScript API キーが必要です。<br>' +
        '上の欄にキーを入力して「適用」を押してください。<br>' +
        'キーなしの場合は「Googleマップで開く」で新しいタブに表示できます。');
    }
  } else if (provider === 'mapillary') {
    if (streetView.mapillaryToken) {
      initMapillaryViewer();
    } else {
      svPlaceholder('Mapillary の表示にはアクセストークン（無料）が必要です。<br>' +
        '<a href="https://www.mapillary.com/dashboard/developers" target="_blank" rel="noopener">Mapillary Developers</a> ' +
        'でクライアントトークンを取得し、上の欄に入力して「適用」を押してください。');
    }
  }
}

/** Google Maps JavaScript API を動的ロードする */
function loadGoogleMapsApi(key) {
  if (window.google?.maps?.StreetViewPanorama) return Promise.resolve();
  if (streetView.googleLoading) return streetView.googleLoading;
  streetView.googleLoading = new Promise((resolve, reject) => {
    window.__pocGmapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
      encodeURIComponent(key) + '&v=weekly&loading=async&callback=__pocGmapsReady';
    s.onerror = () => {
      streetView.googleLoading = null;
      reject(new Error('Google Maps API の読み込みに失敗しました（キー・ネットワークを確認）'));
    };
    document.head.appendChild(s);
  });
  return streetView.googleLoading;
}

/** Google Street View を初期化して Camera 位置付近を表示する */
async function initGoogleStreetView() {
  const ov = getSelected();
  const lat = ov?.camera.latitude ?? mapW.getCamera().lat;
  const lng = ov?.camera.longitude ?? mapW.getCamera().lng;
  try {
    svPlaceholder('Google Street View を読み込み中…');
    await loadGoogleMapsApi(streetView.googleKey);
    $('streetview-container').innerHTML = '';
    streetView.googlePano = new google.maps.StreetViewPanorama(
      $('streetview-container'), {
        position: { lat, lng },
        pov: {
          heading: ov?.camera.heading ?? 0,
          pitch: ov ? clamp(ov.camera.tilt - 90, -90, 90) : 0,
        },
        addressControl: false,
        motionTracking: false,
        fullscreenControl: false,
      });
    notify('Google Street View を初期化しました。', 'success');
  } catch (e) {
    svPlaceholder('Google Street View の初期化に失敗しました。');
    notify(e.message, 'error');
  }
}

/** Mapillary Graph API で指定地点近傍の画像 ID を検索する */
async function findMapillaryImageId(lng, lat) {
  const d = 0.003; // 約 300m 四方
  const url = 'https://graph.mapillary.com/images?access_token=' +
    encodeURIComponent(streetView.mapillaryToken) +
    `&fields=id&bbox=${lng - d},${lat - d},${lng + d},${lat + d}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapillary API エラー（HTTP ${res.status}。トークンを確認してください）`);
  const data = await res.json();
  return data.data?.[0]?.id || null;
}

/** Mapillary ビューアを初期化して Camera 位置付近を表示する */
async function initMapillaryViewer() {
  if (typeof mapillary === 'undefined') {
    svPlaceholder('Mapillary JS の読み込みに失敗しました（CDN・ネットワークを確認）。');
    return;
  }
  const ov = getSelected();
  const lat = ov?.camera.latitude ?? mapW.getCamera().lat;
  const lng = ov?.camera.longitude ?? mapW.getCamera().lng;
  try {
    svPlaceholder('Mapillary 画像を検索中…');
    const imageId = await findMapillaryImageId(lng, lat);
    if (!imageId) {
      svPlaceholder('この付近に Mapillary 画像が見つかりませんでした。<br>' +
        '「Camera位置へ」ボタンで別の場所を再検索できます。');
      notify('付近に Mapillary 画像がありません（検索範囲 約±300m）。', 'warn');
      return;
    }
    $('streetview-container').innerHTML = '';
    streetView.mapillaryViewer = new mapillary.Viewer({
      accessToken: streetView.mapillaryToken,
      container: $('streetview-container'),
      imageId,
    });
    notify('Mapillary ビューアを初期化しました。', 'success');
  } catch (e) {
    svPlaceholder('Mapillary の初期化に失敗しました。');
    notify(e.message, 'error');
  }
}

/** ストリートビューを選択中 overlay の Camera 位置へ移動する */
async function moveStreetViewToCamera() {
  const ov = getSelected();
  if (!ov) { notify('先に PhotoOverlay を選択してください', 'warn'); return; }
  const { latitude: lat, longitude: lng } = ov.camera;

  if (streetView.provider === 'google') {
    if (!streetView.googlePano) { await initGoogleStreetView(); return; }
    streetView.googlePano.setPosition({ lat, lng });
    streetView.googlePano.setPov({
      heading: ov.camera.heading,
      pitch: clamp(ov.camera.tilt - 90, -90, 90),
    });
  } else if (streetView.provider === 'mapillary') {
    if (!streetView.mapillaryViewer) { await initMapillaryViewer(); return; }
    try {
      const imageId = await findMapillaryImageId(lng, lat);
      if (!imageId) { notify('付近に Mapillary 画像がありません。', 'warn'); return; }
      await streetView.mapillaryViewer.moveTo(imageId);
    } catch (e) {
      notify(e.message, 'error');
    }
  } else {
    notify('ヘッダーの「ストリートビュー」からプロバイダを選択してください。', 'info');
  }
}

/**
 * ストリートビューの現在視点（位置・方位・傾き）を Camera へ反映する。
 * 地上から見た正確な位置合わせに使う。
 */
async function applyStreetViewPose() {
  const ov = getSelected();
  if (!ov) { notify('先に PhotoOverlay を選択してください', 'warn'); return; }

  try {
    if (streetView.provider === 'google' && streetView.googlePano) {
      const pos = streetView.googlePano.getPosition();
      const pov = streetView.googlePano.getPov();
      if (!pos) { notify('Street View の位置を取得できません。', 'warn'); return; }
      ov.camera.latitude = pos.lat();
      ov.camera.longitude = pos.lng();
      ov.camera.heading = ((pov.heading % 360) + 360) % 360;
      ov.camera.tilt = clamp(90 + pov.pitch, 0, 180); // pitch 0=水平 → tilt 90
      ov.camera.altitude = 2.5; // 地上視点相当
      ov.camera.altitudeMode = 'relativeToGround';
    } else if (streetView.provider === 'mapillary' && streetView.mapillaryViewer) {
      const pos = await streetView.mapillaryViewer.getPosition();
      const pov = await streetView.mapillaryViewer.getPointOfView();
      ov.camera.latitude = pos.lat;
      ov.camera.longitude = pos.lng ?? pos.lon;
      if (Number.isFinite(pov?.bearing)) {
        ov.camera.heading = ((pov.bearing % 360) + 360) % 360;
      }
      if (Number.isFinite(pov?.tilt)) {
        ov.camera.tilt = clamp(90 + pov.tilt, 0, 180);
      }
      ov.camera.altitude = 2.5;
      ov.camera.altitudeMode = 'relativeToGround';
    } else {
      notify('ストリートビューが初期化されていません。', 'warn');
      return;
    }
    updateFormFromModel();
    afterModelChange();
    notify('ストリートビューの視点を Camera に反映しました。', 'success');
  } catch (e) {
    notify(`視点の取得に失敗しました: ${e.message}`, 'error');
  }
}

/** ストリートビュー関連 UI のイベントを設定する */
function setupStreetViewEvents() {
  $('google-api-key').value = streetView.googleKey;
  $('mapillary-token').value = streetView.mapillaryToken;

  $('sv-provider').addEventListener('change', (e) => setStreetViewProvider(e.target.value));

  $('google-key-apply').addEventListener('click', () => {
    streetView.googleKey = $('google-api-key').value.trim();
    localStorage.setItem('poc-google-api-key', streetView.googleKey);
    if (streetView.googleKey) initGoogleStreetView();
    else svPlaceholder('API キーを入力してください。');
  });

  $('google-open-external').addEventListener('click', () => {
    const ov = getSelected();
    const lat = ov?.camera.latitude ?? mapW.getCamera().lat;
    const lng = ov?.camera.longitude ?? mapW.getCamera().lng;
    const heading = ov?.camera.heading ?? 0;
    const pitch = ov ? clamp(ov.camera.tilt - 90, -90, 90) : 0;
    const url = 'https://www.google.com/maps/@?api=1&map_action=pano' +
      `&viewpoint=${lat},${lng}&heading=${heading.toFixed(1)}&pitch=${pitch.toFixed(1)}`;
    window.open(url, '_blank', 'noopener');
  });

  $('mapillary-token-apply').addEventListener('click', () => {
    streetView.mapillaryToken = $('mapillary-token').value.trim();
    localStorage.setItem('poc-mapillary-token', streetView.mapillaryToken);
    destroyStreetViewers();
    if (streetView.mapillaryToken) initMapillaryViewer();
    else svPlaceholder('アクセストークンを入力してください。');
  });

  $('sv-goto-camera').addEventListener('click', moveStreetViewToCamera);
  $('sv-apply-pose').addEventListener('click', applyStreetViewPose);
}

/* =============================================================================
 * 7. UI ⇔ データモデル同期
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

/** フォーム入力の定義: [inputId, sliderId|null, getter, setter] */
function forEachCameraBinding(cb) {
  const b = [
    ['cam-lat', null, (o) => o.camera.latitude, (o, v) => (o.camera.latitude = clamp(v, -90, 90))],
    ['cam-lng', null, (o) => o.camera.longitude, (o, v) => (o.camera.longitude = v)],
    ['cam-alt', null, (o) => o.camera.altitude, (o, v) => (o.camera.altitude = v)],
    ['cam-heading', 'cam-heading-slider', (o) => o.camera.heading, (o, v) => (o.camera.heading = ((v % 360) + 360) % 360)],
    ['cam-tilt', 'cam-tilt-slider', (o) => o.camera.tilt, (o, v) => (o.camera.tilt = clamp(v, 0, 180))],
    ['cam-roll', 'cam-roll-slider', (o) => o.camera.roll, (o, v) => (o.camera.roll = clamp(v, -180, 180))],
    ['pt-lat', null, (o) => o.point.latitude, (o, v) => (o.point.latitude = clamp(v, -90, 90))],
    ['pt-lng', null, (o) => o.point.longitude, (o, v) => (o.point.longitude = v)],
    ['pt-alt', null, (o) => o.point.altitude, (o, v) => (o.point.altitude = v)],
    ['fov-near', null, (o) => o.viewVolume.near, (o, v) => (o.viewVolume.near = Math.max(0, v))],
    ['fov-left', null, (o) => o.viewVolume.leftFov, (o, v) => (o.viewVolume.leftFov = clamp(v, -179, 0))],
    ['fov-right', null, (o) => o.viewVolume.rightFov, (o, v) => (o.viewVolume.rightFov = clamp(v, 0, 179))],
    ['fov-top', null, (o) => o.viewVolume.topFov, (o, v) => (o.viewVolume.topFov = clamp(v, 0, 179))],
    ['fov-bottom', null, (o) => o.viewVolume.bottomFov, (o, v) => (o.viewVolume.bottomFov = clamp(v, -179, 0))],
  ];
  b.forEach((x) => cb(...x));
}

let formUpdating = false; // モデル→フォーム反映中の change ループ防止

/** 選択中モデルの値を編集フォームへ反映する */
function updateFormFromModel() {
  const ov = getSelected();
  const form = $('edit-form');
  form.disabled = !ov;
  if (!ov) return;

  formUpdating = true;
  try {
    $('ov-name').value = ov.name;
    $('ov-desc').value = ov.description;
    $('ov-shape').value = ov.shape;
    $('ov-opacity').value = ov.opacity;
    $('ov-opacity-value').value = ov.opacity.toFixed(2);
    $('ov-visible').checked = ov.visible;
    $('ov-href').value = ov.imagePath;
    $('cam-altmode').value = ov.camera.altitudeMode;
    $('pt-altmode').value = ov.point.altitudeMode;

    forEachCameraBinding((inputId, sliderId, getter) => {
      const v = getter(ov);
      $(inputId).value = Number.isFinite(v) ? +v.toFixed(6) : '';
      if (sliderId) $(sliderId).value = v;
    });

    // H/V FOV 表示値
    const hFov = ov.viewVolume.rightFov - ov.viewVolume.leftFov;
    const vFov = ov.viewVolume.topFov - ov.viewVolume.bottomFov;
    $('fov-h').value = +hFov.toFixed(2);
    $('fov-v').value = +vFov.toFixed(2);
    $('fov-h-slider').value = hFov;
    $('fov-v-slider').value = vFov;

    updateImageInfoPanel(ov);
    updateExifButtonState(ov);
  } finally {
    formUpdating = false;
  }
}

/** 左ペインの画像情報表示を更新する */
function updateImageInfoPanel(ov) {
  const img = $('image-preview');
  const empty = $('image-preview-empty');
  if (ov?.imageUrl) {
    img.src = ov.imageUrl;
    img.hidden = false;
    empty.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    empty.hidden = false;
    empty.textContent = ov ? '画像未読込（JSON 復元時は「画像を差し替え」で再設定）' : '画像未読込';
  }
  $('info-filename').textContent = ov?.imagePath ? ov.imagePath.split('/').pop() : '—';
  $('info-size').textContent = ov?.imageWidth
    ? `${ov.imageWidth} × ${ov.imageHeight} px` +
      (ov.imageFile ? ` / ${humanSize(ov.imageFile.size)}` : '')
    : '—';
  $('info-type').textContent = ov?.imageType || '—';
  $('info-gps').textContent = ov ? (ov._hasGps ? 'あり' : 'なし') : '—';
  $('info-pano').textContent = ov
    ? (ov.isPanoCandidate ? 'Equirectangular 候補 (≈2:1)' : '通常画像')
    : '—';
}

/** Exif 書き込みボタンの活性状態（JPEG のみ正式対応）を更新する */
function updateExifButtonState(ov) {
  const btn = $('export-jpeg-btn');
  const writable = !!ov?.imageFile && EXIF_WRITABLE_TYPES.includes(ov.imageType);
  btn.disabled = !writable;
  btn.title = writable
    ? '選択中の JPEG に GPS Exif（カメラ位置）を書き込んでダウンロードします'
    : 'GPS Exif 書き込みは JPEG のみ正式対応です（PNG / WebP / HEIF / TIFF は非対応）';
}

/** 縦横比固定時に hFov から vFov を算出する（tan ベース） */
function lockedVFov(ov, hFov) {
  const aspect = ov.imageWidth > 0 ? ov.imageHeight / ov.imageWidth : 0.66;
  return rad2deg(2 * Math.atan(Math.tan(deg2rad(hFov / 2)) * aspect));
}

/** 縦横比固定時に vFov から hFov を算出する */
function lockedHFov(ov, vFov) {
  const aspect = ov.imageWidth > 0 ? ov.imageHeight / ov.imageWidth : 0.66;
  return rad2deg(2 * Math.atan(Math.tan(deg2rad(vFov / 2)) / aspect));
}

/** hFov / vFov を left/right/top/bottom へ対称に反映する */
function applyHV(ov, hFov, vFov) {
  ov.viewVolume.leftFov = -hFov / 2;
  ov.viewVolume.rightFov = hFov / 2;
  ov.viewVolume.topFov = vFov / 2;
  ov.viewVolume.bottomFov = -vFov / 2;
}

/** モデル変更後の共通後処理 */
function afterModelChange() {
  refreshMapVisuals();
  renderOverlayList();
}

/** 編集フォームのイベントを設定する */
function setupFormEvents() {
  // 汎用数値バインディング
  forEachCameraBinding((inputId, sliderId, getter, setter) => {
    const apply = (raw) => {
      if (formUpdating) return;
      const ov = getSelected();
      if (!ov) return;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return;
      setter(ov, v);
      // FOV 詳細を編集したら H/V 表示も更新
      updateFormFromModel();
      afterModelChange();
      if (inputId.startsWith('cam-')) maybeSyncMapFromCamera(ov);
    };
    $(inputId).addEventListener('change', (e) => apply(e.target.value));
    if (sliderId) $(sliderId).addEventListener('input', (e) => apply(e.target.value));
  });

  // H FOV
  const onHFov = (raw) => {
    if (formUpdating) return;
    const ov = getSelected();
    if (!ov) return;
    const h = clamp(parseFloat(raw) || 1, 0.1, 179);
    const v = $('fov-lock').checked
      ? lockedVFov(ov, h)
      : ov.viewVolume.topFov - ov.viewVolume.bottomFov;
    applyHV(ov, h, clamp(v, 0.1, 179));
    updateFormFromModel();
    afterModelChange();
  };
  $('fov-h').addEventListener('change', (e) => onHFov(e.target.value));
  $('fov-h-slider').addEventListener('input', (e) => onHFov(e.target.value));

  // V FOV
  const onVFov = (raw) => {
    if (formUpdating) return;
    const ov = getSelected();
    if (!ov) return;
    const v = clamp(parseFloat(raw) || 1, 0.1, 179);
    const h = $('fov-lock').checked
      ? lockedHFov(ov, v)
      : ov.viewVolume.rightFov - ov.viewVolume.leftFov;
    applyHV(ov, clamp(h, 0.1, 179), v);
    updateFormFromModel();
    afterModelChange();
  };
  $('fov-v').addEventListener('change', (e) => onVFov(e.target.value));
  $('fov-v-slider').addEventListener('input', (e) => onVFov(e.target.value));

  // Overlay 属性
  $('ov-name').addEventListener('change', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.name = e.target.value || 'PhotoOverlay';
    afterModelChange();
  });
  $('ov-desc').addEventListener('change', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.description = e.target.value;
  });
  $('ov-shape').addEventListener('change', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.shape = e.target.value;
    afterModelChange();
    updateFormFromModel();
  });
  $('ov-opacity').addEventListener('input', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.opacity = clamp(parseFloat(e.target.value), 0, 1);
    $('ov-opacity-value').value = ov.opacity.toFixed(2);
    refreshMapVisuals(); // リアルタイム更新
  });
  $('ov-visible').addEventListener('change', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.visible = e.target.checked;
    afterModelChange();
  });
  $('ov-href').addEventListener('change', (e) => {
    const ov = getSelected(); if (!ov) return;
    ov.imagePath = e.target.value.trim() || ov.imagePath;
    updateImageInfoPanel(ov);
  });
  $('cam-altmode').addEventListener('change', (e) => {
    const ov = getSelected(); if (ov) ov.camera.altitudeMode = e.target.value;
  });
  $('pt-altmode').addEventListener('change', (e) => {
    const ov = getSelected(); if (ov) ov.point.altitudeMode = e.target.value;
  });

  // カメラ前方へ Point 配置
  $('point-from-camera-btn').addEventListener('click', () => {
    const ov = getSelected(); if (!ov) return;
    const d = Math.max(ov.viewVolume.near * 2, 20);
    const [lng, lat] = destination(
      ov.camera.longitude, ov.camera.latitude, d, ov.camera.heading);
    ov.point.longitude = lng;
    ov.point.latitude = lat;
    updateFormFromModel();
    afterModelChange();
  });

  // 画像差し替え
  $('replace-image-btn').addEventListener('click', () => {
    if (!getSelected()) return;
    imageInputMode = 'replace';
    $('image-file-input').click();
  });
}

/* ---- 地図 ⇔ Camera 同期（§4.3） ---------------------------------------- */

/** 地図ズーム値からカメラ高度[m]を概算する（メルカトル近似） */
function zoomToAltitude(zoom, lat) {
  return (40075016.686 * Math.cos(deg2rad(lat))) / Math.pow(2, zoom) / 2.8;
}

/** カメラ高度[m]から地図ズーム値を概算する */
function altitudeToZoom(alt, lat) {
  const z = Math.log2((40075016.686 * Math.cos(deg2rad(lat))) / (Math.max(alt, 2) * 2.8));
  return clamp(z, 2, 21);
}

/** UI のカメラ値を地図視点へ反映する（同期 ON のとき） */
function maybeSyncMapFromCamera(ov) {
  if (!$('sync-toggle').checked || !ov) return;
  state.suppressMapSync = true;
  mapW.setCamera({
    lng: ov.camera.longitude,
    lat: ov.camera.latitude,
    zoom: altitudeToZoom(ov.camera.altitude, ov.camera.latitude),
    bearing: ov.camera.heading,
    pitch: clamp(ov.camera.tilt, 0, 85), // KML tilt ≈ MapLibre pitch（85°超は表示不可）
    roll: ov.camera.roll,
  });
  setTimeout(() => { state.suppressMapSync = false; }, 100);
}

/** 地図操作をカメラ値へ書き戻す（同期 ON のとき） */
function setupMapCameraSync() {
  mapW.on('moveend', () => {
    if (state.suppressMapSync || !$('sync-toggle').checked) return;
    const ov = getSelected();
    if (!ov) return;
    const c = mapW.getCamera();
    ov.camera.longitude = c.lng;
    ov.camera.latitude = c.lat;
    ov.camera.heading = ((c.bearing % 360) + 360) % 360;
    ov.camera.tilt = c.pitch;
    if (mapW.rollSupported) ov.camera.roll = c.roll;
    ov.camera.altitude = Math.round(zoomToAltitude(c.zoom, c.lat) * 10) / 10;
    updateFormFromModel();
    refreshMapVisuals();
  });

  // 地図クリックで Point 設定（トグル ON のとき）
  mapW.on('click', (e) => {
    if (!$('click-point-toggle').checked) return;
    const ov = getSelected();
    if (!ov) { notify('先に PhotoOverlay を選択してください', 'warn'); return; }
    ov.point.longitude = e.lngLat.lng;
    ov.point.latitude = e.lngLat.lat;
    updateFormFromModel();
    afterModelChange();
  });

  // ステータスバー（pitch / bearing / zoom / center を常時表示）
  const status = $('map-status');
  const renderStatus = () => {
    const c = mapW.getCamera();
    status.textContent =
      `中心 ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} | ` +
      `zoom ${c.zoom.toFixed(2)} | bearing ${c.bearing.toFixed(1)}° | pitch ${c.pitch.toFixed(1)}°`;
  };
  mapW.on('move', renderStatus);
  renderStatus();
}

/* ---- PhotoOverlay 一覧 --------------------------------------------------- */

/** 左ペインの PhotoOverlay 一覧を再描画する */
function renderOverlayList() {
  const ul = $('overlay-list');
  ul.innerHTML = '';
  $('overlay-list-empty').hidden = state.overlays.length > 0;

  state.overlays.forEach((ov, idx) => {
    const li = document.createElement('li');
    li.className = `overlay-item${ov.id === state.selectedId ? ' selected' : ''}`;
    li.addEventListener('click', () => selectOverlay(ov.id));

    // サムネイル
    if (ov.imageUrl) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = ov.imageUrl;
      img.alt = `${ov.name} のサムネイル`;
      li.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb-placeholder';
      ph.textContent = '🖼';
      li.appendChild(ph);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'item-name';
    nameEl.textContent = ov.name;
    nameEl.title = ov.name;
    li.appendChild(nameEl);

    // メタ行: shape バッジ + 表示チェック + 操作ボタン
    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const badge = document.createElement('span');
    badge.className = `shape-badge ${ov.shape}`;
    badge.textContent = ov.shape;
    meta.appendChild(badge);

    const visLabel = document.createElement('label');
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = ov.visible;
    vis.title = '表示/非表示';
    vis.setAttribute('aria-label', `${ov.name} の表示切替`);
    vis.addEventListener('click', (e) => e.stopPropagation());
    vis.addEventListener('change', () => {
      ov.visible = vis.checked;
      refreshMapVisuals();
      if (ov.id === state.selectedId) updateFormFromModel();
    });
    visLabel.appendChild(vis);
    visLabel.appendChild(document.createTextNode('表示'));
    meta.appendChild(visLabel);

    const actions = document.createElement('span');
    actions.className = 'item-actions';
    const mkBtn = (label, title, handler, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', `${ov.name} を${title}`);
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
      actions.appendChild(b);
    };
    mkBtn('↑', '上へ移動', () => moveOverlay(idx, -1));
    mkBtn('↓', '下へ移動', () => moveOverlay(idx, +1));
    mkBtn('複製', '複製', () => duplicateOverlay(ov.id));
    mkBtn('削除', '削除', () => deleteOverlay(ov.id), 'delete-btn');
    meta.appendChild(actions);

    li.appendChild(meta);
    ul.appendChild(li);
  });
}

function selectOverlay(id) {
  if (state.selectedId === id) { renderOverlayList(); return; }
  state.selectedId = id;
  renderOverlayList();
  updateFormFromModel();
  refreshMapVisuals();
}

function moveOverlay(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.overlays.length) return;
  const [item] = state.overlays.splice(idx, 1);
  state.overlays.splice(j, 0, item);
  renderOverlayList();
}

function duplicateOverlay(id) {
  const src = state.overlays.find((o) => o.id === id);
  if (!src) return;
  const copy = createOverlayModel(JSON.parse(JSON.stringify({
    ...src, imageFile: undefined, imageUrl: undefined, id: undefined,
  })));
  copy.name = `${src.name} (コピー)`;
  copy.imageFile = src.imageFile; // 同じ画像を共有
  copy.imageUrl = src.imageUrl;   // Blob URL も共有（解放時に参照カウント）
  copy._hasGps = src._hasGps;
  state.overlays.push(copy);
  selectOverlay(copy.id);
  notify(`「${src.name}」を複製しました`, 'success');
}

function deleteOverlay(id) {
  const idx = state.overlays.findIndex((o) => o.id === id);
  if (idx < 0) return;
  const ov = state.overlays[idx];
  if (!confirm(`「${ov.name}」を削除しますか？`)) return;

  disposeBillboardTexture(ov.id);
  mapW.removeMarker(`cam-${ov.id}`);
  mapW.removeMarker(`pt-${ov.id}`);
  state.overlays.splice(idx, 1);

  // Blob URL の解放（他の overlay が同じ URL を共有していなければ）
  if (ov.imageUrl && !state.overlays.some((o) => o.imageUrl === ov.imageUrl)) {
    URL.revokeObjectURL(ov.imageUrl);
  }

  if (state.selectedId === id) {
    state.selectedId = state.overlays[0]?.id ?? null;
  }
  renderOverlayList();
  updateFormFromModel();
  refreshMapVisuals();
  notify(`「${ov.name}」を削除しました`, 'info');
}

/** 全 overlay を破棄する（KMZ 再読込時）。Blob URL も解放する。 */
function clearAllOverlays() {
  for (const ov of state.overlays) {
    disposeBillboardTexture(ov.id);
    mapW.removeMarker(`cam-${ov.id}`);
    mapW.removeMarker(`pt-${ov.id}`);
    if (ov.imageUrl) URL.revokeObjectURL(ov.imageUrl);
  }
  state.overlays = [];
  state.selectedId = null;
  renderOverlayList();
  updateFormFromModel();
  refreshMapVisuals();
}

/* =============================================================================
 * 8. 画像読込・Exif GPS 読込・360°判定
 * ========================================================================== */

/** 画像読込ボタンの動作モード: 'new'（新規 overlay）| 'replace'（差し替え） */
let imageInputMode = 'new';

/** File から画像の寸法を取得する（デコード不能なら reject） */
function probeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('画像をデコードできません'));
    img.src = url;
  });
}

/** ExifReader で GPS 情報を読む。無ければ null。 */
async function readGpsExif(file) {
  try {
    const buf = await file.arrayBuffer();
    const tags = ExifReader.load(buf, { expanded: true });
    const gps = tags.gps;
    if (gps && Number.isFinite(gps.Latitude) && Number.isFinite(gps.Longitude)) {
      return {
        latitude: gps.Latitude,
        longitude: gps.Longitude,
        altitude: Number.isFinite(gps.Altitude) ? gps.Altitude : null,
      };
    }
    return null;
  } catch (e) {
    // Exif が無い・壊れている場合は GPS なし扱い
    console.warn('Exif 読み取り失敗:', e.message);
    return null;
  }
}

/** 2:1 Equirectangular 判定 */
function isPanoAspect(width, height) {
  if (!width || !height) return false;
  const tol = parseFloat($('pano-tolerance').value) || 0.02;
  return Math.abs(width / height - 2.0) <= tol;
}

/** 360°判定ダイアログを表示し、'sphere' | 'rectangle' を返す */
function askPanoShape() {
  return new Promise((resolve) => {
    const dlg = $('pano-dialog');
    const onSphere = () => { cleanup(); resolve('sphere'); };
    const onRect = () => { cleanup(); resolve('rectangle'); };
    const onCancel = (e) => { e.preventDefault(); cleanup(); resolve('rectangle'); };
    function cleanup() {
      $('pano-sphere-btn').removeEventListener('click', onSphere);
      $('pano-rect-btn').removeEventListener('click', onRect);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
    }
    $('pano-sphere-btn').addEventListener('click', onSphere);
    $('pano-rect-btn').addEventListener('click', onRect);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

/** 画像ファイル読込のメイン処理 */
async function handleImageFile(file) {
  const replaceTarget = imageInputMode === 'replace' ? getSelected() : null;
  imageInputMode = 'new';

  // MIME 推定（拡張子フォールバック）
  const extType = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  }[file.name.split('.').pop()?.toLowerCase()] || '';
  const mime = file.type || extType;

  const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff'];
  if (mime && !supported.includes(mime)) {
    notify(`非対応の画像形式です: ${mime || file.name}。JPEG / PNG / WebP / HEIF / TIFF を使用してください。`, 'error');
    return;
  }

  const url = URL.createObjectURL(file);
  let dims;
  try {
    dims = await probeImage(url);
  } catch {
    URL.revokeObjectURL(url);
    if (/heic|heif|tiff?/.test(mime + file.name.toLowerCase())) {
      notify(`このブラウザは ${mime || 'HEIF/TIFF'} のデコードに対応していない可能性があります。` +
        'JPEG または PNG に変換してから読み込んでください。', 'error');
    } else {
      notify('画像ファイルが壊れているか、読み込めない形式です。別のファイルをお試しください。', 'error');
    }
    return;
  }

  if (dims.width * dims.height > MAX_SAFE_PIXELS) {
    notify(`非常に大きい画像です（${dims.width}×${dims.height}）。動作が遅くなる可能性があります。`, 'warn');
  }

  // Exif GPS 読込（JPEG 以外でも ExifReader が対応する範囲で試行）
  const gps = await readGpsExif(file);

  // 360° 判定
  const pano = isPanoAspect(dims.width, dims.height);
  let shape = 'rectangle';
  if (pano) shape = await askPanoShape();

  if (replaceTarget) {
    // --- 選択中 overlay の画像差し替え ---
    if (replaceTarget.imageUrl &&
        !state.overlays.some((o) => o !== replaceTarget && o.imageUrl === replaceTarget.imageUrl)) {
      URL.revokeObjectURL(replaceTarget.imageUrl);
    }
    Object.assign(replaceTarget, {
      imageFile: file,
      imageUrl: url,
      imagePath: `images/${sanitizeFileName(file.name)}`,
      imageWidth: dims.width,
      imageHeight: dims.height,
      imageType: mime,
      isPanoCandidate: pano,
      shape,
    });
    replaceTarget._hasGps = !!gps;
    disposeBillboardTexture(replaceTarget.id); // テクスチャを作り直す
    notify(`画像を差し替えました: ${file.name}`, 'success');
    finalizeImageLoad(replaceTarget, gps);
    return;
  }

  // --- 新規 overlay 作成 ---
  state.overlayCounter += 1;
  const mapC = mapW.getCamera();
  const initLng = gps ? gps.longitude : mapC.lng;
  const initLat = gps ? gps.latitude : mapC.lat;
  const initAlt = gps?.altitude ?? 50;

  const ov = createOverlayModel({
    name: `PhotoOverlay ${state.overlayCounter}`,
    imageFile: file,
    imageUrl: url,
    imagePath: `images/${sanitizeFileName(file.name)}`,
    imageWidth: dims.width,
    imageHeight: dims.height,
    imageType: mime,
    isPanoCandidate: pano,
    shape,
    camera: {
      longitude: initLng, latitude: initLat, altitude: initAlt,
      altitudeMode: 'absolute', heading: 0, tilt: 90, roll: 0,
    },
    point: { longitude: initLng, latitude: initLat, altitude: 0, altitudeMode: 'absolute' },
  });
  ov._hasGps = !!gps;

  // FOV 初期値: 水平 40° を基準に画像アスペクトから垂直を算出
  applyHV(ov, 40, lockedVFov(ov, 40));
  // Point の初期位置はカメラ前方
  const [plng, plat] = destination(initLng, initLat, Math.max(ov.viewVolume.near * 2, 20), 0);
  ov.point.longitude = plng;
  ov.point.latitude = plat;

  state.overlays.push(ov);
  selectOverlay(ov.id);
  notify(`画像を読み込みました: ${file.name}${gps ? '（GPS Exif あり）' : '（GPS Exif なし → 地図中心へ配置）'}`, 'success');
  finalizeImageLoad(ov, gps);
}

/** 画像読込後の共通処理（UI 更新 + 写真を画面中央にプレビュー） */
function finalizeImageLoad(ov, gps) {
  updateFormFromModel();
  afterModelChange();
  // 画像のデコード完了を待ってからカメラ視点へ移動（写真が画面中央に出る）
  if (ov._imgEl && !ov._imgEl.complete) {
    ov._imgEl.addEventListener('load', () => viewPhotoFromCamera(ov), { once: true });
  }
  viewPhotoFromCamera(ov);
  // 地形タイル読込後に高度（relativeToGround）が確定するため、再度位置合わせ
  mapW.once('idle', () => {
    if (getSelected()?.id === ov.id) viewPhotoFromCamera(ov);
  });
}

/** KMZ 内パスとして安全なファイル名に変換する */
function sanitizeFileName(name) {
  return name.replace(/[^\w.\-]+/g, '_');
}

/* =============================================================================
 * 9. KML / KMZ 出力
 * ========================================================================== */

/** 数値を KML 用に整形する */
const fmt = (n) => (Number.isFinite(n) ? +n.toFixed(8) : 0);

/** 不透明度(0-1) を KML の <color>（aabbggrr）へ変換する */
function opacityToKmlColor(opacity) {
  const a = Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, '0');
  return `${a}ffffff`;
}

/** 1 つの PhotoOverlay モデルを KML 断片へ変換する */
function overlayToKml(ov, hrefOverride = null) {
  const vv = ov.viewVolume;
  const href = hrefOverride ?? ov.imagePath ?? '';
  return `    <PhotoOverlay>
      <name>${escapeXml(ov.name)}</name>
      <description>${escapeXml(ov.description)}</description>
      <visibility>${ov.visible ? 1 : 0}</visibility>
      <color>${opacityToKmlColor(ov.opacity)}</color>
      <Camera>
        <longitude>${fmt(ov.camera.longitude)}</longitude>
        <latitude>${fmt(ov.camera.latitude)}</latitude>
        <altitude>${fmt(ov.camera.altitude)}</altitude>
        <heading>${fmt(ov.camera.heading)}</heading>
        <tilt>${fmt(ov.camera.tilt)}</tilt>
        <roll>${fmt(ov.camera.roll)}</roll>
        <altitudeMode>${escapeXml(ov.camera.altitudeMode)}</altitudeMode>
      </Camera>
      <Icon>
        <href>${escapeXml(href)}</href>
      </Icon>
      <rotation>${fmt(ov.rotation)}</rotation>
      <ViewVolume>
        <leftFov>${fmt(vv.leftFov)}</leftFov>
        <rightFov>${fmt(vv.rightFov)}</rightFov>
        <bottomFov>${fmt(vv.bottomFov)}</bottomFov>
        <topFov>${fmt(vv.topFov)}</topFov>
        <near>${fmt(vv.near)}</near>
      </ViewVolume>
      <Point>
        <coordinates>${fmt(ov.point.longitude)},${fmt(ov.point.latitude)},${fmt(ov.point.altitude)}</coordinates>
        <altitudeMode>${escapeXml(ov.point.altitudeMode)}</altitudeMode>
      </Point>
      <shape>${escapeXml(ov.shape)}</shape>
    </PhotoOverlay>`;
}

/** 全 overlay を含む KML ドキュメント文字列を生成する */
function buildKmlDocument(hrefMap = null) {
  const items = state.overlays
    .map((ov) => overlayToKml(ov, hrefMap ? hrefMap.get(ov.id) : null))
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>PhotoOverlay Creator Export</name>
${items}
  </Document>
</kml>
`;
}

/** KML ファイルをダウンロードする */
function exportKml() {
  if (state.overlays.length === 0) {
    notify('出力する PhotoOverlay がありません。先に画像を読み込んでください。', 'warn');
    return;
  }
  const kml = buildKmlDocument();
  downloadBlob(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
    'photo-overlays.kml');
  notify('KML をダウンロードしました（画像は含まれません。KMZ 出力を推奨）', 'success');
}

/** MIME からファイル拡張子を得る */
function extFromType(type, fallbackName = '') {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tif',
  };
  return map[type] || fallbackName.split('.').pop() || 'jpg';
}

/** KMZ（doc.kml + images/）をダウンロードする */
async function exportKmz() {
  if (state.overlays.length === 0) {
    notify('出力する PhotoOverlay がありません。先に画像を読み込んでください。', 'warn');
    return;
  }
  try {
    const zip = new JSZip();
    const imagesDir = zip.folder('images');
    const hrefMap = new Map();
    let seq = 0;

    for (const ov of state.overlays) {
      let blob = ov.imageFile;
      if (!blob && ov.imageUrl) {
        // Blob URL しか無い場合（KMZ 読込由来など）は fetch で取得
        try { blob = await (await fetch(ov.imageUrl)).blob(); } catch { blob = null; }
      }
      if (!blob) {
        notify(`「${ov.name}」には画像がないため、KMZ には href のみ記録されます。`, 'warn');
        hrefMap.set(ov.id, ov.imagePath || '');
        continue;
      }
      seq += 1;
      const ext = extFromType(ov.imageType, ov.imagePath);
      const path = `images/image-${String(seq).padStart(3, '0')}.${ext}`;
      imagesDir.file(path.replace(/^images\//, ''), blob);
      hrefMap.set(ov.id, path);
    }

    zip.file('doc.kml', buildKmlDocument(hrefMap));
    const kmzBlob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.google-earth.kmz',
      compression: 'DEFLATE',
    });
    downloadBlob(kmzBlob, 'photo-overlays.kmz');
    notify(`KMZ をダウンロードしました（PhotoOverlay ×${state.overlays.length}）`, 'success');
  } catch (e) {
    notify(`KMZ 出力に失敗しました: ${e.message}`, 'error');
  }
}

/* =============================================================================
 * 10. KMZ / KML 読込（再編集）
 * ========================================================================== */

/**
 * 直下の子要素を localName で探す。
 * localName 比較なので <gx:altitudeMode> のような名前空間接頭辞付き要素も拾える。
 * 直下限定なのは、Google Earth Pro の KMZ では <Style><IconStyle><Icon> のように
 * 同名要素が子孫に現れるため（写真本体の <Icon> と混同してはならない）。
 */
function directChild(parent, localName) {
  if (!parent) return null;
  for (const el of parent.children) {
    if (el.localName === localName) return el;
  }
  return null;
}

/** KML 要素から直下テキストを取得するヘルパ */
function kmlText(parent, localName) {
  const el = directChild(parent, localName);
  return el ? el.textContent.trim() : null;
}

/** altitudeMode を UI で扱える 3 値に正規化する（gx: 拡張値も吸収） */
function normalizeAltitudeMode(mode) {
  if (mode === 'absolute' || mode === 'relativeToGround' || mode === 'clampToGround') return mode;
  // Google Earth Pro は「地面より上」を gx:altitudeMode=relativeToSeaFloor で
  // 書き出すことがあるため、SeaFloor 系は Ground 系へ読み替える
  if (mode === 'relativeToSeaFloor') return 'relativeToGround';
  if (mode === 'clampToSeaFloor') return 'clampToGround';
  return 'absolute';
}

const kmlNum = (parent, tag, fallback = 0) => {
  const t = kmlText(parent, tag);
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : fallback;
};

/** KMZ / KML ファイル読込のメイン処理 */
async function handleKmzFile(file) {
  try {
    let kmlString = null;
    let zip = null;

    if (/\.kml$/i.test(file.name)) {
      kmlString = await file.text();
    } else {
      // --- JSZip で KMZ を解凍 ---
      zip = await JSZip.loadAsync(file);
      // doc.kml を優先し、無ければ最初の .kml を使用
      let kmlEntry = zip.file('doc.kml');
      if (!kmlEntry) {
        const candidates = zip.file(/\.kml$/i);
        kmlEntry = candidates[0] || null;
      }
      if (!kmlEntry) {
        notify('KMZ 内に KML ファイルが見つかりません。', 'error');
        return;
      }
      kmlString = await kmlEntry.async('string');
    }

    // --- DOMParser で解析 ---
    const doc = new DOMParser().parseFromString(kmlString, 'text/xml');
    if (doc.querySelector('parsererror')) {
      notify('KML の解析に失敗しました（XML 構文エラー）。', 'error');
      return;
    }

    const overlayEls = [...doc.getElementsByTagName('PhotoOverlay')];
    if (overlayEls.length === 0) {
      notify('この KMZ / KML には PhotoOverlay が含まれていません。', 'error');
      return;
    }

    // 既存データの置き換え確認
    if (state.overlays.length > 0) {
      if (!confirm(`現在の ${state.overlays.length} 件の PhotoOverlay を破棄して読み込みますか？`)) {
        return;
      }
    }
    clearAllOverlays(); // Blob URL もここで解放（§11.4）

    let restored = 0;
    for (const el of overlayEls) {
      const ov = await parsePhotoOverlayElement(el, zip);
      state.overlays.push(ov);
      restored += 1;
    }

    state.overlayCounter = state.overlays.length;
    renderOverlayList();
    updateFormFromModel();
    refreshMapVisuals();
    if (state.overlays.length > 0) {
      const first = state.overlays[0];
      selectOverlay(first.id);
      // カメラ視点へ移動して写真を画面中央に表示
      finalizeImageLoad(first, null);
    }
    notify(`KMZ から PhotoOverlay を ${restored} 件復元しました。`, 'success');
  } catch (e) {
    notify(`KMZ の読み込みに失敗しました: ${e.message}`, 'error');
  }
}

/** <PhotoOverlay> 要素 1 つを内部モデルへ変換する */
async function parsePhotoOverlayElement(el, zip) {
  // すべて「直下の子要素」を参照する。<Style><IconStyle><Icon> のような
  // 子孫要素（カメラアイコン等）を写真本体と誤認しないため。
  const cameraEl = directChild(el, 'Camera');
  const vvEl = directChild(el, 'ViewVolume');
  const pointEl = directChild(el, 'Point');
  const iconEl = directChild(el, 'Icon');

  // Point coordinates: "lng,lat,alt"
  let pt = { longitude: DEFAULT_CENTER.lng, latitude: DEFAULT_CENTER.lat, altitude: 0 };
  const coordText = kmlText(pointEl, 'coordinates');
  if (coordText) {
    const [plng, plat, palt] = coordText.split(/[,\s]+/).map(parseFloat);
    if (Number.isFinite(plng) && Number.isFinite(plat)) {
      pt = { longitude: plng, latitude: plat, altitude: Number.isFinite(palt) ? palt : 0 };
    }
  }

  // 透明度: <color> aabbggrr の alpha
  let opacity = 1;
  const colorText = kmlText(el, 'color');
  if (colorText && /^[0-9a-fA-F]{8}$/.test(colorText)) {
    opacity = parseInt(colorText.slice(0, 2), 16) / 255;
  }

  const ov = createOverlayModel({
    name: kmlText(el, 'name') || 'PhotoOverlay',
    description: kmlText(el, 'description') || '',
    shape: (kmlText(el, 'shape') || 'rectangle').toLowerCase(),
    rotation: kmlNum(el, 'rotation', 0),
    opacity,
    visible: kmlText(el, 'visibility') !== '0',
    camera: {
      longitude: kmlNum(cameraEl, 'longitude', DEFAULT_CENTER.lng),
      latitude: kmlNum(cameraEl, 'latitude', DEFAULT_CENTER.lat),
      altitude: kmlNum(cameraEl, 'altitude', 50),
      heading: kmlNum(cameraEl, 'heading', 0),
      tilt: kmlNum(cameraEl, 'tilt', 90),
      roll: kmlNum(cameraEl, 'roll', 0),
      altitudeMode: normalizeAltitudeMode(kmlText(cameraEl, 'altitudeMode')),
    },
    point: {
      ...pt,
      altitudeMode: normalizeAltitudeMode(kmlText(pointEl, 'altitudeMode')),
    },
    viewVolume: {
      leftFov: kmlNum(vvEl, 'leftFov', -30),
      rightFov: kmlNum(vvEl, 'rightFov', 30),
      topFov: kmlNum(vvEl, 'topFov', 20),
      bottomFov: kmlNum(vvEl, 'bottomFov', -20),
      near: kmlNum(vvEl, 'near', 10),
    },
  });

  // --- Icon href → KMZ 内画像の取得 ---
  const href = kmlText(iconEl, 'href') || '';
  ov.imagePath = href;
  if (!href) {
    notify(`「${ov.name}」に Icon href がありません。画像なしで復元します。`, 'warn');
  } else if (zip) {
    const entry = findZipImage(zip, href);
    if (entry) {
      try {
        const blob = await entry.async('blob');
        // 拡張子から MIME を補完（zip 由来 blob は type が空のことがある）
        const ext = href.split('.').pop()?.toLowerCase();
        const mime = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
          heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
        }[ext] || 'application/octet-stream';
        const typedBlob = blob.type ? blob : new Blob([blob], { type: mime });
        ov.imageFile = typedBlob;
        ov.imageType = typedBlob.type;
        ov.imageUrl = URL.createObjectURL(typedBlob);
        try {
          const dims = await probeImage(ov.imageUrl);
          ov.imageWidth = dims.width;
          ov.imageHeight = dims.height;
          ov.isPanoCandidate = isPanoAspect(dims.width, dims.height);
        } catch {
          notify(`「${ov.name}」の画像（${href}）はこのブラウザで表示できない形式です。`, 'warn');
        }
        // GPS Exif の有無を記録（表示用）
        ov._hasGps = !!(await readGpsExif(typedBlob).catch(() => null));
      } catch (e) {
        notify(`「${ov.name}」の画像展開に失敗しました: ${e.message}`, 'warn');
      }
    } else if (/^https?:\/\//.test(href)) {
      // 外部 URL 参照はそのままプレビューを試みる
      ov.imageUrl = href;
      notify(`「${ov.name}」は外部 URL の画像を参照しています: ${href}`, 'info');
    } else {
      notify(`KMZ 内に画像が見つかりません: ${href}（「${ov.name}」）`, 'warn');
    }
  }
  return ov;
}

/** KMZ zip 内から href に対応する画像エントリを探す（パス正規化＋末尾一致） */
function findZipImage(zip, href) {
  const normalized = decodeURIComponent(href).replace(/^\.\//, '').replace(/\\/g, '/');
  let entry = zip.file(normalized);
  if (entry) return entry;
  // 大文字小文字・ディレクトリ差異を許容して末尾一致で検索
  const base = normalized.split('/').pop().toLowerCase();
  const all = zip.file(/.*/).filter((f) => !f.dir);
  return all.find((f) => f.name.toLowerCase().endsWith(`/${base}`) ||
                          f.name.toLowerCase() === base) || null;
}

/* =============================================================================
 * 11. JPEG Exif GPS 書き込み
 * ========================================================================== */

/** 10進度を Exif の度分秒 Rational 配列へ変換する */
function degToDmsRational(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = Math.round((minFloat - m) * 60 * 10000); // 1/10000 秒精度
  return [[d, 1], [m, 1], [s, 10000]];
}

/** ArrayBuffer → バイナリ文字列（piexifjs 入力用） */
function bufferToBinaryString(buf) {
  const bytes = new Uint8Array(buf);
  const chunks = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return chunks.join('');
}

/** バイナリ文字列 → Uint8Array */
function binaryStringToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * 選択中 overlay の JPEG に、Camera 位置の GPS Exif を書き込みダウンロードする。
 * JPEG のみ正式対応（§10）。
 */
async function exportGpsJpeg() {
  const ov = getSelected();
  if (!ov) { notify('PhotoOverlay を選択してください。', 'warn'); return; }
  if (!ov.imageFile) {
    notify('この PhotoOverlay には画像ファイルがありません。', 'error');
    return;
  }
  if (!EXIF_WRITABLE_TYPES.includes(ov.imageType)) {
    notify(`GPS Exif 書き込みは JPEG のみ正式対応です（現在: ${ov.imageType || '不明'}）。` +
      'JPEG に変換してから読み込んでください。', 'error');
    return;
  }

  try {
    const buf = await ov.imageFile.arrayBuffer();
    const binary = bufferToBinaryString(buf);

    // 既存 Exif を保持しつつ GPS IFD を更新
    let exifObj;
    try {
      exifObj = piexif.load(binary);
    } catch {
      exifObj = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
    }

    const { latitude, longitude, altitude } = ov.camera;
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = latitude >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = degToDmsRational(latitude);
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = longitude >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = degToDmsRational(longitude);
    exifObj.GPS[piexif.GPSIFD.GPSAltitudeRef] = altitude >= 0 ? 0 : 1;
    exifObj.GPS[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(altitude) * 100), 100];

    const exifBytes = piexif.dump(exifObj);
    const newBinary = piexif.insert(exifBytes, binary);
    const blob = new Blob([binaryStringToBytes(newBinary)], { type: 'image/jpeg' });

    const baseName = (ov.imagePath.split('/').pop() || 'photo.jpg').replace(/\.[^.]+$/, '');
    downloadBlob(blob, `${baseName}_gps.jpg`);
    notify(`GPS Exif（${latitude.toFixed(6)}, ${longitude.toFixed(6)}, ${altitude.toFixed(1)}m）を書き込んだ JPEG をダウンロードしました。`, 'success');
  } catch (e) {
    notify(`Exif 書き込みに失敗しました: ${e.message}`, 'error');
  }
}

/* =============================================================================
 * 12. JSON 設定の保存・読込
 * ========================================================================== */

/** 現在の全 overlay 設定を JSON でダウンロードする（画像バイナリは含まない） */
function exportJson() {
  if (state.overlays.length === 0) {
    notify('保存する PhotoOverlay がありません。', 'warn');
    return;
  }
  const data = {
    app: 'PhotoOverlayCreator',
    version: 1,
    exportedAt: new Date().toISOString(),
    overlays: state.overlays.map((ov) => ({
      id: ov.id,
      name: ov.name,
      description: ov.description,
      imagePath: ov.imagePath,
      imageWidth: ov.imageWidth,
      imageHeight: ov.imageHeight,
      imageType: ov.imageType,
      isPanoCandidate: ov.isPanoCandidate,
      shape: ov.shape,
      rotation: ov.rotation,
      opacity: ov.opacity,
      visible: ov.visible,
      camera: ov.camera,
      point: ov.point,
      viewVolume: ov.viewVolume,
    })),
  };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    'photo-overlays-settings.json');
  notify('設定 JSON を保存しました（画像は含まれません）。', 'success');
}

/** JSON 設定を読み込む（画像は「画像を差し替え」で再設定が必要） */
async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'PhotoOverlayCreator' || !Array.isArray(data.overlays)) {
      notify('この JSON は PhotoOverlay Creator の設定ファイルではありません。', 'error');
      return;
    }
    if (state.overlays.length > 0 &&
        !confirm(`現在の ${state.overlays.length} 件の PhotoOverlay を破棄して読み込みますか？`)) {
      return;
    }
    clearAllOverlays();
    for (const o of data.overlays) {
      state.overlays.push(createOverlayModel({ ...o, id: undefined, imageFile: null, imageUrl: '' }));
    }
    state.overlayCounter = state.overlays.length;
    if (state.overlays.length) selectOverlay(state.overlays[0].id);
    renderOverlayList();
    updateFormFromModel();
    refreshMapVisuals();
    notify(`JSON から ${data.overlays.length} 件の設定を復元しました。各 PhotoOverlay の画像は「画像を差し替え」で再読込してください。`, 'success');
  } catch (e) {
    notify(`JSON の読み込みに失敗しました: ${e.message}`, 'error');
  }
}

/* =============================================================================
 * 13. 初期化
 * ========================================================================== */

/** ヘッダー（地図設定）UI のイベントを設定する */
function setupHeaderEvents() {
  $('basemap-select').addEventListener('change', (e) => setBasemap(e.target.value));

  $('terrain-toggle').addEventListener('change', (e) => {
    mapSettings.terrainEnabled = e.target.checked;
    applyTerrain();
  });
  $('terrain-exaggeration').addEventListener('input', (e) => {
    mapSettings.exaggeration = parseFloat(e.target.value);
    $('terrain-exaggeration-value').value = mapSettings.exaggeration.toFixed(1);
    applyTerrain();
  });
  $('hillshade-toggle').addEventListener('change', (e) => {
    mapSettings.hillshade = e.target.checked;
    mapW.setLayerVisibility('hillshade-layer', mapSettings.hillshade);
  });
  $('buildings-toggle').addEventListener('change', (e) => {
    mapSettings.buildings = e.target.checked;
    mapW.setLayerVisibility('poc-3d-buildings', mapSettings.buildings);
  });

  $('photo-view-btn').addEventListener('click', () => {
    const ov = getSelected();
    if (!ov) { notify('先に PhotoOverlay を選択してください', 'warn'); return; }
    viewPhotoFromCamera(ov);
  });
}

/** データ読込・Export ボタンのイベントを設定する */
function setupIoEvents() {
  $('load-image-btn').addEventListener('click', () => {
    imageInputMode = 'new';
    $('image-file-input').click();
  });
  $('image-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルの再選択を許可
    if (file) await handleImageFile(file);
  });

  $('load-kmz-btn').addEventListener('click', () => $('kmz-file-input').click());
  $('kmz-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await handleKmzFile(file);
  });

  $('export-kml-btn').addEventListener('click', exportKml);
  $('export-kmz-btn').addEventListener('click', exportKmz);
  $('export-jpeg-btn').addEventListener('click', exportGpsJpeg);
  $('export-json-btn').addEventListener('click', exportJson);
  $('import-json-btn').addEventListener('click', () => $('json-file-input').click());
  $('json-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await importJson(file);
  });
}

/** アプリのエントリポイント */
function init() {
  // 依存ライブラリの読み込み確認
  const missing = [];
  if (typeof maplibregl === 'undefined') missing.push('MapLibre GL JS');
  if (typeof JSZip === 'undefined') missing.push('JSZip');
  if (typeof piexif === 'undefined') missing.push('piexifjs');
  if (typeof ExifReader === 'undefined') missing.push('ExifReader');
  if (missing.length) {
    notify(`CDN ライブラリの読み込みに失敗しました: ${missing.join(', ')}。ネットワーク接続を確認してください。`, 'error');
    if (missing.includes('MapLibre GL JS')) return; // 地図なしでは続行不可
  }

  try {
    mapW = new MapWrapper('map').init(
      BASEMAPS.openfreemap.style, DEFAULT_CENTER, 14);
  } catch (e) {
    notify(e.message, 'error');
    document.getElementById('map').innerHTML =
      `<p style="padding:16px">${escapeXml(e.message)}</p>`;
    return;
  }

  mapW.once('style.load', () => {
    rebuildCustomLayers();
    notify('地図を初期化しました。「画像を読込」または「KMZ を読込」から始めてください。', 'info');
  });

  setupHeaderEvents();
  setupIoEvents();
  setupFormEvents();
  setupMapCameraSync();
  initMiniMap();
  setupStreetViewEvents();
  renderOverlayList();
  updateFormFromModel();
}

document.addEventListener('DOMContentLoaded', init);
