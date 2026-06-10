// ──────────────────────────────────────────────────────────
// 跨模組共用的可變狀態
// ──────────────────────────────────────────────────────────
// 用「單一物件」集中所有可變狀態：各模組 import 的都是同一個 state 參考，
// 因此任何模組對 state.xxx 的修改，其他模組都能即時看到。
// （對應後端 services.py 以模組級全域變數共享狀態的角色。）
export const state = {
    // 猜測標記與座標
    guessMarker: null,
    guessLat: null,
    guessLon: null,

    // 計時器
    timerInterval: null,
    secondsLeft: 60,

    // 回合 / 計分
    currentRound: 0,
    totalScore: 0,
    roundScores: [],
    submitted: false,

    // 地圖（猜測用）與結算地圖
    map: null,
    baseLayer: null,          // 彩色無地名底圖（整局常駐）
    labelsLayer: null,        // 地名標籤（僅 zoom <= 10 疊加）
    resultLeaflet: null,      // 結算畫面的小地圖
    devAnswerMarker: null,    // 開發模式：標示正確答案的標記

    // 地圖初始視角（由 /api/start 帶回）
    mapCenter: [25.0330, 121.5654],
    mapZoom: 10,

    // 360 全景檢視器（Pannellum）實例，非全景題目時為 null
    panoViewer: null,

    // classic 圖的滾輪縮放／拖曳平移狀態
    zoomScale: 1,             // 目前縮放倍率（1 = 原始大小）
    zoomX: 0,                 // 平移位移（px，相對照片區中心）
    zoomY: 0,
    isPanning: false,         // 是否正在拖曳平移
    panStartX: 0,
    panStartY: 0,

    // 提示功能（僅歐洲模式）狀態
    currentRegion: "taipei",  // 本回合地區
    hintsLeft: 3,             // 整局剩餘提示次數
    hintUsedThisRound: false, // 本題是否已成功使用提示
    hintFailedThisRound: false, // 本題提示是否失敗（本題停用）
    hintMarker: null,         // 地圖上的黃色提示點標記
    hintToastTimer: null,     // 提示框自動隱藏計時器

    // 結算地名查詢的請求序號（防止過期回應覆蓋）
    placeReqId: 0,

    // 題目是否已就緒（題目資訊回來且圖片載入完成）。未就緒前禁止送出／跳過。
    questionReady: false,
    // 圖片載入看門狗計時器
    loadWatchdog: null,
};
