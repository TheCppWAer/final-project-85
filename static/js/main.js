// ── 進入點：綁定 DOM 事件並啟動遊戲（對應後端 app.py 的角色）──
import { MAX_ROUNDS } from "./config.js";
import { state } from "./state.js";
import { setupClassicZoom } from "./photo.js";
import { refreshHintButton, useHint } from "./hint.js";
import { startGame, loadQuestion, submitAnswer, showFinal } from "./game.js";

// 結算畫面「下一回合」：未達最終回合載入下一題，否則顯示總結
document.getElementById("nextBtn").addEventListener("click", async () => {
    document.getElementById("resultOverlay").classList.add("hidden");
    if (state.currentRound >= MAX_ROUNDS) { await showFinal(); }
    else { loadQuestion(); }
});

document.getElementById("confirmBtn").addEventListener("click", () => submitAnswer(false));
document.getElementById("skipBtn").addEventListener("click", () => submitAnswer(true));
document.getElementById("hintBtn").addEventListener("click", useHint);

refreshHintButton();   // 依初始地區決定提示按鈕是否顯示
setupClassicZoom();    // 綁定 classic 圖的滾輪縮放/拖曳事件（只需一次）
startGame();           // 啟動遊戲
