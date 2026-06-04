import math, random, requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from flask import Flask, render_template, jsonify, request, session, Response, abort

app = Flask(__name__)
app.secret_key = "geomapper_secret_2024"

PANORAMAX_API = "https://api.panoramax.xyz/api/search"

REGIONS = {
    "taipei": {"bbox": [121.2753, 24.6808, 122.0239, 25.6929], "label": "台北"},
    "europe": {"bbox": [-12.0, 35.0, 30.0, 62.0], "label": "歐洲"},
}

score_history = []

# 預載快取：每個地區預存 3 張備用圖片
image_cache = {"taipei": [], "europe": []}
CACHE_SIZE = 3

# 共用 HTTP Session（連線重用）
http_session = requests.Session()

# ── 兩張圖片「太近」的判定距離（公里）────────────────────
# 台北模式：1 km 內視為重複；歐洲模式：50 km 內視為重複
MIN_DIST_KM = {"taipei": 1.0, "europe": 50.0}

# ── 計分常數與各模式的計分尺度 √(nm)（公里）──────────────
# Score = round( 10000 * exp(-K * d / SCALE) )
# K = 9.21：當 d = 0.5 * SCALE 時得 100 分
# 地圖越大給分寬度越寬，因此 SCALE 需依模式切換
#   台北模式 √(nm) = 72、歐洲模式 √(nm) = 3049
SCORE_K = 9.21
SCORE_SCALE = {"taipei": 72.0, "europe": 3049.0}

# ── 各模式地圖初始視角：中心 [lat, lon] 與縮放級別 ───────
# 台北模式：定在台北市中心，Zoom 10
# 歐洲模式：定在義大利中心，Zoom 5
MAP_VIEW = {
    "taipei": {"center": [25.0330, 121.5654], "zoom": 10},
    "europe": {"center": [42.5000, 12.5000],  "zoom": 5},
}

# ── 開發測試開關（僅手動修改）─────────────────────────────
# 設為 True 時，/api/question 會額外回傳正確答案座標，
# 前端會在作答畫面直接標出答案，供開發人員作弊測試。
# 正式上線前務必改回 False，否則玩家可從網路請求看到答案。
DEV_SHOW_ANSWER = True

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def calc_score(dist_km, region="taipei"):
    scale = SCORE_SCALE.get(region, SCORE_SCALE["taipei"])
    return max(0, round(10000 * math.exp(-SCORE_K * dist_km / scale)))

# ── 判斷圖片是否為 360 全景（equirectangular）──────────────
# Panoramax 的 STAC item 在 properties["pers:interior_orientation"] 內提供：
#   field_of_view          → 全景為 360，一般街景約 50~90
#   sensor_array_dimensions → 全景長寬比約 2:1（如 5760x2880）
# 優先信任 field_of_view，缺值時再用 2:1 長寬比作為後備判斷。
def detect_is_360(props):
    pio = props.get("pers:interior_orientation") or {}

    fov = pio.get("field_of_view")
    if fov is not None:
        try:
            return float(fov) >= 359
        except (TypeError, ValueError):
            pass

    dims = pio.get("sensor_array_dimensions")
    if isinstance(dims, (list, tuple)) and len(dims) == 2 and dims[1]:
        try:
            ratio = float(dims[0]) / float(dims[1])
            return 1.9 <= ratio <= 2.1
        except (TypeError, ValueError, ZeroDivisionError):
            pass

    return False

# ── 檢查候選圖片是否與已用過的座標距離夠遠 ─────────────
def is_far_enough(lat, lon, used_coords, region):
    min_dist = MIN_DIST_KM.get(region, 1.0)
    for used_lat, used_lon in used_coords:
        if haversine(lat, lon, used_lat, used_lon) < min_dist:
            return False  # 距離太近，視為重複
    return True

# ── 單次嘗試：對一個子區域發請求並解析圖片 ──────────────
def _try_fetch_one(bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    lon_span = max_lon - min_lon
    lat_span = max_lat - min_lat
    tile_w = lon_span / 4
    tile_h = lat_span / 4
    off_lon = random.uniform(0, lon_span - tile_w)
    off_lat = random.uniform(0, lat_span - tile_h)
    tile_bbox = [
        min_lon + off_lon, min_lat + off_lat,
        min_lon + off_lon + tile_w, min_lat + off_lat + tile_h,
    ]
    bbox_str = ",".join(str(round(v, 4)) for v in tile_bbox)
    params = {"bbox": bbox_str, "limit": 50}

    try:
        r = http_session.get(PANORAMAX_API, params=params, timeout=6)
        r.raise_for_status()
        features = r.json().get("features", [])
        if not features:
            return None

        random.shuffle(features)
        for item in features:
            coords = item.get("geometry", {}).get("coordinates", [])
            if len(coords) < 2:
                continue
            lon, lat = coords[0], coords[1]
            assets = item.get("assets", {})

            img_url = None
            for key in ("sd", "thumb", "thumbnail", "visual", "image", "hd"):
                if key in assets and assets[key].get("href"):
                    img_url = assets[key]["href"]
                    break
            if not img_url:
                img_url = item.get("properties", {}).get("geovisio:thumbnail")
            if not img_url:
                continue

            is_360 = detect_is_360(item.get("properties", {}))
            return {"image_url": img_url, "lat": lat, "lon": lon,
                    "id": item.get("id", ""), "is_360": is_360}
    except Exception:
        return None

# ── 平行發出 4 個請求，取最快回傳的結果 ─────────────────
def fetch_panoramax_image(bbox):
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_try_fetch_one, bbox) for _ in range(4)]
        for future in as_completed(futures):
            result = future.result()
            if result:
                for f in futures:
                    f.cancel()
                return result
    return None

# ── 背景預載：填充指定地區的快取 ────────────────────────
def _fill_cache(region, used_coords):
    bbox = REGIONS[region]["bbox"]
    attempts = 0
    while len(image_cache[region]) < CACHE_SIZE and attempts < 20:
        attempts += 1
        item = fetch_panoramax_image(bbox)
        if not item:
            continue
        # 預載時也檢查是否與已用座標距離夠遠
        if is_far_enough(item["lat"], item["lon"], used_coords, region):
            # 同時確保快取內部圖片之間也不重複
            cache_coords = [(c["lat"], c["lon"]) for c in image_cache[region]]
            if is_far_enough(item["lat"], item["lon"], cache_coords, region):
                image_cache[region].append(item)

def prefetch(region, used_coords):
    executor = ThreadPoolExecutor(max_workers=1)
    executor.submit(_fill_cache, region, used_coords)
    executor.shutdown(wait=False)

# ── 路由：首頁 ───────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

# ── 路由：遊戲頁面 ───────────────────────────────────────
@app.route("/game")
def game():
    return render_template("game.html")

# ── API：初始化遊戲 ──────────────────────────────────────
@app.route("/api/start", methods=["POST"])
def api_start():
    data = request.json or {}
    region = data.get("region", "taipei")
    if region not in REGIONS:
        region = "taipei"
    session["region"] = region
    session["round"] = 0
    session["scores"] = []
    session["rounds"] = []
    # 清空舊快取，預載新局圖片
    image_cache[region].clear()
    prefetch(region, [])
    view = MAP_VIEW.get(region, MAP_VIEW["taipei"])
    return jsonify({
        "ok": True, "region": region,
        "center": view["center"], "zoom": view["zoom"],
    })

# ── API：取得本回合街景題目 ──────────────────────────────
@app.route("/api/question", methods=["GET"])
def api_question():
    region = session.get("region", "taipei")
    bbox = REGIONS[region]["bbox"]

    # 取出已用過的座標清單
    used_coords = [tuple(r) for r in session.get("rounds", [])]

    item = None

    # 優先從快取取圖（幾乎瞬間）
    while image_cache[region]:
        candidate = image_cache[region].pop(0)
        # 再次確認與已用座標距離夠遠（避免快取建立後又出現類似座標）
        if is_far_enough(candidate["lat"], candidate["lon"], used_coords, region):
            item = candidate
            break

    # 快取沒有：即時抓取，最多嘗試 20 次
    if item is None:
        for _ in range(20):
            candidate = fetch_panoramax_image(bbox)
            if candidate and is_far_enough(candidate["lat"], candidate["lon"], used_coords, region):
                item = candidate
                break

    if item is None:
        return jsonify({"error": "No image found"}), 503

    # 送出題目後立刻觸發預載，將新的已用座標也傳入
    new_used = used_coords + [(item["lat"], item["lon"])]
    prefetch(region, new_used)

    rnd = session.get("round", 0)
    rounds = session.get("rounds", [])
    rounds.append([item["lat"], item["lon"]])
    session["round"] = rnd + 1
    session["rounds"] = rounds

    resp = {"round": rnd + 1, "image_url": item["image_url"], "region": region,
            "is_360": bool(item.get("is_360", False))}
    # 開發測試模式：附帶正確答案座標，前端會直接標示
    if DEV_SHOW_ANSWER:
        resp["answer_lat"] = item["lat"]
        resp["answer_lon"] = item["lon"]
    return jsonify(resp)

# ── API：送出猜測 ────────────────────────────────────────
@app.route("/api/submit", methods=["POST"])
def api_submit():
    data = request.json or {}
    guess_lat = float(data.get("lat", 0))
    guess_lon = float(data.get("lon", 0))
    skipped = data.get("skipped", False)
    region = session.get("region", "taipei")
    rounds = session.get("rounds", [])
    rnd_idx = session.get("round", 1) - 1
    if rnd_idx < 0 or rnd_idx >= len(rounds):
        return jsonify({"error": "bad round index"}), 400
    true_lat, true_lon = rounds[rnd_idx]
    if skipped:
        dist_km, score = 0.0, 0
    else:
        dist_km = haversine(guess_lat, guess_lon, true_lat, true_lon)
        score = calc_score(dist_km, region)
    scores = session.get("scores", [])
    scores.append(score)
    session["scores"] = scores
    return jsonify({
        "true_lat": true_lat, "true_lon": true_lon,
        "guess_lat": guess_lat, "guess_lon": guess_lon,
        "dist_km": round(dist_km, 2), "score": score, "skipped": skipped,
    })

# ── API：結算總分與等級 ──────────────────────────────────
@app.route("/api/finish", methods=["POST"])
def api_finish():
    scores = session.get("scores", [])
    total = sum(scores)
    if   total >= 40000: grade = "S"
    elif total >= 30000: grade = "A"
    elif total >= 15000: grade = "B"
    else:                grade = "C"
    score_history.append({
        "region": session.get("region", "taipei"),
        "scores": scores, "total": total, "grade": grade,
    })
    return jsonify({"scores": scores, "total": total, "grade": grade})

# ── API：歷史紀錄 ────────────────────────────────────────
@app.route("/api/history", methods=["GET"])
def api_history():
    return jsonify(score_history[-20:])

# ── API：圖片代理 ────────────────────────────────────────
# 360 全景需以 WebGL 貼圖呈現，瀏覽器要求影像來源為同源或允許 CORS。
# Panoramax 各實例的圖床不保證提供 CORS 標頭，因此全景圖一律透過此
# 代理以「同源」方式載入，避免 WebGL 因跨域而貼圖失敗（黑畫面）。
# 為避免 SSRF，只允許 https 且網域含 "panoramax" 的圖床。
def _is_allowed_image_url(url):
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme != "https" or not u.netloc:
        return False
    return "panoramax" in u.netloc.lower()

@app.route("/api/proxy", methods=["GET"])
def api_proxy():
    url = request.args.get("url", "")
    if not _is_allowed_image_url(url):
        abort(400)
    try:
        r = http_session.get(url, timeout=15, stream=True)
        r.raise_for_status()
    except Exception:
        abort(502)
    content_type = r.headers.get("Content-Type", "image/jpeg")
    resp = Response(r.iter_content(chunk_size=64 * 1024), content_type=content_type)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp

if __name__ == "__main__":
    app.run(debug=True)