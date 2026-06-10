// ── 與後端 API 溝通的薄封裝：集中所有 fetch ──
// （對應後端 http_client.py 統一連線 + services 的對外請求層）
// 各函式只負責發請求與回傳 JSON；錯誤處理留給呼叫端（維持原本行為）。

export async function apiStart(region) {
    const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
    });
    return res.json();
}

export async function apiQuestion() {
    const res = await fetch("/api/question");
    return res.json();
}

export async function apiSubmit(body) {
    const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json();
}

export async function apiFinish() {
    const res = await fetch("/api/finish", { method: "POST" });
    return res.json();
}

export async function apiHint() {
    const res = await fetch("/api/hint", { method: "POST" });
    return res.json();
}

export async function apiPlace(lat, lon) {
    const res = await fetch("/api/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon }),
    });
    return res.json();
}
