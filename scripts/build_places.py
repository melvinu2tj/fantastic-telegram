"""Bundesländer (für den Zoom) und Städte ab 15.000 Einwohnern (für die Beschriftung).

Aufruf: build_places.py admin1.geojson orte.json out.json
orte.json ist die Antwort einer Overpass-Abfrage nach place=city/town.
"""
import json, re, sys, unicodedata
from shapely.geometry import shape
import geo

MIN_EINWOHNER = 15000


def slug(name):
    s = name.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]+", "-", s).strip("-")


def einwohner(tags):
    m = re.match(r"\s*([\d.,\s]+)", tags.get("population", ""))
    if not m:
        return 0
    try:
        return int(re.sub(r"[.,\s]", "", m.group(1)))
    except ValueError:
        return 0


def main(a1, orte, out):
    laender = {}
    for f in json.load(open(a1))["features"]:
        p = f["properties"]
        if p["adm0_a3"] != "DEU":
            continue
        g = shape(f["geometry"])
        x0, y0 = geo.project(g.bounds[0], g.bounds[3])
        x1, y1 = geo.project(g.bounds[2], g.bounds[1])
        ringe = []
        for poly in getattr(g, "geoms", [g]):
            enc = geo.encode(geo.simplify([geo.project(x, y) for x, y in poly.exterior.coords], 4))
            if len(enc) >= 6:
                ringe.append(enc)
        laender[slug(p["name"])] = {"name": p["name"], "box": [round(x0), round(y0), round(x1), round(y1)], "umriss": ringe}
    staedte = []
    x0, y0, x1, y1 = geo.BBOX
    for e in json.load(open(orte))["elements"]:
        t = e.get("tags", {})
        n = einwohner(t)
        name = t.get("name:de") or t.get("name")
        if n < MIN_EINWOHNER or not name or not (x0 <= e["lon"] <= x1 and y0 <= e["lat"] <= y1):
            continue
        x, y = geo.project(e["lon"], e["lat"])
        staedte.append([round(x), round(y), name, n])
    staedte.sort(key=lambda s: -s[3])
    json.dump({"laender": laender, "staedte": staedte}, open(out, "w"), separators=(",", ":"), ensure_ascii=False)
    print("Bundesländer:", sorted(laender), "Städte:", len(staedte))


if __name__ == "__main__":
    main(*sys.argv[1:])
