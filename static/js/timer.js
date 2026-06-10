import { state } from "./state.js";
import { TIMER_SECS } from "./config.js";

// ── 每回合 60 秒倒數計時器 ────────────────────────────────
// 內容就緒才呼叫，載入時間不計入 60 秒。
// 時間到時呼叫傳入的 onTimeUp callback（由 game.js 決定要計分或跳過），
// 以避免 timer 與 game 之間的循環相依。
export function startTimer(onTimeUp) {
    state.secondsLeft = TIMER_SECS;
    document.getElementById("timer").textContent = state.secondsLeft;
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

    clearInterval(state.timerInterval);

    state.timerInterval = setInterval(() => {
        state.secondsLeft--;
        document.getElementById("timer").textContent = state.secondsLeft;

        const pct = (state.secondsLeft / TIMER_SECS) * 100;
        bar.style.width = pct + "%";

        if (state.secondsLeft <= 10) {
            document.getElementById("timer").style.color = "#e74c3c";
            bar.style.background = "#e74c3c";
        } else if (state.secondsLeft <= 30) {
            bar.style.background = "#f39c12";
        } else {
            bar.style.background = "#2ea043";
        }

        if (state.secondsLeft <= 0) {
            clearInterval(state.timerInterval);
            onTimeUp();
        }
    }, 1000);
}
