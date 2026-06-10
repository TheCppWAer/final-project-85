import {
    LOAD_TIMEOUT_MS, LOADING_BOX_HTML,
    DEFAULT_CENTER, DEFAULT_ZOOM,
} from "./config.js";
import { state } from "./state.js";
import { apiStart, apiQuestion, apiSubmit, apiFinish, apiPlace } from "./api.js";
import { initMap } from "./map.js";
import { resetZoom, destroyPano } from "./photo.js";
import { refreshHintButton } from "./hint.js";
import { startTimer } from "./timer.js";

// ── 時間到的處理：若已放置標記則以最後標記位置計分，否則才算跳過 ──
function onTimeUp() {
    const hasGuess = (state.guessLat !== null && state.guessLon !== null);
    submitAnswer(!hasGuess);
}

// ── 啟動遊戲：從 URL 參數讀取地區並初始化 ────────────────
export async function startGame() {
    const params = new URLSearchParams(window.location.search);
    const region = params.get("region") || "taipei";
    state.currentRegion = region;                 // 供提示按鈕初始判斷

    const data = await apiStart(region);

    const center = data.center || DEFAULT_CENTER;
    const zoom   = data.zoom   || DEFAULT_ZOOM;
    initMap(center, zoom);
    loadQuestion();
}

// ── 載入一回合題目（街景或全景）──────────────────────────
export async function loadQuestion() {
    state.submitted = false;
    state.questionReady = false;            // 題目尚未就緒 → 禁止送出／跳過
    state.guessLat = null;
    state.guessLon = null;
    if (state.guessMarker) { state.map.removeLayer(state.guessMarker); state.guessMarker = null; }
    if (state.devAnswerMarker) { state.map.removeLayer(state.devAnswerMarker); state.devAnswerMarker = null; }
    if (state.loadWatchdog) { clearTimeout(state.loadWatchdog); state.loadWatchdog = null; }
    destroyPano();                          // 清除上一回合的全景檢視器
    resetZoom();                            // 重置上一回合 classic 圖的縮放/平移
    if (state.hintMarker) { state.map.removeLayer(state.hintMarker); state.hintMarker = null; }
    state.hintUsedThisRound = false;        // 重置本題提示狀態
    state.hintFailedThisRound = false;
    refreshHintButton();                    // 載入期間先停用提示按鈕

    const confirmBtn = document.getElementById("confirmBtn");
    const skipBtn = document.getElementById("skipBtn");
    const spinner = document.getElementById("loadingSpinner");
    confirmBtn.disabled = true;
    skipBtn.disabled = true;                // 載入期間連「跳過」都停用
    document.getElementById("mapHint").textContent = "題目載入中，請稍候…";
    spinner.innerHTML = LOADING_BOX_HTML;
    spinner.classList.remove("hidden");
    document.getElementById("streetPhoto").classList.add("hidden");
    document.getElementById("photoHint").classList.add("hidden");

    // 每回合開始重置地圖視角
    state.map.setView(state.mapCenter, state.mapZoom);

    // 取得題目資訊；此步驟成功後，後端才會登記本回合座標
    let data;
    try {
        data = await apiQuestion();
    } catch (e) {
        spinner.textContent = "❌ 題目載入失敗，請重新整理頁面";
        return;
    }
    if (data.error) {
        spinner.textContent = "❌ 無法取得街景照片，請重新整理頁面";
        return;
    }

    state.currentRound = data.round;
    state.currentRegion = data.region;      // 供提示按鈕判斷是否顯示（僅歐洲）
    refreshHintButton();
    document.getElementById("roundNum").textContent = state.currentRound;
    document.getElementById("regionLabel").textContent =
        "地區：" + (data.region === "taipei" ? "🏙️ 台北" : "🗺️ 歐洲");

    // 開發測試模式：後端（DEV_SHOW_ANSWER=True）會回傳答案座標，直接在地圖標出
    if (data.answer_lat != null && data.answer_lon != null) {
        state.devAnswerMarker = L.marker([data.answer_lat, data.answer_lon], {
            icon: L.divIcon({ className: "", html: "<div style='font-size:26px'>🟢</div>", iconSize: [26, 26], iconAnchor: [13, 13] })
        }).bindPopup("🛠️ 開發模式：正確答案").addTo(state.map);
        document.getElementById("regionLabel").textContent +=
            `　🛠️ 答案：${data.answer_lat.toFixed(4)}, ${data.answer_lon.toFixed(4)}`;
    }

    // 共用：題目內容（圖片或全景）就緒後 → 開放操作並開始倒數
    const finishReady = (hintText) => {
        if (state.submitted) return;        // 已先跳過則不再啟動計時
        if (state.loadWatchdog) { clearTimeout(state.loadWatchdog); state.loadWatchdog = null; }
        spinner.classList.add("hidden");
        const hint = document.getElementById("photoHint");
        hint.textContent = hintText;
        hint.classList.remove("hidden");
        document.getElementById("mapHint").textContent = "點擊地圖放置猜測標記";
        skipBtn.disabled = false;
        state.questionReady = true;
        refreshHintButton();                // 題目就緒 → 視情況開放提示按鈕
        startTimer(onTimeUp);               // 內容就緒才開始倒數
    };

    // 共用：載入失敗 → 本回合已登記，開放跳過
    const failLoading = (msg) => {
        if (state.loadWatchdog) { clearTimeout(state.loadWatchdog); state.loadWatchdog = null; }
        spinner.textContent = msg;
        spinner.classList.remove("hidden");   // 確保錯誤訊息可見（全景題目時 spinner 原本已隱藏）
        skipBtn.disabled = false;
        state.questionReady = true;
    };

    // 看門狗：載入過久時先開放「跳過」，避免玩家卡死（本回合已登記，跳過為合法操作）
    state.loadWatchdog = setTimeout(() => {
        if (state.submitted || state.questionReady) return;
        spinner.textContent = "⏳ 街景載入較久，可按「跳過」換下一題";
        skipBtn.disabled = false;
        state.questionReady = true;
    }, LOAD_TIMEOUT_MS);

    const img = document.getElementById("streetPhoto");

    if (data.is_360) {
        // ── 360 全景圖：以 Pannellum 呈現，可拖曳旋轉、滾輪縮放 ──
        // 透過後端 /api/proxy 同源載入，避免 WebGL 因跨域貼圖失敗（黑畫面）。
        img.classList.add("hidden");
        const panoDiv = document.getElementById("panoViewer");
        panoDiv.classList.remove("hidden");   // 必須先顯示，Pannellum 才能取得正確尺寸
        // 全景題目改由 Pannellum 自帶的載入指示器顯示進度，隱藏自訂 spinner。
        spinner.classList.add("hidden");
        state.panoViewer = pannellum.viewer("panoViewer", {
            type: "equirectangular",
            panorama: "/api/proxy?url=" + encodeURIComponent(data.image_url),
            autoLoad: true,
            showZoomCtrl: true,
            showFullscreenCtrl: true,
            keyboardZoom: false,
            friction: 0.15,
            compass: false,
        });
        state.panoViewer.on("load", () => finishReady("🔄 全景圖：拖曳可旋轉視角，滾輪可縮放"));
        state.panoViewer.on("error", () => failLoading("❌ 全景圖載入失敗，請按「跳過」換下一題"));
    } else {
        // ── 一般街景圖（classic）：以 <img> 呈現 ──
        document.getElementById("panoViewer").classList.add("hidden");
        img.onload = () => {
            img.classList.remove("hidden");
            finishReady("🖱️ 滾輪縮放，放大後可拖曳平移");
        };
        img.onerror = () => failLoading("❌ 圖片載入失敗，請按「跳過」換下一題");
        // 先綁定 onload/onerror 再設定 src，避免快取圖片不觸發 onload
        img.src = data.image_url;
    }
}

// ── 送出猜測（或跳過）────────────────────────────────────
export async function submitAnswer(skipped = false) {
    if (state.submitted || !state.questionReady) return;   // 題目未就緒前禁止送出／跳過
    state.submitted = true;
    if (state.loadWatchdog) { clearTimeout(state.loadWatchdog); state.loadWatchdog = null; }
    clearInterval(state.timerInterval);
    document.getElementById("confirmBtn").disabled = true;
    refreshHintButton();                       // 作答送出後停用提示按鈕
    const body = skipped
        ? { lat: 0, lon: 0, skipped: true }
        : { lat: state.guessLat, lon: state.guessLon, skipped: false };
    const data = await apiSubmit(body);
    state.roundScores.push(data.score);
    state.totalScore += data.score;
    document.getElementById("totalScore").textContent = state.totalScore;
    updateRoundScoresBar();
    showResult(data);
}

// ── 顯示回合結算（距離、得分、地名、結算小地圖）──────────
function showResult(data) {
    document.getElementById("resultOverlay").classList.remove("hidden");
    document.getElementById("resultTitle").textContent =
        data.skipped ? "⏭️ 已跳過" : `第 ${state.currentRound} 回合結果`;
    document.getElementById("resultDist").textContent =
        data.skipped ? "未猜測" : `📏 距離正確位置：${data.dist_km} 公里`;
    document.getElementById("resultScore").textContent = `⭐ 本回合得分：${data.score} 分`;

    // 反向地理編碼：正確答案在題目確定時已背景預查，submit 直接帶回（省一次請求）；
    // 沒帶回（失敗或尚未完成）才即時反查。玩家猜測一律即時反查。
    const reqId = ++state.placeReqId;
    const truePlaceEl = document.getElementById("resultTruePlace");
    const guessPlaceEl = document.getElementById("resultGuessPlace");
    if (data.true_place) {
        truePlaceEl.textContent = "✅ 正確位置：" + data.true_place;
    } else {
        truePlaceEl.textContent = "✅ 正確位置：查詢中…";
        fillPlace(truePlaceEl, "✅ 正確位置：", data.true_lat, data.true_lon, reqId);
    }
    if (data.skipped) {
        guessPlaceEl.textContent = "";
    } else {
        guessPlaceEl.textContent = "📍 您的猜測：查詢中…";
        fillPlace(guessPlaceEl, "📍 您的猜測：", data.guess_lat, data.guess_lon, reqId);
    }

    if (state.resultLeaflet) { state.resultLeaflet.remove(); state.resultLeaflet = null; }

    const trueLL  = [data.true_lat,  data.true_lon];
    const guessLL = data.skipped ? trueLL : [data.guess_lat, data.guess_lon];

    state.resultLeaflet = L.map("resultMap", { zoomControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
    }).addTo(state.resultLeaflet);

    L.marker(trueLL, {
        icon: L.divIcon({ className: "", html: "<div style='font-size:28px'>🟢</div>", iconSize: [30, 30], iconAnchor: [15, 15] })
    }).bindPopup("✅ 正確位置").addTo(state.resultLeaflet);

    if (!data.skipped) {
        L.marker(guessLL, {
            icon: L.divIcon({ className: "", html: "<div style='font-size:28px'>🔴</div>", iconSize: [30, 30], iconAnchor: [15, 15] })
        }).bindPopup("📍 您的猜測").addTo(state.resultLeaflet);
        L.polyline([guessLL, trueLL], { color: "#e74c3c", weight: 2, dashArray: "6" }).addTo(state.resultLeaflet);
        state.resultLeaflet.fitBounds(L.latLngBounds([guessLL, trueLL]), { padding: [40, 40] });
    } else {
        state.resultLeaflet.setView(trueLL, 8);
    }
}

// 向後端查詢地名並填入結算畫面；reqId 防止上一回合的延遲回應蓋掉新內容
async function fillPlace(el, prefix, lat, lon, reqId) {
    let place = null;
    try {
        const j = await apiPlace(lat, lon);
        place = j.place;
    } catch (e) { /* 查詢失敗則退而顯示座標 */ }
    if (reqId !== state.placeReqId) return;   // 已進入新回合，放棄這次更新
    el.textContent = prefix + (place || `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
}

// ── 最終總結（總分與等級）────────────────────────────────
export async function showFinal() {
    const data = await apiFinish();
    document.getElementById("finalOverlay").classList.remove("hidden");
    document.getElementById("finalScores").innerHTML =
        data.scores.map((s, i) => `<div class="final-row">第 ${i + 1} 題：<b>${s}</b> 分</div>`).join("");
    document.getElementById("finalTotal").textContent = data.total;
    document.getElementById("gradeDisplay").innerHTML =
        `<span class="grade grade-${data.grade}" style="font-size:3rem;">${data.grade}</span>`;
}

// 更新左下角各回合得分籌碼列
function updateRoundScoresBar() {
    document.getElementById("roundScores").innerHTML =
        state.roundScores.map((s, i) => `<div class="rs-chip">R${i + 1}: ${s}</div>`).join("");
}
