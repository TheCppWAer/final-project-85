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

const MAX_ROUNDS = 5;
const TIMER_SECS = 60;
const MAX_ZOOM = 13;

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
        if (submitted) return;
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
    guessLat = null;
    guessLon = null;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    document.getElementById("confirmBtn").disabled = true;
    document.getElementById("mapHint").textContent = "點擊地圖放置猜測標記";
    document.getElementById("loadingSpinner").classList.remove("hidden");
    document.getElementById("streetPhoto").classList.add("hidden");
    document.getElementById("photoHint").classList.add("hidden");

    // 每回合開始重置地圖視角
    map.setView(mapCenter, mapZoom);

    const res = await fetch("/api/question");
    const data = await res.json();
    if (data.error) { alert("無法取得街景照片，請稍後再試。"); return; }

    currentRound = data.round;
    document.getElementById("roundNum").textContent = currentRound;
    document.getElementById("regionLabel").textContent =
        "地區：" + (data.region === "taipei" ? "🏙️ 台北" : "🗺️ 歐洲");

    const img = document.getElementById("streetPhoto");
    img.src = data.image_url;
    img.onload = () => {
        document.getElementById("loadingSpinner").classList.add("hidden");
        img.classList.remove("hidden");
        document.getElementById("photoHint").classList.remove("hidden");
        document.getElementById("modalPhoto").src = data.image_url;
    };
    img.onerror = () => {
        document.getElementById("loadingSpinner").textContent = "❌ 圖片載入失敗，請跳過此題";
    };
    startTimer();
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
    if (submitted) return;
    submitted = true;
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