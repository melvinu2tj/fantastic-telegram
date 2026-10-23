"""Einmalige Erkundung der Datenquellen (läuft in GitHub Actions)."""
import csv, io, sys, time, zipfile, urllib.request
from collections import Counter

FEEDS = {
    "fv": "https://download.gtfs.de/germany/fv_free/latest.zip",
    "rv": "https://download.gtfs.de/germany/rv_free/latest.zip",
}
RT = "https://realtime.gtfs.de/realtime-free.pb"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "zugkarte-probe", "Origin": "https://example.org"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read(), dict(r.headers)


trip_ids = {}
for name, url in FEEDS.items():
    data, _ = get(url)
    z = zipfile.ZipFile(io.BytesIO(data))
    print(f"\n=== {name}: {len(data)/1e6:.1f} MB")
    for i in z.infolist():
        print(f"  {i.filename:28s} {i.file_size/1e6:8.2f} MB")
    def rows(fn):
        return list(csv.DictReader(io.TextIOWrapper(z.open(fn), "utf-8-sig")))
    routes = rows("routes.txt")
    print("  route_type:", Counter(r["route_type"] for r in routes).most_common())
    print("  agencies:", Counter(r.get("agency_id") for r in routes).most_common(8))
    print("  route names sample:", [r.get("route_short_name") for r in routes[:40]])
    trips = rows("trips.txt")
    print("  trips:", len(trips), "keys:", list(trips[0].keys()))
    print("  trip sample:", trips[:2])
    trip_ids[name] = {t["trip_id"] for t in trips}
    st = z.open("stop_times.txt")
    print("  stop_times header+2:", [st.readline().decode().strip() for _ in range(3)])
    for fn in ("calendar.txt", "calendar_dates.txt", "stops.txt", "feed_info.txt"):
        if fn in z.namelist():
            f = z.open(fn)
            print(f"  {fn}:", [f.readline().decode().strip() for _ in range(3)])

for attempt in range(1):
    t = time.time()
    data, headers = get(RT)
    print(f"\n=== realtime: {len(data)/1e6:.2f} MB in {time.time()-t:.1f}s")
    print("  headers:", {k: v for k, v in headers.items()})
    try:
        from google.transit import gtfs_realtime_pb2
    except ImportError:
        sys.exit("gtfs-realtime-bindings fehlt")
    fm = gtfs_realtime_pb2.FeedMessage()
    fm.ParseFromString(data)
    print("  header:", fm.header)
    ents = list(fm.entity)
    tu = [e.trip_update for e in ents if e.HasField("trip_update")]
    print("  entities:", len(ents), "trip_updates:", len(tu))
    ids = [u.trip.trip_id for u in tu]
    for name, s in trip_ids.items():
        print(f"  match {name}: {sum(1 for i in ids if i in s)} of {len(s)} trips")
    matched = [u for u in tu if u.trip.trip_id in trip_ids["fv"]][:2]
    print("  fv sample:", [(u.trip, len(u.stop_time_update), u.stop_time_update[0] if u.stop_time_update else None) for u in matched])
    import random
    smp=random.sample(tu, 5)
    print("  random trip ids:", [(u.trip.trip_id, u.trip.route_id, u.trip.start_date) for u in smp])
    rl = Counter(u.trip.schedule_relationship for u in tu)
    print("  schedule_relationship:", rl)
    if attempt == 0:
        time.sleep(15)
