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
const MAX_ZOOM = 20;

// [修正] 經度正規化：Leaflet 地圖會水平無限循環，玩家在「重複出現的世界」上
// 點擊時，lng 可能超出 [-180, 180]（例如 380、-200）。若不正規化，結算地圖
// 的 fitBounds 會誤判為橫跨整個地球而把地圖縮到最小，造成視圖渲染錯誤。
// 此函式把任意經度換算回標準的 [-180, 180] 範圍。
function normalizeLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

const map = L.map("map", { center: [20, 0], zoom: 2, maxZoom: MAX_ZOOM });
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: MAX_ZOOM,
}).addTo(map);

map.on("zoomend", () => { if (map.getZoom() > MAX_ZOOM) map.setZoom(MAX_ZOOM); });

map.on("click", (e) => {
  if (submitted) return;
  guessLat = e.latlng.lat;
  // [修正] 在來源端就把點擊到的經度正規化回 [-180, 180]，
  // 確保存入、送往後端、以及後續結算地圖使用的都是乾淨的座標。
  guessLon = normalizeLon(e.latlng.lng);
  if (guessMarker) {
    guessMarker.setLatLng(e.latlng);
  } else {
    guessMarker = L.marker(e.latlng, {
      icon: L.divIcon({ className: "guess-pin", html: "📍", iconSize: [30,30], iconAnchor: [15,30] })
    }).addTo(map);
  }
  document.getElementById("confirmBtn").disabled = false;
  document.getElementById("mapHint").textContent = "已放置標記，可繼續移動或點擊確認";
});

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
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    secondsLeft--;
    document.getElementById("timer").textContent = secondsLeft;
    if (secondsLeft <= 10) document.getElementById("timer").style.color = "#e74c3c";
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

  // [修正] 結算地圖渲染前，對正確位置與猜測位置的經度再做一次防禦性正規化，
  // 避免任一端經度落在 [-180, 180] 之外，使下方 fitBounds 計算出錯誤的超大範圍
  // 而把地圖縮到最小（即原本的視圖渲染錯誤）。
  const trueLL = [data.true_lat, normalizeLon(data.true_lon)];
  const guessLL = data.skipped ? trueLL : [data.guess_lat, normalizeLon(data.guess_lon)];

  resultLeaflet = L.map("resultMap", { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(resultLeaflet);

  L.marker(trueLL, {
    icon: L.divIcon({ className:"", html:"<div style='font-size:28px'>🟢</div>", iconSize:[30,30], iconAnchor:[15,15] })
  }).bindPopup("✅ 正確位置").addTo(resultLeaflet);

  if (!data.skipped) {
    L.marker(guessLL, {
      icon: L.divIcon({ className:"", html:"<div style='font-size:28px'>🔴</div>", iconSize:[30,30], iconAnchor:[15,15] })
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
    data.scores.map((s, i) => `<div class="final-row">第 ${i+1} 題：<b>${s}</b> 分</div>`).join("");
  document.getElementById("finalTotal").textContent = data.total;
  document.getElementById("gradeDisplay").innerHTML =
    `<span class="grade grade-${data.grade}" style="font-size:3rem;">${data.grade}</span>`;
}

function updateRoundScoresBar() {
  document.getElementById("roundScores").innerHTML =
    roundScores.map((s, i) => `<div class="rs-chip">R${i+1}: ${s}</div>`).join("");
}

document.getElementById("confirmBtn").addEventListener("click", () => submitAnswer(false));
document.getElementById("skipBtn").addEventListener("click", () => submitAnswer(true));

loadQuestion();