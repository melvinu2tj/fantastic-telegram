"""Fahrplan für die Karte aufbereiten.

  build_trips.py prepare <gtfs.zip> <outdir> <typ>   # Fahrten der nächsten Tage herausfiltern
  build_trips.py build <outdir> <de.geojson> <gtfsdir>...  # nach pfaedle: Abschnitte + Tagesdateien

typ: 0 = Fernverkehr, 1 = Regionalverkehr.
"""
import bisect, csv, datetime as dt, io, json, math, os, re, sys, zipfile
from collections import defaultdict
from zoneinfo import ZoneInfo
import geo

INCLUDE_SBAHN = False  # auf True setzen, um S-Bahnen mit anzuzeigen
SBAHN = re.compile(r"^S\s*\d*[A-Z]?$")
DAYS = range(-1, 3)  # gestern bis übermorgen
TZ = ZoneInfo("Europe/Berlin")
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def dates():
    today = dt.datetime.now(TZ).date()
    return [today + dt.timedelta(days=d) for d in DAYS]


def read(src, name):
    if isinstance(src, zipfile.ZipFile):
        return csv.DictReader(io.TextIOWrapper(src.open(name), "utf-8-sig"))
    path = os.path.join(src, name)
    return csv.DictReader(open(path, encoding="utf-8-sig")) if os.path.exists(path) else []


def active_services(src, day):
    ds, wd = day.strftime("%Y%m%d"), WEEKDAYS[day.weekday()]
    act = {r["service_id"] for r in read(src, "calendar.txt") if r["start_date"] <= ds <= r["end_date"] and r[wd] == "1"}
    for r in read(src, "calendar_dates.txt"):
        if r["date"] == ds:
            (act.add if r["exception_type"] == "1" else act.discard)(r["service_id"])
    return act


def prepare(zpath, outdir, typ):
    """Nur Fahrten behalten, die an einem der Tage fahren (und ggf. keine S-Bahnen)."""
    z = zipfile.ZipFile(zpath)
    os.makedirs(outdir, exist_ok=True)
    services = set().union(*(active_services(z, d) for d in dates()))
    routes = {}
    for r in read(z, "routes.txt"):
        if INCLUDE_SBAHN or not SBAHN.match(r["route_short_name"].strip()):
            routes[r["route_id"]] = r
    trips = [t for t in read(z, "trips.txt") if t["service_id"] in services and t["route_id"] in routes]
    keep = {t["trip_id"] for t in trips}

    def write(name, rows, fields=None):
        rows = list(rows)
        if not rows:
            return
        with open(os.path.join(outdir, name), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields or list(rows[0].keys()), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)

    write("routes.txt", routes.values())
    write("trips.txt", trips)
    write("stop_times.txt", (r for r in read(z, "stop_times.txt") if r["trip_id"] in keep))
    for name in ("agency.txt", "stops.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt"):
        if name in z.namelist():
            write(name, read(z, name))
    with open(os.path.join(outdir, "typ"), "w") as f:
        f.write(typ)
    print(f"{zpath}: {len(trips)} Fahrten behalten")


def point_in_poly(lon, lat, polys):
    for rings in polys:
        inside = False
        for ring in rings[:1]:
            j = len(ring) - 1
            for i in range(len(ring)):
                xi, yi = ring[i]
                xj, yj = ring[j]
                if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                    inside = not inside
                j = i
        if inside:
            return True
    return False


def secs(s):
    h, m, x = map(int, s.split(":"))
    return h * 3600 + m * 60 + x


def cut(shape, cum, a, b):
    """Teilstück der Linie zwischen den Distanzen a und b (in Rastereinheiten)."""
    def at(d):
        i = max(0, min(len(cum) - 2, bisect.bisect_right(cum, d) - 1))
        f = max(0.0, min(1.0, (d - cum[i]) / ((cum[i + 1] - cum[i]) or 1)))
        (x0, y0), (x1, y1) = shape[i], shape[i + 1]
        return i, (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
    ia, pa = at(a)
    ib, pb = at(b)
    return [pa] + shape[ia + 1:ib + 1] + [pb]


def from_dist(dist, cum, d):
    """Distanz laut GTFS (Meter) in Distanz entlang der projizierten Linie umrechnen."""
    i = max(0, min(len(dist) - 2, bisect.bisect_right(dist, d) - 1))
    f = max(0.0, min(1.0, (d - dist[i]) / ((dist[i + 1] - dist[i]) or 1)))
    return cum[i] + f * (cum[i + 1] - cum[i])


def locate(shape, cum, stops):
    """Haltestellen der Reihe nach auf die Linie projizieren (nur vorwärts)."""
    out, start = [], 0
    for sx, sy in stops:
        best_i, best_c, bd = start, cum[start], float("inf")
        for i in range(start, len(shape) - 1):
            if cum[i] - best_c > 3000 and bd < float("inf"):
                break  # deutlich hinter dem besten Treffer
            (x0, y0), (x1, y1) = shape[i], shape[i + 1]
            dx, dy = x1 - x0, y1 - y0
            L = dx * dx + dy * dy
            f = 0 if L == 0 else max(0, min(1, ((sx - x0) * dx + (sy - y0) * dy) / L))
            d = (x0 + f * dx - sx) ** 2 + (y0 + f * dy - sy) ** 2
            if d < bd:
                bd, best_i, best_c = d, i, cum[i] + f * math.sqrt(L)
        out.append(best_c)
        start = best_i
    return out


def build(outdir, de_geojson, *feeds):
    gj = json.load(open(de_geojson))
    polys = gj["coordinates"] if gj["type"] == "MultiPolygon" else [gj["coordinates"]]
    days = dates()
    seg_index, segs, hidden = {}, [], []
    day_trips = {d: [] for d in days}
    ids = set()
    for src in feeds:
        typ = int(open(os.path.join(src, "typ")).read())
        stops = {s["stop_id"]: (float(s["stop_lon"]), float(s["stop_lat"])) for s in read(src, "stops.txt")}
        routes = {r["route_id"]: r["route_short_name"].strip() or r.get("route_long_name", "") for r in read(src, "routes.txt")}
        shapes = defaultdict(list)
        for r in read(src, "shapes.txt"):
            d = r.get("shape_dist_traveled")
            shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"]), float(d) if d else None))
        proj = {}
        for k, pts in shapes.items():
            pts.sort()
            p = [geo.project(lon, lat) for _, lon, lat, _ in pts]
            cum = [0.0]
            for (x0, y0), (x1, y1) in zip(p, p[1:]):
                cum.append(cum[-1] + math.hypot(x1 - x0, y1 - y0))
            dist = [d for *_, d in pts]
            proj[k] = (p, cum, dist if None not in dist else None)
        del shapes
        st = defaultdict(list)
        for r in read(src, "stop_times.txt"):
            st[r["trip_id"]].append((int(r["stop_sequence"]), r))
        services = {d: active_services(src, d) for d in days}
        located = {}
        for t in read(src, "trips.txt"):
            rows = [r for _, r in sorted(st.get(t["trip_id"], []), key=lambda x: x[0])]
            if len(rows) < 2 or t.get("shape_id") not in proj:
                continue
            shape, cum, dist = proj[t["shape_id"]]
            stop_ids = tuple(r["stop_id"] for r in rows)
            key = (t["shape_id"], stop_ids)
            if key not in located:
                sd = [r.get("shape_dist_traveled") for r in rows]
                if dist and all(sd):
                    pos = [from_dist(dist, cum, float(x)) for x in sd]
                else:
                    pos = locate(shape, cum, [geo.project(*stops[s]) for s in stop_ids])
                legs = []
                for i in range(len(stop_ids) - 1):
                    line = geo.simplify(cut(shape, cum, pos[i], max(pos[i], pos[i + 1])), 1.5)
                    enc = geo.encode(line)
                    if len(enc) < 4:
                        a, b = geo.project(*stops[stop_ids[i]]), geo.project(*stops[stop_ids[i + 1]])
                        enc = geo.encode([a, b]) if (round(a[0]), round(a[1])) != (round(b[0]), round(b[1])) else [round(a[0]), round(a[1]), 0, 1]
                    sk = (stop_ids[i], stop_ids[i + 1], tuple(enc))
                    if sk not in seg_index:
                        seg_index[sk] = len(segs)
                        segs.append(enc)
                        if not (point_in_poly(*stops[stop_ids[i]], polys) or point_in_poly(*stops[stop_ids[i + 1]], polys)):
                            hidden.append(seg_index[sk])
                    legs.append(seg_index[sk])
                located[key] = legs
            legs = located[key]
            seqs = [int(r["stop_sequence"]) for r in rows]
            times, prev = [], None
            for r in rows:
                for v in (secs(r["arrival_time"] or r["departure_time"]), secs(r["departure_time"] or r["arrival_time"])):
                    v //= 60
                    times.append(v if prev is None else v - prev)
                    prev = v
            seq = seqs[0] if seqs == list(range(seqs[0], seqs[0] + len(seqs))) else seqs
            entry = [t["trip_id"], typ, routes.get(t["route_id"], ""), seq, legs, times]
            for d in days:
                if t["service_id"] in services[d]:
                    day_trips[d].append(entry)
                    ids.add(t["trip_id"])
        print(f"{src}: {sum(len(v) for v in day_trips.values())} Fahrten bisher, {len(segs)} Abschnitte")
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "segments.json"), "w") as f:
        json.dump({"meta": geo.meta(), "s": segs, "h": hidden}, f, separators=(",", ":"))
    for d, trips in day_trips.items():
        with open(os.path.join(outdir, f"day-{d:%Y%m%d}.json"), "w") as f:
            json.dump({"date": f"{d:%Y%m%d}", "trips": trips}, f, separators=(",", ":"))
    with open(os.path.join(outdir, "ids.json"), "w") as f:
        json.dump(sorted(ids), f, separators=(",", ":"))
    with open(os.path.join(outdir, "version.json"), "w") as f:
        json.dump({"built": dt.datetime.now(TZ).isoformat(timespec="minutes"), "days": [f"{d:%Y%m%d}" for d in days]}, f)


if __name__ == "__main__":
    {"prepare": prepare, "build": build}[sys.argv[1]](*sys.argv[2:])
