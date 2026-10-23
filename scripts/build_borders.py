"""Länder- und Bundesländergrenzen (Natural Earth) für die Karte vorbereiten.

Aufruf: build_borders.py admin0.geojson admin1.geojson outdir
Schreibt borders.json (Linien im Kartenraster) und de.geojson (Deutschland-Umriss
in Längen/Breiten, für den Test "liegt ein Abschnitt in Deutschland").
"""
import json, sys
from shapely.geometry import shape, box, mapping
import geo


def lines_of(geom):
    out = []
    for poly in getattr(geom, "geoms", [geom]):
        for ring in [poly.exterior, *poly.interiors]:
            pts = geo.simplify([geo.project(x, y) for x, y in ring.coords], 8)
            enc = geo.encode(pts)
            if len(enc) >= 6:
                out.append(enc)
    return out


def main(a0, a1, outdir):
    clip = box(*geo.BBOX)
    countries, de = [], None
    for f in json.load(open(a0))["features"]:
        g = shape(f["geometry"])
        if not g.intersects(clip):
            continue
        if f["properties"]["ADM0_A3"] == "DEU":
            de = g
        countries += lines_of(g.intersection(clip))
    states = [shape(f["geometry"]) for f in json.load(open(a1))["features"] if f["properties"]["adm0_a3"] == "DEU"]
    # Innere Grenzen = Bundesländer-Umrisse; die Außengrenze ist schon bei den Ländern
    state_lines = []
    for s in states:
        state_lines += lines_of(s)
    json.dump({"countries": countries, "states": state_lines}, open(f"{outdir}/borders.json", "w"), separators=(",", ":"))
    json.dump(mapping(de.buffer(0.02)), open(f"{outdir}/de.geojson", "w"))
    print("Ländergrenzen:", len(countries), "Bundesländer:", len(state_lines))


if __name__ == "__main__":
    main(*sys.argv[1:])
