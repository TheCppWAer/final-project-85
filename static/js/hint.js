import { state } from "./state.js";
import { apiHint } from "./api.js";

// ── 提示功能（僅歐洲模式）─────────────────────────────────

// 依目前狀態更新提示按鈕（文字、可用性、失敗外觀；台北模式隱藏）
export function refreshHintButton() {
    const btn = document.getElementById("hintBtn");
    if (!btn) return;
    if (state.currentRegion !== "europe") { btn.classList.add("hidden"); return; }
    btn.classList.remove("hidden");

    if (state.hintFailedThisRound) {
        btn.classList.add("hint-failed");
        btn.innerHTML = `<span class="bulb">💡</span>提示失敗(${state.hintsLeft})`;
        btn.disabled = true;
        return;
    }
    btn.classList.remove("hint-failed");
    btn.innerHTML = `<span class="bulb">💡</span>提示(${state.hintsLeft})`;
    const usable = state.questionReady && !state.submitted && !state.hintUsedThisRound && state.hintsLeft > 0;
    btn.disabled = !usable;
}

// 置中淡紅色提示框，3 秒後自動隱藏
function showHintToast(msg) {
    const t = document.getElementById("hintToast");
    if (!t) return;
    t.textContent = msg;
    t.classList.remove("hidden");
    if (state.hintToastTimer) clearTimeout(state.hintToastTimer);
    state.hintToastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

// 在猜測地圖放上黃色提示點（點擊顯示車程說明）
function placeHintMarker(lat, lon, hours) {
    if (state.hintMarker) { state.map.removeLayer(state.hintMarker); state.hintMarker = null; }
    state.hintMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html: "<div style='font-size:26px'>🟡</div>",
                          iconSize: [26, 26], iconAnchor: [13, 13] })
    }).bindPopup(`💡 提示點：正確答案大約在此點約 ${hours} 小時車程的範圍內`).addTo(state.map);
}

export async function useHint() {
    if (state.currentRegion !== "europe") return;
    if (!state.questionReady || state.submitted || state.hintUsedThisRound ||
        state.hintFailedThisRound || state.hintsLeft <= 0) return;

    const btn = document.getElementById("hintBtn");
    btn.disabled = true;
    btn.innerHTML = `<span class="bulb">💡</span>查詢中…`;

    let data;
    try {
        data = await apiHint();
    } catch (e) {
        data = { found: false };
    }

    if (!data || !data.found) {
        // 失敗（小島無路可達或服務異常）：不扣次數，本題停用，3 秒紅框提示
        state.hintFailedThisRound = true;
        showHintToast("oops，找不到提示點（本次不扣除提示次數）");
        refreshHintButton();
        return;
    }

    // 成功：扣一次提示，放上黃色提示點，本題不再可用
    state.hintsLeft -= 1;
    state.hintUsedThisRound = true;
    placeHintMarker(data.lat, data.lon, data.hours);
    refreshHintButton();
}
