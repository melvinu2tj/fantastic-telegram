"""Erkundung: Echtzeit-Abdeckung für aktuell fahrende Züge (läuft in GitHub Actions)."""
import csv, io, zipfile, urllib.request, datetime as dt
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo
from google.transit import gtfs_realtime_pb2

TZ = ZoneInfo("Europe/Berlin")
FEEDS = {"fv": "https://download.gtfs.de/germany/fv_free/latest.zip",
         "rv": "https://download.gtfs.de/germany/rv_free/latest.zip"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "zugkarte"}), timeout=120) as r:
        return r.read()


fm = gtfs_realtime_pb2.FeedMessage()
fm.ParseFromString(get("https://realtime.gtfs.de/realtime-free.pb"))
rt = {e.trip_update.trip.trip_id: e.trip_update for e in fm.entity if e.HasField("trip_update")}
now = dt.datetime.fromtimestamp(fm.header.timestamp, TZ)
print("RT time", now, "trip updates", len(rt))
day = now.date()
ds = day.strftime("%Y%m%d")
wd = day.weekday()
secs_now = now.hour * 3600 + now.minute * 60 + now.second

for name, url in FEEDS.items():
    z = zipfile.ZipFile(io.BytesIO(get(url)))
    rows = lambda fn: csv.DictReader(io.TextIOWrapper(z.open(fn), "utf-8-sig"))
    active = set()
    for r in rows("calendar.txt"):
        if r["start_date"] <= ds <= r["end_date"] and r[["monday","tuesday","wednesday","thursday","friday","saturday","sunday"][wd]] == "1":
            active.add(r["service_id"])
    for r in rows("calendar_dates.txt"):
        if r["date"] == ds:
            (active.add if r["exception_type"] == "1" else active.discard)(r["service_id"])
    routes = {r["route_id"]: r for r in rows("routes.txt")}
    trips = {t["trip_id"]: t for t in rows("trips.txt") if t["service_id"] in active}
    st = defaultdict(list)
    for r in rows("stop_times.txt"):
        if r["trip_id"] in trips:
            st[r["trip_id"]].append(r)
    def sec(s):
        h, m, x = map(int, s.split(":")); return h * 3600 + m * 60 + x
    running = [t for t, s in st.items() if sec(s[0]["departure_time"]) <= secs_now <= sec(s[-1]["arrival_time"])]
    print(f"\n=== {name}: trips today {len(trips)}, running now {len(running)}")
    has = [t for t in running if t in rt]
    ok = 0
    for t in has:
        sids = {r["stop_id"] for r in st[t]}
        u = rt[t]
        if all((not x.stop_id) or x.stop_id in sids for x in u.stop_time_update):
            ok += 1
    print(f"  running with RT: {len(has)}, stop_ids consistent: {ok}")
    by_agency = Counter(routes[trips[t]["route_id"]]["agency_id"] for t in running)
    by_agency_rt = Counter(routes[trips[t]["route_id"]]["agency_id"] for t in has)
    print("  coverage by agency (running, with rt):", [(a, n, by_agency_rt[a]) for a, n in by_agency.most_common(25)])
    by_line = Counter(routes[trips[t]["route_id"]]["route_short_name"].split(" ")[0] for t in running)
    by_line_rt = Counter(routes[trips[t]["route_id"]]["route_short_name"].split(" ")[0] for t in has)
    print("  by product:", [(a, n, by_line_rt[a]) for a, n in by_line.most_common(30)])
    if name == "rv":
        print("  sample route names:", Counter(r["route_short_name"] for r in routes.values()).most_common(60))
    ag = {r["agency_id"]: r["agency_name"] for r in rows("agency.txt")}
    print("  agencies:", [(a, ag.get(a)) for a, _ in by_agency.most_common(25)])
