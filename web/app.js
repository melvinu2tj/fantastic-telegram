// Zugkarte: Fern- und Regionalzüge als leuchtende Punkte auf dem Streckennetz.
// Positionen werden aus Fahrplan und Verspätungen berechnet (keine GPS-Daten).
"use strict";

const cfg = Object.assign({}, window.ZUGKARTE);
for (const [k, v] of new URLSearchParams(location.search)) {
  cfg[k] = v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : isNaN(+v) ? v : +v;
}

const DATA = "data/";
const DAY = 86400;
const status = document.getElementById("status");
const netz = document.getElementById("netz");
const zuege = document.getElementById("zuege");
const ctx = zuege.getContext("2d");

// Farben
const FARBE = {
  fern: [255, 232, 194],      // warmweiß
  regio: [79, 214, 230],      // türkis
  orange: [255, 154, 60],
  rot: [255, 59, 48],
};
const SPUREN = [
  { farbe: "rgba(150,170,205,0.30)", breite: 0.9 },   // Deutschland, Personenverkehr
  { farbe: "rgba(150,170,205,0.13)", breite: 0.7 },   // Deutschland, nur Güter
  { farbe: "rgba(150,170,205,0.10)", breite: 0.6 },   // Ausland
];
// Deutschland im Raster (für Zoom bei Bildschirmen, die nicht 16:9 sind)
const DE_BOX = { x0: 0, y0: 0, x1: 0, y1: 0 };

let meta = null, netzDaten = null, grenzen = null, orte = null, zoomLaender = [];
let innen = null, aussen = null;   // Umriss der gewählten Bundesländer und alles außerhalb
let segs = [], hidden = new Set();
let fahrten = new Map();     // "tripId|YYYYMMDD" -> Fahrt
let aktiv = [];
let verspaetung = { d: {}, c: [] };
let version = null;
let view = { s: 1, ox: 0, oy: 0, k: 1, dpr: 1 };

// ---------- Zeit ----------

// Sekunden seit Mitternacht in Berlin und das Datum dort, unabhängig von der PC-Zeitzone
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function berlin(ms = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const datum = p.year + p.month + p.day;
  return { datum, sek: +p.hour * 3600 + +p.minute * 60 + +p.second + (ms % 1000) / 1000 };
}
function tageZwischen(a, b) { // b - a in Tagen, Datum als YYYYMMDD
  const d = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d(b) - d(a)) / 864e5);
}
function datumPlus(s, n) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) + n * 864e5);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ---------- Daten laden ----------

async function json(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(url + ": " + r.status);
  return r.json();
}

function dekodiere(enc) {
  const n = enc.length / 2, pts = new Float32Array(enc.length), cum = new Float32Array(n);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += enc[2 * i]; y += enc[2 * i + 1];
    pts[2 * i] = x; pts[2 * i + 1] = y;
    if (i) cum[i] = cum[i - 1] + Math.hypot(x - pts[2 * i - 2], y - pts[2 * i - 1]);
  }
  return { pts, cum, len: cum[n - 1] };
}

async function ladeGrunddaten() {
  const [s, n, g, v] = await Promise.all([
    json(DATA + "segments.json"), json(DATA + "network.json"),
    json(DATA + "borders.json"), json(DATA + "version.json"),
  ]);
  meta = s.meta;
  segs = s.s.map(dekodiere);
  hidden = new Set(s.h);
  netzDaten = n.lines;
  grenzen = g;
  version = v.built;
  // Bundesländer und Städte (optional, nur für Zoom und Beschriftung)
  try { orte = await json(DATA + "places.json"); } catch (e) { orte = null; }
  if (cfg.land && orte) {
    zoomLaender = String(cfg.land).toLowerCase().split(/[,+ ]+/).map(x => orte.laender[x]).filter(Boolean);
  }
  // Deutschland-Ausschnitt aus Längen/Breiten ins Raster
  const proj = (lon, lat) => {
    const y = l => Math.log(Math.tan(Math.PI / 4 + (l * Math.PI / 180) / 2));
    const sc = meta.h / (y(meta.latTop) - y(meta.latBottom));
    return [((lon - meta.lonLeft) * Math.PI / 180) * sc, (y(meta.latTop) - y(lat)) * sc];
  };
  [DE_BOX.x0, DE_BOX.y0] = proj(5.7, 55.15);
  [DE_BOX.x1, DE_BOX.y1] = proj(15.2, 47.2);
}

async function ladeTag(datum) {
  const d = await json(DATA + "day-" + datum + ".json");
  for (const [id, typ, name, seq, legs, dt] of d.trips) {
    const t = new Int32Array(dt.length);
    let acc = 0;
    for (let i = 0; i < dt.length; i++) { acc += dt[i]; t[i] = acc * 60; }
    const n = legs.length + 1;
    const seqs = Array.isArray(seq) ? seq : Array.from({ length: n }, (_, i) => seq + i);
    fahrten.set(id + "|" + datum, {
      key: id + "|" + datum, datum, fern: typ === 0, name, legs, seqs,
      plan: t, ist: t, verzug: new Int32Array(n), weg: false,
    });
  }
}

let geladeneTage = new Set();
async function sichereTage() {
  const { datum, sek } = berlin();
  const noetig = [datumPlus(datum, -1), datum];
  if (sek > 23 * 3600) noetig.push(datumPlus(datum, 1));
  for (const d of noetig) {
    if (geladeneTage.has(d)) continue;
    try { await ladeTag(d); geladeneTage.add(d); } catch (e) { console.warn(e); }
  }
  for (const d of geladeneTage) {
    if (!noetig.includes(d) && tageZwischen(d, datum) > 1) {
      for (const [k, f] of fahrten) if (f.datum === d) fahrten.delete(k);
      geladeneTage.delete(d);
    }
  }
}

// ---------- Verspätungen ----------

// Neue Verspätungen werden nicht schlagartig übernommen, sondern über UEBERGANG Sekunden
// eingeblendet. Sonst springt ein Zug, sobald sich seine Prognose um ein paar Minuten ändert.
const UEBERGANG = 90;

function berechneIst(f, u) {
  const n = f.seqs.length, ist = new Int32Array(2 * n);
  const upd = new Map();
  for (let i = 0; i < u.length; i += 3) upd.set(u[i], [u[i + 1], u[i + 2]]);
  let d = 0, letzte = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = upd.get(f.seqs[i]);
    let an = d, ab = d;
    if (x) {
      an = x[0] ?? x[1]; ab = x[1] ?? x[0];
    }
    const ta = Math.max(f.plan[2 * i] + an, letzte);
    const tb = Math.max(f.plan[2 * i + 1] + ab, ta);
    ist[2 * i] = ta; ist[2 * i + 1] = tb; letzte = tb;
    f.verzug[i] = ta - f.plan[2 * i];
    d = ab;
  }
  return ist;
}

function wendeVerspaetungAn(f, u, jetztMs, sofort) {
  const neu = u ? berechneIst(f, u) : f.plan;
  if (!u) f.verzug.fill(0);
  // Startpunkt des Übergangs ist das, was gerade angezeigt wird
  f.von = sofort ? null : Float64Array.from(zeiten(f, jetztMs).subarray(0, f.ist.length));
  f.ist = neu;
  f.seit = jetztMs;
}

// Aktuell gültige Zeiten einer Fahrt (während eines Übergangs gemischt)
let puffer = new Float64Array(256);
function zeiten(f, jetztMs) {
  if (!f.von) return f.ist;
  const k = (jetztMs - f.seit) / (UEBERGANG * 1000);
  if (k >= 1) { f.von = null; return f.ist; }
  const m = k * k * (3 - 2 * k);
  if (puffer.length < f.ist.length) puffer = new Float64Array(f.ist.length * 2);
  for (let i = 0; i < f.ist.length; i++) puffer[i] = f.von[i] + (f.ist[i] - f.von[i]) * m;
  return puffer;
}

let mitUpdate = new Set(), ersteDaten = true;
async function ladeVerspaetungen() {
  if (!cfg.delaysUrl) return;
  try {
    verspaetung = await json(cfg.delaysUrl);
    const jetztMs = Date.now();
    const neu = new Set(Object.keys(verspaetung.d));
    // Nur Fahrten anfassen, die jetzt oder vorher Verspätungsdaten hatten
    for (const key of new Set([...neu, ...mitUpdate])) {
      const f = fahrten.get(key);
      if (!f) continue;
      const u = verspaetung.d[key];
      if (!u && !mitUpdate.has(key)) continue;
      if (u && f.roh === JSON.stringify(u)) continue; // unverändert
      f.roh = u ? JSON.stringify(u) : null;
      wendeVerspaetungAn(f, u, jetztMs, ersteDaten);
    }
    mitUpdate = neu;
    ersteDaten = false;
    for (const f of fahrten.values()) f.weg = false;
    for (const key of verspaetung.c || []) { const f = fahrten.get(key); if (f) f.weg = true; }
    waehleAktive();
  } catch (e) { console.warn("Verspätungen:", e); }
}

// ---------- Darstellung ----------

function groesse() {
  const dpr = window.devicePixelRatio || 1;
  const w = innerWidth, h = innerHeight;
  for (const c of [netz, zuege]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  if (!meta) return;
  let s, cx, cy, zoom = 1;
  if (zoomLaender.length) {
    // Auf die gewählten Bundesländer zoomen (mit etwas Rand)
    const b = zoomLaender.reduce((a, l) => [Math.min(a[0], l.box[0]), Math.min(a[1], l.box[1]),
      Math.max(a[2], l.box[2]), Math.max(a[3], l.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    s = Math.min(w / (b[2] - b[0]), h / (b[3] - b[1])) / 1.12;
    cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2;
    zoom = s / (h / (DE_BOX.y1 - DE_BOX.y0));
  } else {
    // Füllend skalieren, aber Deutschland muss ganz sichtbar bleiben
    const fuell = Math.max(w / meta.w, h / meta.h);
    const de = Math.min(w / (DE_BOX.x1 - DE_BOX.x0) / 1.08, h / (DE_BOX.y1 - DE_BOX.y0) / 1.08);
    s = Math.min(fuell, de);
    cx = (DE_BOX.x0 + DE_BOX.x1) / 2; cy = (DE_BOX.y0 + DE_BOX.y1) / 2;
  }
  s *= dpr;
  view = {
    s, dpr, zoom, basis: (h / 1080) * dpr,
    // Punkte und Linien wachsen beim Zoomen etwas mit, aber nicht im vollen Maßstab
    k: (h / 1080) * dpr * (1 + 0.3 * Math.log2(Math.max(1, zoom))),
    ox: w * dpr / 2 + (cfg.versatz || 0) * w * dpr - cx * s,
    oy: h * dpr / 2 - cy * s,
  };
  innen = aussen = null;
  if (zoomLaender.length) {
    innen = new Path2D(); aussen = new Path2D();
    aussen.rect(0, 0, w * dpr, h * dpr);
    for (const l of zoomLaender) for (const enc of l.umriss) {
      for (const p of [innen, aussen]) { linie(p, enc); p.closePath(); }
    }
  }
  zeichneNetz();
  baueSprites();
}

function linie(c, enc) {
  let x = enc[0], y = enc[1];
  c.moveTo(x * view.s + view.ox, y * view.s + view.oy);
  for (let i = 2; i < enc.length; i += 2) {
    x += enc[i]; y += enc[i + 1];
    c.lineTo(x * view.s + view.ox, y * view.s + view.oy);
  }
}

function zeichneNetz() {
  const c = netz.getContext("2d");
  c.fillStyle = "#04060a";
  c.fillRect(0, 0, netz.width, netz.height);
  c.lineJoin = c.lineCap = "round";
  const strich = (liste, farbe, breite) => {
    c.beginPath();
    for (const enc of liste) linie(c, enc);
    c.strokeStyle = farbe; c.lineWidth = breite * view.k; c.stroke();
  };
  strich(grenzen.countries, "rgba(170,185,210,0.18)", cfg.grenze || 1.8);
  const zoomt = zoomLaender.length > 0;
  if (cfg.laender || zoomt) strich(grenzen.states, "rgba(170,185,210,0.10)", 0.8);
  for (const i of [2, 1, 0]) strich(netzDaten[i], SPUREN[i].farbe, SPUREN[i].breite);
  if (zoomt) {
    // Alles außerhalb der gewählten Bundesländer abdunkeln
    c.fillStyle = "rgba(4,6,10,0.6)";
    c.fill(aussen, "evenodd");
    c.strokeStyle = "rgba(170,185,210,0.24)"; c.lineWidth = 1.1 * view.k; c.stroke(innen);
  }
  if (orte && (cfg.staedte ?? zoomt)) zeichneStaedte(c);
}

// Städtenamen: größte zuerst, überlappende werden weggelassen
function zeichneStaedte(c) {
  const k = view.basis, belegt = [];
  const W = netz.width, H = netz.height;
  c.textBaseline = "middle";
  for (const [x, y, name, ew] of orte.staedte) {
    const px = x * view.s + view.ox, py = y * view.s + view.oy;
    if (px < 0 || py < 0 || px > W || py > H) continue;
    const gross = ew >= 100000;
    const fs = (gross ? 12.5 : 11) * view.basis;
    c.font = `${gross ? 500 : 400} ${fs}px system-ui, "Segoe UI", sans-serif`;
    const bw = c.measureText(name).width, r = [px + 4 * k, py - fs * 0.6, px + 4 * k + bw, py + fs * 0.6];
    if (belegt.some(b => r[0] < b[2] + 4 && r[2] > b[0] - 4 && r[1] < b[3] + 2 && r[3] > b[1] - 2)) continue;
    belegt.push(r);
    // Außerhalb der gewählten Bundesländer nur halb so hell
    const a = (gross ? 0.50 : 0.32) * (innen && !c.isPointInPath(innen, px, py) ? 0.45 : 1);
    c.fillStyle = `rgba(190,203,225,${a})`;
    c.beginPath(); c.arc(px, py, 1.3 * k, 0, 2 * Math.PI); c.fill();
    c.fillText(name, r[0], py);
  }
}

// Vorberechnete Leuchtpunkte: je Zugart und Verspätungsstufe
const STUFEN = 12;
let sprites = { fern: [], regio: [] };
function mische(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function farbeFuer(basis, stufe) {
  if (stufe === 0) return basis;
  const t = (stufe - 1) / (STUFEN - 2);   // 5 → 15 Minuten
  return mische(FARBE.orange, FARBE.rot, t);
}
function sprite(rgb, kern, glanz) {
  const r = Math.ceil(glanz), c = document.createElement("canvas");
  c.width = c.height = 2 * r + 2;
  const g = c.getContext("2d"), m = r + 1;
  const hell = cfg.helligkeit || 1;
  const grad = g.createRadialGradient(m, m, 0, m, m, glanz);
  const [R, G, B] = rgb;
  grad.addColorStop(0, `rgba(${R},${G},${B},${0.55 * hell})`);
  grad.addColorStop(kern / glanz, `rgba(${R},${G},${B},${0.28 * hell})`);
  grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.beginPath(); g.arc(m, m, kern, 0, 2 * Math.PI);
  g.fillStyle = `rgba(${mische(rgb, [255, 255, 255], 0.55).join(",")},${Math.min(1, hell)})`;
  g.fill();
  return { c, m };
}
function baueSprites() {
  const k = view.k;
  for (const [art, kern, glanz] of [["fern", 2.1, 9], ["regio", 1.25, 5.5]]) {
    sprites[art] = Array.from({ length: STUFEN }, (_, i) => sprite(farbeFuer(FARBE[art], i), kern * k, glanz * k));
  }
}
function stufe(verzugSek) {
  const min = verzugSek / 60;
  if (min < 5) return 0;
  return 1 + Math.min(STUFEN - 2, Math.round((min - 5) / 10 * (STUFEN - 2)));
}

// Fahrten, die gerade unterwegs sein können (alle 15 s neu bestimmt)
function waehleAktive() {
  const { datum, sek } = berlin();
  aktiv = [];
  for (const f of fahrten.values()) {
    if (f.weg) continue;
    const jetzt = sek + tageZwischen(f.datum, datum) * DAY;
    if (f.ist[1] - 30 <= jetzt + 60 && jetzt - 60 <= f.ist[f.ist.length - 2]) aktiv.push(f);
  }
}

// Anfahren und Bremsen: Geschwindigkeit steigt/fällt in den ersten/letzten 12 % der Fahrzeit
const R = 0.12, VMAX = 1 / (1 - R);
function weg(f) {
  if (f < R) return VMAX * f * f / (2 * R);
  if (f > 1 - R) return 1 - VMAX * (1 - f) * (1 - f) / (2 * R);
  return VMAX * (f - R / 2);
}

function punktAuf(seg, anteil, out) {
  const d = anteil * seg.len, cum = seg.cum;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const a = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (d - cum[lo]) / a));
  out[0] = seg.pts[2 * lo] + (seg.pts[2 * hi] - seg.pts[2 * lo]) * t;
  out[1] = seg.pts[2 * lo + 1] + (seg.pts[2 * hi + 1] - seg.pts[2 * lo + 1]) * t;
}

const P = [0, 0];
function zeichneZuege() {
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, zuege.width, zuege.height);
  ctx.globalCompositeOperation = "lighter";
  const { datum, sek } = berlin();
  const jetztMs = Date.now();
  // Erst Regio, dann Fern, damit ICEs obenauf leuchten
  for (const fern of [false, true]) {
    const sp = sprites[fern ? "fern" : "regio"];
    for (const f of aktiv) {
      if (f.fern !== fern) continue;
      const jetzt = sek + tageZwischen(f.datum, datum) * DAY;
      const t = zeiten(f, jetztMs), n = f.seqs.length;
      if (jetzt < t[1] || jetzt > t[2 * n - 2]) continue;
      // Abschnitt finden: t[2i+1] = Abfahrt an Halt i, t[2i+2] = Ankunft an Halt i+1
      let i = 0;
      while (i < n - 1 && jetzt >= t[2 * i + 2]) i++;
      let seg, anteil, verzug;
      if (i >= n - 1) continue;
      if (jetzt < t[2 * i + 1]) { // steht am Halt i
        if (i === 0) continue;
        seg = f.legs[i - 1]; anteil = 1; verzug = f.verzug[i];
      } else {
        seg = f.legs[i];
        anteil = weg((jetzt - t[2 * i + 1]) / Math.max(1, t[2 * i + 2] - t[2 * i + 1]));
        verzug = f.verzug[i + 1];
      }
      if (hidden.has(seg)) continue;
      punktAuf(segs[seg], anteil, P);
      const s = sp[stufe(verzug)];
      ctx.drawImage(s.c, P[0] * view.s + view.ox - s.m, P[1] * view.s + view.oy - s.m);
    }
  }
  if (aussen) {
    // Züge außerhalb der gewählten Bundesländer abschwächen
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fill(aussen, "evenodd");
  }
}

// ---------- Ablauf ----------

let letztesBild = 0;
function schleife(ts) {
  requestAnimationFrame(schleife);
  if (ts - letztesBild < 1000 / (cfg.fps || 30) - 2) return;
  letztesBild = ts;
  zeichneZuege();
}

async function pruefeVersion() {
  try {
    const v = await json(DATA + "version.json");
    if (v.built !== version) location.reload();
  } catch (e) { /* später nochmal */ }
}

async function start() {
  try {
    status.textContent = "Lade Streckennetz …";
    await ladeGrunddaten();
    groesse();
    status.textContent = "Lade Fahrplan …";
    await sichereTage();
    status.textContent = "";
  } catch (e) {
    status.textContent = "Daten nicht erreichbar, neuer Versuch in einer Minute";
    console.error(e);
    setTimeout(start, 60e3);
    return;
  }
  waehleAktive();
  await ladeVerspaetungen();
  addEventListener("resize", groesse);
  setInterval(waehleAktive, 15e3);
  setInterval(ladeVerspaetungen, 60e3);
  setInterval(async () => { await sichereTage(); waehleAktive(); }, 10 * 60e3);
  setInterval(pruefeVersion, 30 * 60e3);
  requestAnimationFrame(schleife);
}

start();
