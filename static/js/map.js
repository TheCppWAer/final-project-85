import { state } from "./state.js";
import { MAX_ZOOM } from "./config.js";
import { normalizeLon } from "./geo.js";

// ── 初始化猜測用的 Leaflet 地圖（只建立一次）──────────────
export function initMap(center, zoom) {
    if (state.map) return;

    // 將 center/zoom 寫回共用狀態，供 loadQuestion() 重置視角使用
    state.mapCenter = center;
    state.mapZoom = zoom;

    // 只用「單一」彩色底圖整局常駐：放大時僅這一層需載入圖磚，避免變慢／灰白。
    state.baseLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    // 地名標籤：輕量透明圖層，只在 zoom <= 10 疊加；放大（>10）時移除。
    state.labelsLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png", {
        attribution: "© CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    state.map = L.map("map", {
        center: center,
        zoom: zoom,
        maxZoom: MAX_ZOOM,
        layers: [state.baseLayer],
    });
    if (zoom <= 10) state.labelsLayer.addTo(state.map);

    // zoom <= 10 顯示地名、> 10 移除地名（底圖始終不動，不會重新下載）
    state.map.on("zoomend", () => {
        const z = state.map.getZoom();
        if (z > 10) {
            if (state.map.hasLayer(state.labelsLayer)) state.map.removeLayer(state.labelsLayer);
        } else {
            if (!state.map.hasLayer(state.labelsLayer)) state.labelsLayer.addTo(state.map);
        }
    });

    // 玩家點擊地圖放置猜測標記
    state.map.on("click", (e) => {
        if (state.submitted || !state.questionReady) return;
        state.guessLat = e.latlng.lat;
        state.guessLon = normalizeLon(e.latlng.lng);   // 標記仍留在點擊處避免跳走
        if (state.guessMarker) {
            state.guessMarker.setLatLng(e.latlng);
        } else {
            state.guessMarker = L.marker(e.latlng, {
                icon: L.divIcon({ className: "guess-pin", html: "📍", iconSize: [30, 30], iconAnchor: [15, 30] })
            }).addTo(state.map);
        }
        document.getElementById("confirmBtn").disabled = false;
        document.getElementById("mapHint").textContent = "已放置標記，可繼續移動或點擊確認";
    });
}
