import { state } from "./state.js";

// ══════════════════════════════════════════════════════════
// classic 街景圖：滑鼠滾輪縮放 + 拖曳平移
// ══════════════════════════════════════════════════════════

export function applyZoom() {
    const img = document.getElementById("streetPhoto");
    img.style.transform = `translate(${state.zoomX}px, ${state.zoomY}px) scale(${state.zoomScale})`;
    img.style.cursor = state.zoomScale > 1 ? (state.isPanning ? "grabbing" : "grab") : "zoom-in";
}

export function resetZoom() {
    state.zoomScale = 1; state.zoomX = 0; state.zoomY = 0; state.isPanning = false;
    const img = document.getElementById("streetPhoto");
    if (img) { img.style.transform = ""; img.style.cursor = "zoom-in"; }
}

// 限制平移範圍，避免把圖片拖到完全離開可視區
function clampZoom(rect) {
    if (state.zoomScale <= 1) { state.zoomX = 0; state.zoomY = 0; return; }
    const maxX = (state.zoomScale - 1) * rect.width / 2;
    const maxY = (state.zoomScale - 1) * rect.height / 2;
    state.zoomX = Math.max(-maxX, Math.min(maxX, state.zoomX));
    state.zoomY = Math.max(-maxY, Math.min(maxY, state.zoomY));
}

// 只需在頁面載入時綁定一次（#streetPhoto 元素整局共用）
export function setupClassicZoom() {
    const img = document.getElementById("streetPhoto");
    const wrap = img.parentElement;   // .photo-wrap

    // 滾輪：以游標為中心縮放
    img.addEventListener("wheel", (e) => {
        if (img.classList.contains("hidden")) return;   // 全景題目不處理
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - (rect.left + rect.width / 2);
        const cy = e.clientY - (rect.top + rect.height / 2);
        const prev = state.zoomScale;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;    // 向上放大、向下縮小
        state.zoomScale = Math.min(6, Math.max(1, state.zoomScale * factor));
        const ratio = state.zoomScale / prev;
        // 讓游標下的位置在縮放後維持不動
        state.zoomX = cx * (1 - ratio) + state.zoomX * ratio;
        state.zoomY = cy * (1 - ratio) + state.zoomY * ratio;
        clampZoom(rect);
        applyZoom();
    }, { passive: false });

    // 拖曳平移（僅放大後）
    img.addEventListener("pointerdown", (e) => {
        if (img.classList.contains("hidden") || state.zoomScale <= 1) return;
        state.isPanning = true;
        state.panStartX = e.clientX - state.zoomX;
        state.panStartY = e.clientY - state.zoomY;
        try { img.setPointerCapture(e.pointerId); } catch (x) {}
        applyZoom();
    });
    img.addEventListener("pointermove", (e) => {
        if (!state.isPanning) return;
        state.zoomX = e.clientX - state.panStartX;
        state.zoomY = e.clientY - state.panStartY;
        clampZoom(wrap.getBoundingClientRect());
        applyZoom();
    });
    const endPan = (e) => {
        if (!state.isPanning) return;
        state.isPanning = false;
        try { img.releasePointerCapture(e.pointerId); } catch (x) {}
        applyZoom();
    };
    img.addEventListener("pointerup", endPan);
    img.addEventListener("pointercancel", endPan);
}

// ══════════════════════════════════════════════════════════
// 360 全景檢視器（Pannellum）
// ══════════════════════════════════════════════════════════

// 銷毀上一回合的 360 全景檢視器，並隱藏其容器
export function destroyPano() {
    if (state.panoViewer) {
        try { state.panoViewer.destroy(); } catch (e) { /* 忽略重複銷毀 */ }
        state.panoViewer = null;
    }
    const panoDiv = document.getElementById("panoViewer");
    if (panoDiv) {
        panoDiv.classList.add("hidden");
        panoDiv.innerHTML = "";
    }
}
