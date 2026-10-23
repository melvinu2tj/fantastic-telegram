"""Gemeinsame Projektion: Web-Mercator, Bildausschnitt 16:9 um Deutschland.

Koordinaten werden in ein ganzzahliges Raster projiziert: x von 0..W, y von 0..H
(y nach unten). Die Seite skaliert dieses Raster auf den Bildschirm.
"""
import math

CENTER_LON = 10.45
LAT_TOP, LAT_BOTTOM = 55.4, 46.9
W, H = 32000, 18000  # 16:9, ~75 m pro Einheit


def _y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


_Y0, _Y1 = _y(LAT_TOP), _y(LAT_BOTTOM)
_SCALE = H / (_Y0 - _Y1)
_SPAN_LON = math.degrees(W / _SCALE)
LON_LEFT = CENTER_LON - _SPAN_LON / 2
LON_RIGHT = CENTER_LON + _SPAN_LON / 2

# Bereich, aus dem Daten geladen werden: Bildausschnitt plus Rand für breitere Bildschirme
BBOX = (LON_LEFT - 3, LAT_BOTTOM - 1.5, LON_RIGHT + 3, LAT_TOP + 1.5)


def project(lon, lat):
    return (math.radians(lon - LON_LEFT) * _SCALE, (_Y0 - _y(lat)) * _SCALE)


def meta():
    return {"w": W, "h": H, "lonLeft": LON_LEFT, "lonRight": LON_RIGHT,
            "latTop": LAT_TOP, "latBottom": LAT_BOTTOM}


def simplify(pts, tol):
    """Douglas-Peucker, iterativ."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy) or 1e-9
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / n if n > 1e-9 else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def encode(pts):
    """Runden und Delta-kodieren: [x0, y0, dx1, dy1, ...]."""
    out, px, py = [], 0, 0
    for i, (x, y) in enumerate(pts):
        x, y = round(x), round(y)
        if i and x == px and y == py:
            continue
        out += [x - px, y - py] if i else [x, y]
        px, py = x, y
    return out
