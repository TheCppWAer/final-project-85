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
let normalLayer = null;
let noLabelLayer = null;
let devAnswerMarker = null;   // 開發模式：標示正確答案的標記

function initMap(center, zoom) {
    if (map) return;

    // v1 修正 ── 將 center/zoom 寫回全域變數，供 loadQuestion() 重置視角使用 ──
    mapCenter = center;
    mapZoom = zoom;

    // bug 修正 ── 底圖改用 CARTO 的 CDN（比 OSM 公用伺服器快且穩定），
    //            放大時不再因為圖磚載入過慢而顯示灰白。
    // 有地名底圖（zoom <= 10 顯示）
    normalLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    // 無地名底圖（zoom > 10 顯示，避免看到地名）
    noLabelLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        subdomains: "abcd",
        maxZoom: MAX_ZOOM,
    });

    // bug 修正 ── 兩層底圖同時加入地圖，靠透明度切換而非 add/removeLayer。
    //            移除圖層會丟棄已下載的圖磚，切換時整片重新抓 → 灰白；
    //            改用 setOpacity 後切換即時、不需重新下載。
    map = L.map("map", {
        center: center,
        zoom: zoom,
        maxZoom: MAX_ZOOM,
        layers: [normalLayer, noLabelLayer],
    });
    noLabelLayer.setOpacity(zoom > 10 ? 1 : 0);

    // 超過 zoom 10 顯示無地名底圖（只切換透明度）
    map.on("zoomend", () => {
        noLabelLayer.setOpacity(map.getZoom() > 10 ? 1 : 0);
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

async function loadQuestion() {
    submitted = false;
    questionReady = false;                 // 題目尚未就緒 → 禁止送出／跳過
    guessLat = null;
    guessLon = null;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (devAnswerMarker) { map.removeLayer(devAnswerMarker); devAnswerMarker = null; }
    if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }

    const confirmBtn = document.getElementById("confirmBtn");
    const skipBtn = document.getElementById("skipBtn");
    const spinner = document.getElementById("loadingSpinner");
    confirmBtn.disabled = true;
    skipBtn.disabled = true;               // 載入期間連「跳過」都停用
    document.getElementById("mapHint").textContent = "題目載入中，請稍候…";
    spinner.textContent = "⏳ 載入街景中…";
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

    const img = document.getElementById("streetPhoto");

    // 圖片載入完成 → 題目正式就緒，開放操作並開始計時
    img.onload = () => {
        if (submitted) return;             // 已先跳過則不再啟動計時
        if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
        spinner.classList.add("hidden");
        img.classList.remove("hidden");
        document.getElementById("photoHint").classList.remove("hidden");
        document.getElementById("modalPhoto").src = data.image_url;
        document.getElementById("mapHint").textContent = "點擊地圖放置猜測標記";
        skipBtn.disabled = false;
        questionReady = true;
        startTimer();                      // 圖片就緒才開始倒數，載入時間不計入 60 秒
    };

    // 圖片載入失敗 → 本回合已登記，開放跳過
    img.onerror = () => {
        if (loadWatchdog) { clearTimeout(loadWatchdog); loadWatchdog = null; }
        spinner.textContent = "❌ 圖片載入失敗，請按「跳過」換下一題";
        skipBtn.disabled = false;
        questionReady = true;
    };

    // 看門狗：圖片載入過久時先開放「跳過」，避免玩家卡死（本回合已登記，跳過為合法操作）
    loadWatchdog = setTimeout(() => {
        if (submitted || img.complete) return;
        spinner.textContent = "⏳ 街景載入較久，可按「跳過」換下一題";
        skipBtn.disabled = false;
        questionReady = true;
    }, LOAD_TIMEOUT_MS);

    // 先綁定 onload/onerror 再設定 src，避免快取圖片不觸發 onload
    img.src = data.image_url;
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
startGame();