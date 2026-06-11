import { state } from "./state.js";
import { MAX_ZOOM } from "./config.js";
import { normalizeLon } from "./geo.js";

// ── 初始化猜測用的 Leaflet 地圖（只建立一次）──────────────
export function initMap(center, zoom) {
    if (state.map) return;

    // 將 center/zoom 寫回共用狀態，供 loadQuestion() 重置視角使用
    state.mapCenter = center;
    state.mapZoom = zoom;

    // 彩色無地名底圖（整局常駐）
    state.baseLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    // 地名標籤：輕量透明圖層。
    // ※ 改版：地名全程顯示（含放大時），不再依縮放級別開關。
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

    // 改版：無條件掛上地名圖層，整局常駐顯示。
    state.labelsLayer.addTo(state.map);

    // （原本依 zoom 自動開關地名的 zoomend 監聽器已移除，因為地名現在全程顯示。）

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
