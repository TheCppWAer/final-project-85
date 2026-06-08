import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

from config import (
    PANORAMAX_API, REGIONS, CACHE_SIZE, MIN_DIST_KM,
    OSRM_ROUTE_URL, HINT_TARGET_H, HINT_MIN_H, HINT_MAX_H,
    HINT_AVG_KMH, HINT_MAX_BEARINGS, HINT_MAX_CALLS,
    NOMINATIM_URL, NOMINATIM_HEADERS,
)
from http_client import http_session
from geo import haversine, destination_point

# ──────────────────────────────────────────────────────────
# 跨請求的全域狀態（模組級單例；routes 透過 import 直接讀寫）
# ──────────────────────────────────────────────────────────
score_history = []                              # 歷史戰績
image_cache = {"taipei": [], "europe": []}      # 街景預載快取
answer_places = {}                              # {(sid, round_idx): place_or_None}
answer_places_lock = threading.Lock()
# 遵守 Nominatim 使用政策：限每秒 1 次請求（鎖 + 時間戳節流）
_nominatim_lock = threading.Lock()
_nominatim_last = [0.0]


# ══════════════════════════════════════════════════════════
# 街景抓取與快取（Panoramax）
# ══════════════════════════════════════════════════════════

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


# ══════════════════════════════════════════════════════════
# 提示點計算（OSRM，僅歐洲模式使用）
# ══════════════════════════════════════════════════════════

# ── 用 OSRM 取得 (lat1,lon1)→(lat2,lon2) 的最快開車時間（小時）──
# 回傳 None 代表無路可達（落海等）或服務失敗。OSRM 座標順序為 lon,lat。
def _osrm_drive_hours(lat1, lon1, lat2, lon2):
    url = f"{OSRM_ROUTE_URL}/{lon1},{lat1};{lon2},{lat2}"
    try:
        r = http_session.get(url, params={"overview": "false"}, timeout=5)
        r.raise_for_status()
        j = r.json()
        if j.get("code") != "Ok" or not j.get("routes"):
            return None
        return j["routes"][0]["duration"] / 3600.0
    except Exception:
        return None


# ── 以答案為圓心，找一個到答案行車時間落在 2~8 小時的提示點 ──
# 隨機方位 + 依結果比例調整半徑逼近目標。找不到回傳 None。
def find_hint_point(ans_lat, ans_lon):
    calls = 0
    for _ in range(HINT_MAX_BEARINGS):
        if calls >= HINT_MAX_CALLS:
            break
        bearing = random.uniform(0, 360)
        radius = HINT_AVG_KMH * HINT_TARGET_H   # 初始半徑 ≈ 400 km
        for _ in range(4):
            if calls >= HINT_MAX_CALLS:
                break
            radius = max(30.0, min(1500.0, radius))
            cand_lat, cand_lon = destination_point(ans_lat, ans_lon, bearing, radius)
            hours = _osrm_drive_hours(cand_lat, cand_lon, ans_lat, ans_lon)
            calls += 1
            if hours is None:
                break   # 無路可達 → 換方位
            if HINT_MIN_H <= hours <= HINT_MAX_H:
                return {"lat": round(cand_lat, 6), "lon": round(cand_lon, 6),
                        "hours": round(hours, 1)}
            # 依比例調整半徑（時間與距離大致成正比）後再試
            radius = radius * (HINT_TARGET_H / hours)
    return None


# ══════════════════════════════════════════════════════════
# 反向地理編碼（Nominatim）與答案地名預查
# ══════════════════════════════════════════════════════════

# ── 用 Nominatim 反向地理編碼：座標 → 精簡地名（道路, 城市, 行政區, 國家）──
# 查不到或服務失敗回傳 None。
def reverse_geocode(lat, lon):
    params = {"format": "jsonv2", "lat": lat, "lon": lon,
              "zoom": 18, "accept-language": "zh-TW"}
    with _nominatim_lock:
        wait = 1.1 - (time.time() - _nominatim_last[0])
        if wait > 0:
            time.sleep(wait)          # 與上次請求間隔 >= 1 秒，遵守使用政策
        try:
            r = http_session.get(NOMINATIM_URL, params=params,
                                 headers=NOMINATIM_HEADERS, timeout=6)
            _nominatim_last[0] = time.time()
            r.raise_for_status()
            j = r.json()
        except Exception:
            _nominatim_last[0] = time.time()
            return None
    if not isinstance(j, dict) or j.get("error"):
        return None

    addr = j.get("address", {}) or {}
    road = addr.get("road") or addr.get("pedestrian") or addr.get("footway") \
        or addr.get("path") or addr.get("neighbourhood")
    locality = None
    for k in ("city", "town", "village", "municipality", "hamlet", "suburb", "county"):
        if addr.get(k):
            locality = addr[k]
            break
    region = addr.get("state") or addr.get("region") or addr.get("province")
    country = addr.get("country")

    parts = []
    for p in (road, locality, region, country):
        if p and p not in parts:
            parts.append(p)
    if parts:
        return ", ".join(parts)
    return j.get("display_name") or None


# ── 預先反查正確答案地名 ─────────────────────────────────
# 在題目確定時（/api/question）就背景反查答案地名並暫存，結算時直接取用，
# 結算階段只需再反查玩家猜測一筆，省去等待。以 session id 區隔不同玩家。
def _bg_geocode_answer(sid, rnd_idx, lat, lon):
    place = reverse_geocode(lat, lon)
    with answer_places_lock:
        answer_places[(sid, rnd_idx)] = place


def prefetch_answer_place(sid, rnd_idx, lat, lon):
    threading.Thread(target=_bg_geocode_answer,
                     args=(sid, rnd_idx, lat, lon), daemon=True).start()


# ══════════════════════════════════════════════════════════
# 圖片代理白名單（防 SSRF）
# ══════════════════════════════════════════════════════════

# 為避免 SSRF，只允許 https 且網域含 "panoramax" 的圖床。
def is_allowed_image_url(url):
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme != "https" or not u.netloc:
        return False
    return "panoramax" in u.netloc.lower()
