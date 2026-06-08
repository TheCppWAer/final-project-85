import math

from config import SCORE_K, SCORE_SCALE

# 純數學工具：不依賴 Flask、不發網路請求，最容易單元測試。

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


# ── 由起點沿方位角前進指定距離，求終點座標（大圓 destination point）──
def destination_point(lat, lon, bearing_deg, dist_km):
    R = 6371.0
    d = dist_km / R
    th = math.radians(bearing_deg)
    phi1, lam1 = math.radians(lat), math.radians(lon)
    phi2 = math.asin(math.sin(phi1) * math.cos(d) +
                     math.cos(phi1) * math.sin(d) * math.cos(th))
    lam2 = lam1 + math.atan2(math.sin(th) * math.sin(d) * math.cos(phi1),
                             math.cos(d) - math.sin(phi1) * math.sin(phi2))
    out_lat = math.degrees(phi2)
    out_lon = (math.degrees(lam2) + 540) % 360 - 180   # 正規化到 -180~180
    return out_lat, out_lon
