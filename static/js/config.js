// ── 前端全域常數（集中管理；對應後端 config.py 的定位）──

export const MAX_ROUNDS = 5;
export const TIMER_SECS = 60;
export const MAX_ZOOM = 18;
export const LOAD_TIMEOUT_MS = 10000;   // 圖片載入超過此時間 → 開放跳過，避免卡住

// classic 載入畫面：做成與全景（Pannellum）相同的「Loading... + 進度條」外觀
export const LOADING_BOX_HTML =
    '<div class="lbox-text">Loading...</div>' +
    '<div class="lbar"><div class="lbar-fill"></div></div>';

// 地圖初始視角的後備值（/api/start 沒回傳時使用）
export const DEFAULT_CENTER = [25.0330, 121.5654];
export const DEFAULT_ZOOM = 10;
