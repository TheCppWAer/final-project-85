import uuid

from flask import (
    Blueprint, render_template, jsonify, request, session, Response, abort,
    current_app,
)

import config
import geo
import services
from http_client import http_session

bp = Blueprint("main", __name__)


# 取得（或建立）本玩家的 session id；用來區隔各玩家的答案地名快取。
# 放在 routes（而非 services），因為它依賴 Flask 的請求情境 session。
def _get_sid():
    sid = session.get("sid")
    if not sid:
        sid = uuid.uuid4().hex
        session["sid"] = sid
    return sid


# ── 路由：首頁 ───────────────────────────────────────────
@bp.route("/")
def index():
    return render_template("index.html")


# ── 路由：遊戲頁面 ───────────────────────────────────────
@bp.route("/game")
def game():
    return render_template("game.html")


# ── API：初始化遊戲 ──────────────────────────────────────
@bp.route("/api/start", methods=["POST"])
def api_start():
    data = request.json or {}
    region = data.get("region", "taipei")
    if region not in config.REGIONS:
        region = "taipei"
    session["region"] = region
    session["round"] = 0
    session["scores"] = []
    session["rounds"] = []
    # 清除本玩家上一局的答案地名快取
    sid = _get_sid()
    with services.answer_places_lock:
        for k in [k for k in services.answer_places if k[0] == sid]:
            del services.answer_places[k]
    # 清空舊快取，預載新局圖片
    services.image_cache[region].clear()
    services.prefetch(region, [])
    view = config.MAP_VIEW.get(region, config.MAP_VIEW["taipei"])
    return jsonify({
        "ok": True, "region": region,
        "center": view["center"], "zoom": view["zoom"],
    })


# ── API：取得本回合街景題目 ──────────────────────────────
@bp.route("/api/question", methods=["GET"])
def api_question():
    region = session.get("region", "taipei")
    bbox = config.REGIONS[region]["bbox"]

    # 取出已用過的座標清單
    used_coords = [tuple(r) for r in session.get("rounds", [])]

    item = None

    # 優先從快取取圖（幾乎瞬間）
    while services.image_cache[region]:
        candidate = services.image_cache[region].pop(0)
        # 再次確認與已用座標距離夠遠（避免快取建立後又出現類似座標）
        if services.is_far_enough(candidate["lat"], candidate["lon"], used_coords, region):
            item = candidate
            break

    # 快取沒有：即時抓取，最多嘗試 20 次
    if item is None:
        for _ in range(20):
            candidate = services.fetch_panoramax_image(bbox)
            if candidate and services.is_far_enough(candidate["lat"], candidate["lon"], used_coords, region):
                item = candidate
                break

    if item is None:
        return jsonify({"error": "No image found"}), 503

    # 送出題目後立刻觸發預載，將新的已用座標也傳入
    new_used = used_coords + [(item["lat"], item["lon"])]
    services.prefetch(region, new_used)

    rnd = session.get("round", 0)
    rounds = session.get("rounds", [])
    rounds.append([item["lat"], item["lon"]])
    session["round"] = rnd + 1
    session["rounds"] = rounds

    # 題目確定 → 背景預先反查正確答案地名（不阻塞本回應），結算時直接取用
    services.prefetch_answer_place(_get_sid(), rnd, item["lat"], item["lon"])

    resp = {"round": rnd + 1, "image_url": item["image_url"], "region": region,
            "is_360": bool(item.get("is_360", False))}
    # 開發測試模式：附帶正確答案座標，前端會直接標示
    if current_app.config.get("DEV_SHOW_ANSWER", False):
        resp["answer_lat"] = item["lat"]
        resp["answer_lon"] = item["lon"]
    return jsonify(resp)


# ── API：送出猜測 ────────────────────────────────────────
@bp.route("/api/submit", methods=["POST"])
def api_submit():
    data = request.json or {}
    guess_lat = float(data.get("lat", 0))
    guess_lon = float(data.get("lon", 0))
    # 防呆：經度正規化到 [-180,180]、緯度夾在 [-90,90]
    guess_lon = ((guess_lon + 180) % 360 + 360) % 360 - 180
    guess_lat = max(-90.0, min(90.0, guess_lat))
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
        dist_km = geo.haversine(guess_lat, guess_lon, true_lat, true_lon)
        score = geo.calc_score(dist_km, region)
    scores = session.get("scores", [])
    scores.append(score)
    session["scores"] = scores

    # 取用題目確定時就背景反查好的答案地名（可能為 None＝失敗或尚未完成）
    sid = session.get("sid")
    true_place = None
    if sid is not None:
        with services.answer_places_lock:
            true_place = services.answer_places.get((sid, rnd_idx))

    return jsonify({
        "true_lat": true_lat, "true_lon": true_lon,
        "guess_lat": guess_lat, "guess_lon": guess_lon,
        "dist_km": round(dist_km, 2), "score": score, "skipped": skipped,
        "true_place": true_place,
    })


# ── API：結算總分與等級 ──────────────────────────────────
@bp.route("/api/finish", methods=["POST"])
def api_finish():
    scores = session.get("scores", [])
    total = sum(scores)
    if   total >= 40000: grade = "S"
    elif total >= 30000: grade = "A"
    elif total >= 15000: grade = "B"
    else:                grade = "C"
    services.score_history.append({
        "region": session.get("region", "taipei"),
        "scores": scores, "total": total, "grade": grade,
    })
    return jsonify({"scores": scores, "total": total, "grade": grade})


# ── API：歷史紀錄 ────────────────────────────────────────
@bp.route("/api/history", methods=["GET"])
def api_history():
    return jsonify(services.score_history[-20:])


# ── API：提示（僅歐洲模式）──────────────────────────────
# 以本題答案為圓心，回傳一個到答案行車約 5 小時（可接受 2~8 小時）的提示點。
# 使用次數限制（每局 3 次、每題 1 次）由前端控制；後端只負責計算。
@bp.route("/api/hint", methods=["POST"])
def api_hint():
    region = session.get("region", "taipei")
    if region != "europe":
        return jsonify({"found": False, "error": "hint not available"}), 400

    rounds = session.get("rounds", [])
    rnd_idx = session.get("round", 1) - 1
    if rnd_idx < 0 or rnd_idx >= len(rounds):
        return jsonify({"found": False, "error": "bad round index"}), 400

    ans_lat, ans_lon = rounds[rnd_idx]
    hint = services.find_hint_point(ans_lat, ans_lon)
    if hint is None:
        return jsonify({"found": False})
    return jsonify({"found": True, "lat": hint["lat"],
                    "lon": hint["lon"], "hours": hint["hours"]})


# ── API：反向地理編碼（結算畫面顯示地名用）──────────────
@bp.route("/api/place", methods=["POST"])
def api_place():
    data = request.json or {}
    try:
        lat = float(data.get("lat"))
        lon = float(data.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"place": None}), 400
    return jsonify({"place": services.reverse_geocode(lat, lon)})


# ── API：圖片代理 ────────────────────────────────────────
# 360 全景需以 WebGL 貼圖呈現，瀏覽器要求影像來源為同源或允許 CORS。
# Panoramax 各實例的圖床不保證提供 CORS 標頭，因此全景圖一律透過此
# 代理以「同源」方式載入，避免 WebGL 因跨域而貼圖失敗（黑畫面）。
@bp.route("/api/proxy", methods=["GET"])
def api_proxy():
    url = request.args.get("url", "")
    if not services.is_allowed_image_url(url):
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
