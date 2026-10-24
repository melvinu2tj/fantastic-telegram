"""Streckennetz aus OSM-Ausschnitten (railway=rail plus S-Bahn) in kompaktes JSON umwandeln.

Aufruf: build_network.py out.json de.osm.pbf [ausland1.osm.pbf ...]
Die erste Datei ist Deutschland. Klassen:
  0 = DE mit Personenverkehr, 1 = DE nur Güterverkehr, 2 = Ausland
"""
import json, sys
import osmium
import geo

TOL = 6  # Vereinfachung in Rastereinheiten (~450 m), bei Bildschirmauflösung unsichtbar
SKIP_USAGE = {"industrial", "military", "test", "tourism"}


class Relations(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.passenger = set()

    def relation(self, r):
        if r.tags.get("route") in ("train", "railway", "light_rail"):
            for m in r.members:
                if m.type == "w":
                    self.passenger.add(m.ref)


class Ways(osmium.SimpleHandler):
    def __init__(self, cls_of, seen):
        super().__init__()
        self.cls_of, self.seen, self.lines = cls_of, seen, [[], [], []]

    def way(self, w):
        t = w.tags
        # S-Bahn Berlin/Hamburg: light_rail mit Stromschiene; Stadtbahnen (Oberleitung) bleiben draußen
        sbahn = t.get("railway") == "light_rail" and t.get("electrified") == "rail"
        if (t.get("railway") != "rail" and not sbahn) or "service" in t or t.get("usage") in SKIP_USAGE or w.id in self.seen:
            return
        self.seen.add(w.id)
        x0, y0, x1, y1 = geo.BBOX
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not any(x0 <= lon <= x1 and y0 <= lat <= y1 for lon, lat in pts):
            return
        pts = geo.simplify([geo.project(lon, lat) for lon, lat in pts], TOL)
        enc = geo.encode(pts)
        if len(enc) >= 4:
            self.lines[self.cls_of(w)].append(enc)


def main(out, de, *foreign):
    rel = Relations()
    rel.apply_file(de)
    seen, lines = set(), [[], [], []]
    h = Ways(lambda w: 0 if w.id in rel.passenger or w.tags.get("railway") == "light_rail" else 1, seen)
    h.apply_file(de, locations=True)
    for i in range(3):
        lines[i] += h.lines[i]
    for f in foreign:
        h = Ways(lambda w: 2, seen)
        h.apply_file(f, locations=True)
        lines[2] += h.lines[2]
    print("Linien je Klasse:", [len(l) for l in lines], "Punkte:", [sum(len(x) // 2 for x in l) for l in lines])
    with open(out, "w") as fh:
        json.dump({"meta": geo.meta(), "lines": lines}, fh, separators=(",", ":"))


if __name__ == "__main__":
    main(*sys.argv[1:])
