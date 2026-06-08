# ── 全域設定與常數（集中管理；要調整地圖、計分、開發開關都改這裡）──

# Flask session 簽章金鑰
SECRET_KEY = "geomapper_secret_2024"

# Panoramax 街景搜尋 API
PANORAMAX_API = "https://api.panoramax.xyz/api/search"

# 各模式可出題的地理範圍（bbox = [min_lon, min_lat, max_lon, max_lat]）
REGIONS = {
    "taipei": {"bbox": [121.2753, 24.6808, 122.0239, 25.6929], "label": "台北"},
    "europe": {"bbox": [-12.0, 35.0, 30.0, 62.0], "label": "歐洲"},
}

# 預載快取：每個地區預存幾張備用圖片
CACHE_SIZE = 3

# ── 兩張圖片「太近」的判定距離（公里）────────────────────
# 台北模式：1 km 內視為重複；歐洲模式：50 km 內視為重複
MIN_DIST_KM = {"taipei": 1.0, "europe": 50.0}

# ── 計分常數與各模式的計分尺度 P = √(nm)（公里）──────────
# Score = round( 10000 * exp(-SCORE_K * d / SCORE_SCALE) )
# SCORE_K = 9.21：當 d = 0.5 * P 時得 1%（100 分）
# 地圖越大給分寬度越寬，因此 SCALE 需依模式切換
SCORE_K = 9.21
SCORE_SCALE = {"taipei": 72.0, "europe": 3049.0}

# ── 各模式地圖初始視角：中心 [lat, lon] 與縮放級別 ───────
MAP_VIEW = {
    "taipei": {"center": [25.0330, 121.5654], "zoom": 10},
    "europe": {"center": [42.5000, 12.5000],  "zoom": 3},
}

# ── 開發測試開關（cheat）已移至 app.py 的 app.config["DEV_SHOW_ANSWER"] ──

# ── 提示功能（僅歐洲模式）：用 OSRM 找一個到答案行車約 5 小時的提示點 ──
# OSRM 公開 demo 伺服器（有流量限制；正式建議自架或用商用端點）
OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving"
HINT_TARGET_H = 5.0    # 目標行車時間（小時）
HINT_MIN_H = 2.0       # 可接受下限
HINT_MAX_H = 8.0       # 可接受上限
HINT_AVG_KMH = 80.0    # 估算初始半徑用的平均車速
HINT_MAX_BEARINGS = 6  # 最多嘗試幾個方位
HINT_MAX_CALLS = 18    # 一次提示最多打幾次 OSRM（保護公開伺服器）

# ── 反向地理編碼（Nominatim）：結算時把座標轉成地名 ──────
# Nominatim 公開伺服器使用條款要求帶可辨識的 User-Agent、限 1 req/s、勿大量使用。
# 正式部署建議自架或改用商用端點。
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_HEADERS = {"User-Agent": "GeoMapper-game/1.0 (educational final project)"}
