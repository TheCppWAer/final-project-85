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

function initMap(center, zoom) {
    if (map) return;

    // v1 修正 ── 將 center/zoom 寫回全域變數，供 loadQuestion() 重置視角使用 ──
    mapCenter = center;
    mapZoom = zoom;

    normalLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: MAX_ZOOM,
    });

    noLabelLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap contributors © CARTO",
        maxZoom: MAX_ZOOM,
    });

    map = L.map("map", {
        center: center,
        zoom: zoom,
        maxZoom: MAX_ZOOM,
        layers: [normalLayer],
    });

    // 超過 zoom 10 切換無地名底圖
    map.on("zoomend", () => {
        const z = map.getZoom();
        if (z > 10) {
            if (map.hasLayer(normalLayer)) {
                map.removeLayer(normalLayer);
                map.addLayer(noLabelLayer);
            }
        } else {
            if (map.hasLayer(noLabelLayer)) {
                map.removeLayer(noLabelLayer);
                map.addLayer(normalLayer);
            }
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

async function loadQuestion() {
    submitted = false;
    questionReady = false;                 // 題目尚未就緒 → 禁止送出／跳過
    guessLat = null;
    guessLon = null;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
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

    if (secondsLeft <= 0) { clearInterval(timerInterval); submitAnswer(true); }
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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
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