// Verspätungsgrund für einen angeklickten Zug (läuft als Vercel-Funktion).
// Fragt die Fahrplan-Schnittstelle der Bahn (DB API Marketplace, "Timetables") am Zielbahnhof ab:
// Planankunft und Linie finden den Zug, die Änderungsmeldungen enthalten die Gründe als Codes.
// Braucht die Umgebungsvariablen DB_CLIENT_ID und DB_API_KEY (kostenloses Konto).
//   /api/grund?ziel=Ludwigslust&an=2610262032&name=RE8&nr=4711   ->   { gruende: ["…"] }
//   /api/grund?bahnhof=Ludwigslust                                ->   { eva: "8010216" }  (für den bahn.de-Link)

const API = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1";

// Bedeutung der Meldungscodes (IRIS)
const CODES = {
  2: "Polizeiliche Ermittlung", 3: "Feuerwehreinsatz an der Strecke", 4: "Kurzfristiger Personalausfall",
  5: "Ärztliche Versorgung eines Fahrgastes", 6: "Betätigen der Notbremse", 7: "Personen im Gleis",
  8: "Notarzteinsatz am Gleis", 9: "Streikauswirkungen", 10: "Tiere im Gleis", 11: "Unwetter",
  12: "Warten auf ein verspätetes Schiff", 13: "Pass- und Zollkontrolle", 14: "Technische Störung am Bahnhof",
  15: "Beeinträchtigung durch Vandalismus", 16: "Entschärfung einer Fliegerbombe", 17: "Beschädigung einer Brücke",
  18: "Umgestürzter Baum im Gleis", 19: "Unfall an einem Bahnübergang", 20: "Tiere im Gleis",
  21: "Warten auf Fahrgäste aus einem anderen Zug", 22: "Witterungsbedingte Störung",
  23: "Feuerwehreinsatz auf Bahngelände", 24: "Verspätung im Ausland", 25: "Warten auf weitere Wagen",
  28: "Gegenstände im Gleis", 29: "Ersatzverkehr mit Bus ist eingerichtet", 31: "Bauarbeiten",
  32: "Verzögerung beim Ein- und Ausstieg", 33: "Reparatur an der Oberleitung", 34: "Reparatur an einem Signal",
  35: "Streckensperrung", 36: "Reparatur am Zug", 37: "Reparatur am Wagen", 38: "Reparatur an der Strecke",
  39: "Anhängen von zusätzlichen Wagen", 40: "Defektes Stellwerk", 41: "Technische Störung an einem Bahnübergang",
  42: "Außerplanmäßige Geschwindigkeitsbeschränkung", 43: "Verspätung eines vorausfahrenden Zuges",
  44: "Warten auf einen entgegenkommenden Zug", 45: "Überholung durch anderen Zug", 46: "Warten auf freie Einfahrt",
  47: "Verspätete Bereitstellung des Zuges", 48: "Verspätung aus vorheriger Fahrt",
  55: "Technische Störung an einem anderen Zug", 56: "Warten auf Fahrgäste aus einem Bus",
  57: "Zusätzlicher Halt zum Ein- und Ausstieg", 58: "Umleitung des Zuges", 59: "Schnee und Eis",
  60: "Reduzierte Geschwindigkeit wegen Sturm", 61: "Türstörung", 62: "Behobene technische Störung am Zug",
  63: "Technische Untersuchung am Zug", 64: "Weichenstörung", 65: "Erdrutsch", 66: "Hochwasser",
  91: "Fahrradmitnahme nicht möglich", 99: "Verzögerungen im Betriebsablauf",
};

async function db(pfad) {
  const r = await fetch(API + pfad, {
    headers: { "DB-Client-Id": process.env.DB_CLIENT_ID, "DB-Api-Key": process.env.DB_API_KEY, Accept: "application/xml" },
  });
  if (!r.ok) throw new Error(pfad + ": " + r.status);
  return r.text();
}

// Einfache XML-Hilfen: reicht für die flachen Antworten dieser Schnittstelle
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
const stops = xml => xml.match(/<s\s[\s\S]*?<\/s>/g) || [];

const kurz = s => s.toLowerCase().replace(/\s+/g, "");

let evaCache = new Map();
async function eva(name) {
  if (!evaCache.has(name)) {
    const xml = await db("/station/" + encodeURIComponent(name));
    const st = xml.match(/<station\s[^>]*>/);
    evaCache.set(name, st ? attr(st[0], "eva") : null);
  }
  return evaCache.get(name);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  const q = new URL(req.url, "http://x").searchParams;
  if (q.get("bahnhof") && process.env.DB_CLIENT_ID) {
    try {
      res.setHeader("Cache-Control", "public, s-maxage=86400");
      return res.end(JSON.stringify({ eva: await eva(q.get("bahnhof")) }));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
  }
  const ziel = q.get("ziel"), an = q.get("an") || "", name = kurz(q.get("name") || ""), nr = q.get("nr") || "";
  if (!process.env.DB_CLIENT_ID || !ziel || !/^\d{10}$/.test(an)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ fehler: process.env.DB_CLIENT_ID && process.env.DB_API_KEY ? "Parameter fehlen" : "DB_CLIENT_ID oder DB_API_KEY fehlt" }));
  }
  try {
    const nummer = await eva(ziel);
    if (!nummer) return res.end(JSON.stringify({ gruende: [] }));
    // Planankunft am Ziel (Format YYMMddHHmm) und Linie bzw. Zugnummer finden den Zug
    const plan = await db(`/plan/${nummer}/${an.slice(0, 6)}/${an.slice(6, 8)}`);
    let id = null, best = -1;
    for (const s of stops(plan)) {
      const ar = s.match(/<ar\s[^>]*>/);
      if (!ar || attr(ar[0], "pt") !== an) continue;
      const tl = (s.match(/<tl\s[^>]*>/) || [""])[0];
      const c = attr(tl, "c") || "", n = attr(tl, "n") || "", l = attr(ar[0], "l") || "";
      const punkte = (nr && n === nr ? 4 : 0) + (kurz(c + l) === name || kurz(c + n) === name ? 2 : 0) + (name.startsWith(kurz(c)) ? 1 : 0);
      if (punkte > best) { best = punkte; id = attr(s, "id"); }
    }
    if (!id) return res.end(JSON.stringify({ gruende: [] }));
    // Aktuelle Änderungen am Ziel: Meldungen vom Typ "d" sind Verspätungsgründe
    const aenderungen = await db(`/fchg/${nummer}`);
    const s = stops(aenderungen).find(x => attr(x, "id") === id) || "";
    const meldungen = (s.match(/<m\s[^>]*>/g) || [])
      .filter(m => attr(m, "t") === "d" && CODES[+attr(m, "c")])
      .map(m => ({ text: CODES[+attr(m, "c")], ts: attr(m, "ts") || "" }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    const gruende = [...new Set(meldungen.map(m => m.text))].slice(0, 3);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.end(JSON.stringify({ gruende }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ fehler: String(e.message || e) }));
  }
};
