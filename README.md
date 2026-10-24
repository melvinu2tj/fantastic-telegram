# Zugkarte – Live-Zugverkehr als Desktop-Hintergrund

Alle Fern- und Regionalzüge in Deutschland als leuchtende Punkte auf dem Streckennetz.
Die Positionen werden aus dem Fahrplan und Echtzeit-Verspätungen berechnet
(es gibt keine öffentlichen GPS-Daten). Pünktliche Fernzüge leuchten warmweiß,
Regionalzüge türkis, ab 5 Minuten Verspätung färbt sich ein Zug orange, ab 15 Minuten rot.

**Karte:** https://melvinu2tj.github.io/fantastic-telegram/

## Als Desktop-Hintergrund einrichten (Windows 11)

1. **Lively Wallpaper** aus dem Microsoft Store installieren (kostenlos).
2. Lively öffnen, oben links auf **+** (Hintergrund hinzufügen) klicken.
3. Bei „Enter URL“ die Adresse der Karte einfügen und mit dem Pfeil bestätigen.
4. Lively fragt, auf welchem Bildschirm: den gewünschten Monitor wählen.
5. In Lively unter **Einstellungen → Leistung** einstellen:
   - „Andere Anwendung im Vollbild“: **Pausieren**
   - „Akkubetrieb“: **Pausieren** (nur bei Laptops wichtig)
6. Unter **Einstellungen → Allgemein** „Mit Windows starten“ einschalten.

Fertig. Nach einem Neustart startet Lively von selbst, sonst muss nichts laufen.

## Anpassen

Die Adresse lässt sich mit Zusätzen ergänzen, z. B.
`https://melvinu2tj.github.io/fantastic-telegram/?laender=1&versatz=0.15`

| Zusatz | Wirkung |
|---|---|
| `land=brandenburg` | Auf ein Bundesland zoomen, mehrere mit Komma: `land=berlin,brandenburg`. Städte ab 15.000 Einwohnern werden dann dezent beschriftet |
| `staedte=0` | Städtenamen beim Zoomen ausblenden (`staedte=1` zeigt sie auch in der Gesamtansicht) |
| `laender=1` | Bundesländergrenzen zeigen |
| `grenze=2.5` | Landesgrenzen dicker (Standard 1,8) |
| `versatz=0.15` | Karte um 15 % der Breite nach rechts schieben (negativ = links), z. B. damit Desktop-Icons frei bleiben |
| `fps=20` | Weniger Bilder pro Sekunde, spart Grafikleistung |
| `helligkeit=1.5` | Züge heller leuchten lassen |

Namen für `land`: baden-wuerttemberg, bayern, berlin, brandenburg, bremen, hamburg, hessen,
mecklenburg-vorpommern, niedersachsen, nordrhein-westfalen, rheinland-pfalz, saarland, sachsen,
sachsen-anhalt, schleswig-holstein, thueringen

## Wie es funktioniert

- **Monatlich** (`.github/workflows/netz.yml`): Bahnstrecken aus OpenStreetMap und Grenzen aus
  Natural Earth werden geladen und im Release `netz` abgelegt.
- **Täglich** (`.github/workflows/daten.yml`): Fahrplan von [gtfs.de](https://gtfs.de) laden,
  jede Fahrt mit [pfaedle](https://github.com/ad-freiburg/pfaedle) auf die echten Gleise legen,
  und die Karte auf GitHub Pages veröffentlichen.
- **Live** (`api/delays.js` auf Vercel): holt alle 30 Sekunden die Echtzeitdaten von gtfs.de
  und gibt nur die Verspätungen der Züge auf der Karte weiter.
- **Im Browser** (`web/`): berechnet für jeden Zug die Position zwischen zwei Halten und
  zeichnet ihn auf dem Gleis, mit sanftem Anfahren und Bremsen.

S-Bahnen lassen sich in `scripts/build_trips.py` mit `INCLUDE_SBAHN = True` zuschalten.

## Daten und Lizenzen

- Fahrplan und Echtzeit: gtfs.de, Daten von DELFI e.V. (CC BY 4.0 bzw. CC BY-SA 4.0)
- Streckennetz: © OpenStreetMap-Mitwirkende (ODbL)
- Grenzen: Natural Earth (gemeinfrei)
