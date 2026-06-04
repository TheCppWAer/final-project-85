let guessMarker = null;
let guessLat = null;
let guessLon = null;
let timerInterval = null;
let secondsLeft = 60;
let currentRound = 0;
let totalScore = 0;
let roundScores = [];
let submitted = false;
let resultLeaflet = null;
let panoViewer = null;   // 360 全景檢視器實例（Pannellum），非全景題目時為 null

// classic 圖的滾輪縮放／拖曳平移狀態
let zoomScale = 1;       // 目前縮放倍率（1 = 原始大小）
let zoomX = 0, zoomY = 0; // 平移位移（px，相對照片區中心）
let isPanning = false;   // 是否正在拖曳平移
let panStartX = 0, panStartY = 0;

// 題目是否已就緒（題目資訊回來且圖片載入完成）。未就緒前禁止送出／跳過。
let questionReady = false;
// 圖片載入看門狗計時器
let loadWatchdog = null;

const MAX_ROUNDS = 5;
const TIMER_SECS = 60;
const MAX_ZOOM = 13;
const LOAD_TIMEOUT_MS = 10000;   // 圖片載入超過此時間 → 開放跳過，避免卡住

// v1 ── 地圖初始中心與縮放改為動態，由後端 /api/start 回傳 ──
let mapCenter = [25.0330, 121.5654];
let mapZoom = 10;

let map = null;
let baseLayer = null;     // 彩色無地名底圖（整局常駐，單一較重圖層）
let labelsLayer = null;   // 地名標籤（僅 zoom <= 10 疊加，輕量透明）
let devAnswerMarker = null;   // 開發模式：標示正確答案的標記

function initMap(center, zoom) {
    if (map) return;

    // v1 修正 ── 將 center/zoom 寫回全域變數，供 loadQuestion() 重置視角使用 ──
    mapCenter = center;
    mapZoom = zoom;

    // bug 修正 ── 只用「單一」彩色底圖整局常駐：放大時僅這一層需載入圖磚
    //            （與已修好的結算地圖相同），不再因同時載入兩張完整底圖而變慢／灰白。
    baseLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    // 地名標籤：輕量透明圖層，只在 zoom <= 10 疊加；放大（>10）時移除，
    //          既避免看到地名，放大時也只需載入底圖一層。
    labelsLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png", {
        attribution: "© CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    map = L.map("map", {
        center: center,
        zoom: zoom,
        maxZoom: MAX_ZOOM,
        layers: [baseLayer],
    });
    if (zoom <= 10) labelsLayer.addTo(map);

    // zoom <= 10 顯示地名、> 10 移除地名（底圖始終不動，不會重新下載）
    map.on("zoomend", () => {
        const z = map.getZoom();
        if (z > 10) {
            if (map.hasLayer(labelsLayer)) map.removeLayer(labelsLayer);
        } else {
            if (!map.hasLayer(labelsLayer)) labelsLayer.addTo(map);
        }
    });

    // 玩家點擊地圖放置猜測標記
    map.on("click", (e) => {
        if (submitted || !questionReady) return;
        guessLat = e.latlng.lat;
        guessLon = e.latlng.lng;
        if (guessMarker) {
            guessMarker.setLatLng(e.latlng);
        } else {
            guessMarker = L.marker(e.latlng, {
                icon: L.divIcon({ className: "guess-pin", html: "📍", iconSize: [30, 30], iconAnchor: [15, 30] })
            }).addTo(map);
        }
        document.getElementById("confirmBtn").disabled = false;
        document.getElementById("mapHint").textContent = "已放置標記，可繼續移動或點擊確認";
    });
}

// v1 修正 ── 從 URL 參數讀取地區，比 sessionStorage 更可靠 ──
async function startGame() {
    const params = new URLSearchParams(window.location.search);
    const region = params.get("region") || "taipei";

    const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
    });
    const data = await res.json();

    const center = data.center || [25.0330, 121.5654];
    const zoom   = data.zoom   || 10;
    initMap(center, zoom);
    loadQuestion();
}

// ── classic 圖：滑鼠滾輪縮放 + 拖曳平移（取代原本點擊放大彈窗）──
function applyZoom() {
    const img = document.getElementById("streetPhoto");
    img.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
    img.style.cursor = zoomScale > 1 ? (isPanning ? "grabbing" : "grab") : "zoom-in";
}

function resetZoom() {
    zoomScale = 1; zoomX = 0; zoomY = 0; isPanning = false;
    const img = document.getElementById("streetPhoto");
    if (img) { img.style.transform = ""; img.style.cursor = "zoom-in"; }
}

// 限制平移範圍，避免把圖片拖到完全離開可視區
function clampZoom(rect) {
    if (zoomScale <= 1) { zoomX = 0; zoomY = 0; return; }
    const maxX = (zoomScale - 1) * rect.width / 2;
    const maxY = (zoomScale - 1) * rect.height / 2;
    zoomX = Math.max(-maxX, Math.min(maxX, zoomX));
    zoomY = Math.max(-maxY, Math.min(maxY, zoomY));
}

// 只需在頁面載入時綁定一次（#streetPhoto 元素整局共用）
function setupClassicZoom() {
    const img = document.getElementById("streetPhoto");
    const wrap = img.parentElement;   // .photo-wrap

    // 滾輪：以游標為中心縮放
    img.addEventListener("wheel", (e) => {
        if (img.classList.contains("hidden")) return;   // 全景題目不處理
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - (rect.left + rect.width / 2);
        const cy = e.clientY - (rect.top + rect.height / 2);
        const prev = zoomScale;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;    // 向上放大、向下縮小
        zoomScale = Math.min(6, Math.max(1, zoomScale * factor));
        const ratio = zoomScale / prev;
        // 讓游標下的位置在縮放後維持不動
        zoomX = cx * (1 - ratio) + zoomX * ratio;
        zoomY = cy * (1 - ratio) + zoomY * ratio;
        clampZoom(rect);
        applyZoom();
    }, { passive: false });

    // 拖曳平移（僅放大後）
    img.addEventListener("pointerdown", (e) => {
        if (img.classList.contains("hidden") || zoomScale <= 1) return;
        isPanning = true;
        panStartX = e.clientX - zoomX;
        panStartY = e.clientY - zoomY;
        try { img.setPointerCapture(e.pointerId); } catch (x) {}
        applyZoom();
    });
    img.addEventListener("pointermove", (e) => {
        if (!isPanning) return;
        zoomX = e.clientX - panStartX;
        zoomY = e.clientY - panStartY;
        clampZoom(wrap.getBoundingClientRect());
        applyZoom();
    });
    const endPan = (e) => {
        if (!isPanning) return;
        isPanning = false;
        try { img.releasePointerCapture(e.pointerId); } catch (x) {}
        applyZoom();
    };
    img.addEventListener("pointerup", endPan);
    img.addEventListener("pointercancel", endPan);
}

// ── 銷毀上一回合的 360 全景檢視器，並隱藏其容器 ──────────
function destroyPano() {
    if (panoViewer) {
        try { panoViewer.destroy(); } catch (e) { /* 忽略重複銷毀 */ }
        panoViewer = null;
    }
    const panoDiv = document.getElementById("panoViewer");
    if (panoDiv) {
        panoDiv.classList.add("hidden");
        panoDiv.innerHTML = "";
    }
}

async function loadQuestion() {
    submitted = false;
    questionReady = false;                 // 題目尚未就緒 → 禁止送出／跳過
    guessLat = null;
    guessLon = null;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (devAnswerMarker) { map.removeLayer(devAnswerMarker); devAnswerMarker = null; }
    if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
    destroyPano();                          // 清除上一回合的全景檢視器
    resetZoom();                            // 重置上一回合 classic 圖的縮放/平移

    const confirmBtn = document.getElementById("confirmBtn");
    const skipBtn = document.getElementById("skipBtn");
    const spinner = document.getElementById("loadingSpinner");
    confirmBtn.disabled = true;
    skipBtn.disabled = true;               // 載入期間連「跳過」都停用
    document.getElementById("mapHint").textContent = "題目載入中，請稍候…";
    spinner.textContent = "⏳ loading…";
    spinner.classList.remove("hidden");
    document.getElementById("streetPhoto").classList.add("hidden");
    document.getElementById("photoHint").classList.add("hidden");

    // 每回合開始重置地圖視角
    map.setView(mapCenter, mapZoom);

    // 取得題目資訊；此步驟成功後，後端才會登記本回合座標
    let data;
    try {
        const res = await fetch("/api/question");
        data = await res.json();
    } catch (e) {
        spinner.textContent = "❌ 題目載入失敗，請重新整理頁面";
        return;
    }
    if (data.error) {
        spinner.textContent = "❌ 無法取得街景照片，請重新整理頁面";
        return;
    }

    currentRound = data.round;
    document.getElementById("roundNum").textContent = currentRound;
    document.getElementById("regionLabel").textContent =
        "地區：" + (data.region === "taipei" ? "🏙️ 台北" : "🗺️ 歐洲");

    // 開發測試模式：後端（DEV_SHOW_ANSWER=True）會回傳答案座標，直接在地圖標出
    if (data.answer_lat != null && data.answer_lon != null) {
        devAnswerMarker = L.marker([data.answer_lat, data.answer_lon], {
            icon: L.divIcon({ className: "", html: "<div style='font-size:26px'>🟢</div>", iconSize: [26, 26], iconAnchor: [13, 13] })
        }).bindPopup("🛠️ 開發模式：正確答案").addTo(map);
        document.getElementById("regionLabel").textContent +=
            `　🛠️ 答案：${data.answer_lat.toFixed(4)}, ${data.answer_lon.toFixed(4)}`;
    }

    // 共用：題目內容（圖片或全景）就緒後 → 開放操作並開始倒數
    const finishReady = (hintText) => {
        if (submitted) return;             // 已先跳過則不再啟動計時
        if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
        spinner.classList.add("hidden");
        const hint = document.getElementById("photoHint");
        hint.textContent = hintText;
        hint.classList.remove("hidden");
        document.getElementById("mapHint").textContent = "點擊地圖放置猜測標記";
        skipBtn.disabled = false;
        questionReady = true;
        startTimer();                      // 內容就緒才開始倒數，載入時間不計入 60 秒
    };

    // 共用：載入失敗 → 本回合已登記，開放跳過
    const failLoading = (msg) => {
        if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
        spinner.textContent = msg;
        spinner.classList.remove("hidden");   // 確保錯誤訊息可見（全景題目時 spinner 原本已隱藏）
        skipBtn.disabled = false;
        questionReady = true;
    };

    // 看門狗：載入過久時先開放「跳過」，避免玩家卡死（本回合已登記，跳過為合法操作）
    loadWatchdog = setTimeout(() => {
        if (submitted || questionReady) return;
        spinner.textContent = "⏳ 街景載入較久，可按「跳過」換下一題";
        skipBtn.disabled = false;
        questionReady = true;
    }, LOAD_TIMEOUT_MS);

    const img = document.getElementById("streetPhoto");

    if (data.is_360) {
        // ── 360 全景圖：以 Pannellum 呈現，可拖曳旋轉、滾輪縮放 ──
        // 透過後端 /api/proxy 同源載入，避免 WebGL 因跨域貼圖失敗（黑畫面）。
        img.classList.add("hidden");
        const panoDiv = document.getElementById("panoViewer");
        panoDiv.classList.remove("hidden");   // 必須先顯示，Pannellum 才能取得正確尺寸
        // 全景題目改由 Pannellum 自帶的載入指示器顯示進度，
        // 因此隱藏自訂的「loading」spinner，避免兩個 loading 文字重疊。
        spinner.classList.add("hidden");
        panoViewer = pannellum.viewer("panoViewer", {
            type: "equirectangular",
            panorama: "/api/proxy?url=" + encodeURIComponent(data.image_url),
            autoLoad: true,
            showZoomCtrl: true,
            showFullscreenCtrl: true,
            keyboardZoom: false,
            friction: 0.15,
            compass: false,
        });
        panoViewer.on("load", () => finishReady("🔄 全景圖：拖曳可旋轉視角，滾輪可縮放"));
        panoViewer.on("error", () => failLoading("❌ 全景圖載入失敗，請按「跳過」換下一題"));
    } else {
        // ── 一般街景圖（classic）：維持原本以 <img> 呈現的方式 ──
        document.getElementById("panoViewer").classList.add("hidden");
        img.onload = () => {
            img.classList.remove("hidden");   // 顯示圖片（先前重構時漏掉，導致畫面全黑）
            finishReady("🖱️ 滾輪縮放，放大後可拖曳平移");
        };
        img.onerror = () => failLoading("❌ 圖片載入失敗，請按「跳過」換下一題");
        // 先綁定 onload/onerror 再設定 src，避免快取圖片不觸發 onload
        img.src = data.image_url;
    }
}

function startTimer() {
  secondsLeft = TIMER_SECS;
  document.getElementById("timer").textContent = secondsLeft;
  document.getElementById("timer").style.color = "";

  // 先關掉 transition，讓計量條瞬間跳回 100%
  const bar = document.getElementById("timerBar");
  bar.style.transition = "none";
  bar.style.width = "100%";
  bar.style.background = "#2ea043";

  // 強制瀏覽器重繪後再開回 transition（否則瞬間設定會被忽略）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = "width 0.9s linear, background 0.3s ease";
    });
  });

  clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    secondsLeft--;
    document.getElementById("timer").textContent = secondsLeft;

    const pct = (secondsLeft / TIMER_SECS) * 100;
    bar.style.width = pct + "%";

    if (secondsLeft <= 10) {
      document.getElementById("timer").style.color = "#e74c3c";
      bar.style.background = "#e74c3c";
    } else if (secondsLeft <= 30) {
      bar.style.background = "#f39c12";
    } else {
      bar.style.background = "#2ea043";
    }

    if (secondsLeft <= 0) {
      clearInterval(timerInterval);
      // 功能 ── 時間到時，若已放置標記則以最後標記位置計分，否則才算跳過
      const hasGuess = (guessLat !== null && guessLon !== null);
      submitAnswer(!hasGuess);
    }
  }, 1000);
}

async function submitAnswer(skipped = false) {
    if (submitted || !questionReady) return;   // 題目未就緒前禁止送出／跳過
    submitted = true;
    if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
    clearInterval(timerInterval);
    document.getElementById("confirmBtn").disabled = true;
    const body = skipped
        ? { lat: 0, lon: 0, skipped: true }
        : { lat: guessLat, lon: guessLon, skipped: false };
    const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    roundScores.push(data.score);
    totalScore += data.score;
    document.getElementById("totalScore").textContent = totalScore;
    updateRoundScoresBar();
    showResult(data);
}

function showResult(data) {
    document.getElementById("resultOverlay").classList.remove("hidden");
    document.getElementById("resultTitle").textContent =
        data.skipped ? "⏭️ 已跳過" : `第 ${currentRound} 回合結果`;
    document.getElementById("resultDist").textContent =
        data.skipped ? "未猜測" : `📏 距離正確位置：${data.dist_km} 公里`;
    document.getElementById("resultScore").textContent = `⭐ 本回合得分：${data.score} 分`;

    if (resultLeaflet) { resultLeaflet.remove(); resultLeaflet = null; }

    const trueLL  = [data.true_lat,  data.true_lon];
    const guessLL = data.skipped ? trueLL : [data.guess_lat, data.guess_lon];

    resultLeaflet = L.map("resultMap", { zoomControl: true });
    // bug 修正 ── 結算地圖同樣改用 CARTO CDN 並設定 maxZoom，放大時可順利載入
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
    }).addTo(resultLeaflet);

    L.marker(trueLL, {
        icon: L.divIcon({ className: "", html: "<div style='font-size:28px'>🟢</div>", iconSize: [30, 30], iconAnchor: [15, 15] })
    }).bindPopup("✅ 正確位置").addTo(resultLeaflet);

    if (!data.skipped) {
        L.marker(guessLL, {
            icon: L.divIcon({ className: "", html: "<div style='font-size:28px'>🔴</div>", iconSize: [30, 30], iconAnchor: [15, 15] })
        }).bindPopup("📍 您的猜測").addTo(resultLeaflet);
        L.polyline([guessLL, trueLL], { color: "#e74c3c", weight: 2, dashArray: "6" }).addTo(resultLeaflet);
        resultLeaflet.fitBounds(L.latLngBounds([guessLL, trueLL]), { padding: [40, 40] });
    } else {
        resultLeaflet.setView(trueLL, 8);
    }
}

document.getElementById("nextBtn").addEventListener("click", async () => {
    document.getElementById("resultOverlay").classList.add("hidden");
    if (currentRound >= MAX_ROUNDS) { await showFinal(); }
    else { loadQuestion(); }
});

async function showFinal() {
    const res = await fetch("/api/finish", { method: "POST" });
    const data = await res.json();
    document.getElementById("finalOverlay").classList.remove("hidden");
    document.getElementById("finalScores").innerHTML =
        data.scores.map((s, i) => `<div class="final-row">第 ${i + 1} 題：<b>${s}</b> 分</div>`).join("");
    document.getElementById("finalTotal").textContent = data.total;
    document.getElementById("gradeDisplay").innerHTML =
        `<span class="grade grade-${data.grade}" style="font-size:3rem;">${data.grade}</span>`;
}

function updateRoundScoresBar() {
    document.getElementById("roundScores").innerHTML =
        roundScores.map((s, i) => `<div class="rs-chip">R${i + 1}: ${s}</div>`).join("");
}

document.getElementById("confirmBtn").addEventListener("click", () => submitAnswer(false));
document.getElementById("skipBtn").addEventListener("click", () => submitAnswer(true));

// v1 ── 頁面載入時啟動遊戲 ──
setupClassicZoom();   // 綁定 classic 圖的滾輪縮放/拖曳事件（只需一次）
startGame();