// Echtzeit-Verspätungen für die Karte (läuft als Vercel-Funktion).
// Lädt den GTFS-Realtime-Feed von gtfs.de (~10 MB), behält nur Fern- und Regionalzüge,
// die auch auf der Karte sind, und liefert kompaktes JSON:
//   { t: Zeitstempel, d: { "tripId|YYYYMMDD": [seq, ankunft, abfahrt, ...] }, c: [ausgefallene Fahrten] }
// Verspätungen in Sekunden; fehlender Wert = null.

const FEED = "https://realtime.gtfs.de/realtime-free.pb";
const IDS = process.env.IDS_URL || "https://melvinu2tj.github.io/fantastic-telegram/data/ids.json";

let ids = null, idsAt = 0;
let cache = null, cacheAt = 0;

async function tripIds() {
  if (!ids || Date.now() - idsAt > 3600e3) {
    const r = await fetch(IDS);
    if (r.ok) { ids = new Set(await r.json()); idsAt = Date.now(); }
  }
  return ids;
}

// Minimaler Protobuf-Leser: nur was GTFS-Realtime hier braucht.
function reader(buf, pos, end) {
  return {
    pos, end,
    varint() {
      let x = 0, s = 0, b;
      do { b = buf[this.pos++]; x += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
      return x;
    },
    int32() { // negative Werte kommen als 10-Byte-Varint, nur die unteren 32 Bit zählen
      let x = 0, s = 0, b;
      do { b = buf[this.pos++]; if (s < 32) x |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
      return x | 0;
    },
    // liefert [feld, typ] oder null am Ende
    tag() { return this.pos < this.end ? (t => [Math.floor(t / 8), t & 7])(this.varint()) : null; },
    sub() { const n = this.varint(); const r = reader(buf, this.pos, this.pos + n); this.pos += n; return r; },
    str() { const n = this.varint(); const s = buf.toString("utf8", this.pos, this.pos + n); this.pos += n; return s; },
    skip(type) {
      if (type === 0) this.varint();
      else if (type === 1) this.pos += 8;
      else if (type === 2) { const n = this.varint(); this.pos += n; }
      else if (type === 5) this.pos += 4;
      else throw new Error("wire type " + type);
    },
  };
}

function delayOf(r) {
  for (let t; (t = r.tag());) { if (t[0] === 1 && t[1] === 0) return r.int32(); r.skip(t[1]); }
  return null;
}

function decode(buf, keep) {
  const top = reader(buf, 0, buf.length);
  const out = { t: 0, d: {}, c: [] };
  for (let t; (t = top.tag());) {
    if (t[0] === 1 && t[1] === 2) { // header
      const h = top.sub();
      for (let u; (u = h.tag());) { if (u[0] === 3) out.t = h.varint(); else h.skip(u[1]); }
    } else if (t[0] === 2 && t[1] === 2) { // entity
      const e = top.sub();
      for (let u; (u = e.tag());) {
        if (u[0] !== 3 || u[1] !== 2) { e.skip(u[1]); continue; }
        const tu = e.sub();
        let id = null, date = "", canceled = false;
        const stops = [];
        for (let v; (v = tu.tag());) {
          if (v[0] === 1 && v[1] === 2) { // trip
            const td = tu.sub();
            for (let w; (w = td.tag());) {
              if (w[0] === 1) id = td.str();
              else if (w[0] === 3) date = td.str();
              else if (w[0] === 4) canceled = td.varint() === 3;
              else td.skip(w[1]);
            }
            if (!keep.has(id)) break; // nicht auf der Karte: Rest überspringen
          } else if (v[0] === 2 && v[1] === 2) { // stop_time_update
            const s = tu.sub();
            let seq = null, arr = null, dep = null, skipped = false;
            for (let w; (w = s.tag());) {
              if (w[0] === 1) seq = s.varint();
              else if (w[0] === 2 && w[1] === 2) arr = delayOf(s.sub());
              else if (w[0] === 3 && w[1] === 2) dep = delayOf(s.sub());
              else if (w[0] === 5) skipped = s.varint() === 1;
              else s.skip(w[1]);
            }
            if (seq !== null && !skipped && (arr !== null || dep !== null)) stops.push(seq, arr, dep);
          } else tu.skip(v[1]);
        }
        if (id === null || !keep.has(id)) continue;
        const key = id + "|" + date;
        if (canceled) out.c.push(key);
        else if (stops.length) out.d[key] = compact(stops);
      }
    } else top.skip(t[1]);
  }
  return out;
}

// Nur Halte behalten, an denen sich die Verspätung ändert (die Karte führt sie weiter).
function compact(s) {
  const out = [];
  let la, ld;
  for (let i = 0; i < s.length; i += 3) {
    const a = s[i + 1], d = s[i + 2];
    if (i === 0 || a !== la || d !== ld) out.push(s[i], a, d);
    la = a; ld = d;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!cache || Date.now() - cacheAt > 20e3) {
      const [keep, r] = await Promise.all([tripIds(), fetch(FEED)]);
      if (!r.ok) throw new Error("Feed " + r.status);
      if (!keep) throw new Error("Fahrtenliste nicht erreichbar");
      cache = JSON.stringify(decode(Buffer.from(await r.arrayBuffer()), keep));
      cacheAt = Date.now();
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.end(cache);
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};

module.exports.decode = decode;
