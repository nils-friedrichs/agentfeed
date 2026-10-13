// tools/utils.js — /api/qr, /api/hash, /api/time, /api/convert (R11 A7): small deterministic utilities.
// No upstream, no state. Every input is capped at 2 KB and over-cap input is a 400 (never billed).
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const CAP = 2048;
const need = (p, k) => { const v = p[k]; if (v == null || v === '') throw bad(`missing required parameter: ${k}`); return String(v); };
const capped = (s, k) => { if (Buffer.byteLength(s, 'utf8') > CAP) throw bad(`${k} is over the ${CAP}-byte limit`); return s; };

// ---- QR ----
function matrixOf(data) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M'); // type 0 = smallest version that fits
  qr.addData(data, 'Byte'); qr.make();
  const n = qr.getModuleCount(); const rows = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(qr.isDark(r, c)); rows.push(row); }
  return rows;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// 1-bit grayscale PNG: 0 = black, 1 = white
function pngOf(rows, scale, quiet) {
  const n = rows.length + 2 * quiet; const px = n * scale; const stride = Math.ceil(px / 8);
  const raw = Buffer.alloc((stride + 1) * px, 0);
  for (let y = 0; y < px; y++) {
    const o = y * (stride + 1); raw[o] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && mx >= 0 && my < rows.length && mx < rows.length && rows[my][mx];
      if (!dark) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 1; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function svgOf(rows, scale, quiet) {
  const n = rows.length + 2 * quiet; let d = '';
  for (let y = 0; y < rows.length; y++) {
    let x = 0;
    while (x < rows.length) { if (!rows[y][x]) { x++; continue; } let e = x; while (e < rows.length && rows[y][e]) e++; d += `M${x + quiet} ${y + quiet}h${e - x}v1h-${e - x}z`; x = e; }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function qr(p = {}) {
  const data = capped(need(p, 'data'), 'data');
  const format = p.format == null || p.format === '' ? 'svg' : String(p.format).toLowerCase();
  if (format !== 'svg' && format !== 'png') throw bad('format must be svg or png');
  const rows = matrixOf(data); const quiet = 4; const scale = Math.max(2, Math.min(10, Math.floor(640 / (rows.length + 2 * quiet))));
  const base = { data_bytes: Buffer.byteLength(data), modules: rows.length, error_correction: 'M', format };
  if (format === 'svg') { const svg = svgOf(rows, scale, quiet); return { ...base, svg, data_uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }; }
  const png = pngOf(rows, scale, quiet);
  return { ...base, width_px: (rows.length + 2 * quiet) * scale, png_base64: png.toString('base64'), data_uri: `data:image/png;base64,${png.toString('base64')}` };
}

// ---- hash ----
function hash(p = {}) {
  const alg = need(p, 'alg').toLowerCase();
  const as = p.as == null || p.as === '' ? 'utf8' : String(p.as).toLowerCase();
  if (as !== 'utf8' && as !== 'hex') throw bad('as must be utf8 or hex');
  if (p.data == null) throw bad('missing required parameter: data');
  const data = capped(String(p.data), 'data');
  let bytes;
  if (as === 'hex') {
    const h = data.replace(/^0x/i, '');
    if (h.length % 2 || !/^[0-9a-f]*$/i.test(h)) throw bad('as=hex needs an even number of hex digits');
    bytes = Buffer.from(h, 'hex');
  } else bytes = Buffer.from(data, 'utf8');
  let digest;
  if (alg === 'sha256') digest = crypto.createHash('sha256').update(bytes).digest('hex');
  else if (alg === 'blake2b') digest = crypto.createHash('blake2b512').update(bytes).digest('hex');
  else if (alg === 'keccak256') digest = require('viem').keccak256(new Uint8Array(bytes)).slice(2);
  else throw bad('alg must be sha256, keccak256 or blake2b');
  return { alg, ...(alg === 'blake2b' ? { variant: 'BLAKE2b-512' } : {}), input_bytes: bytes.length, input_as: as, hex: digest, hex_0x: `0x${digest}` };
}

// ---- time ----
function parseAt(v, now) {
  if (v == null || v === '') return now;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); const ms = Math.abs(n) < 1e11 ? n * 1000 : n; if (!Number.isFinite(ms)) throw bad('at is not a time'); return Math.round(ms); }
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) throw bad('at must be an ISO 8601 time such as 2026-10-13T12:00:00Z, or epoch seconds or milliseconds');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s) && /[T ]/.test(s)) throw bad('at needs a time zone suffix (Z or +02:00) so the instant is unambiguous');
  const t = Date.parse(s.replace(' ', 'T'));
  if (!Number.isFinite(t)) throw bad('at is not a valid time');
  return t;
}
function time(p = {}, { now = Date.now() } = {}) {
  const tz = p.tz == null || p.tz === '' ? 'UTC' : capped(String(p.tz), 'tz');
  const t = parseAt(p.at, now);
  if (Math.abs(t) > 8.64e15) throw bad('at is out of range');
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', timeZoneName: 'longOffset' }); } catch { throw bad('tz must be an IANA time zone name such as Europe/Chisinau or America/New_York'); }
  const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const off = (parts.timeZoneName || 'GMT').replace('GMT', '') || '+00:00';
  const offMin = off === '+00:00' ? 0 : (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName').value;
  const jan = new Date(Date.UTC(new Date(t).getUTCFullYear(), 0, 1)); const jul = new Date(Date.UTC(new Date(t).getUTCFullYear(), 6, 1));
  const offAt = (d) => { const o = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName').value.replace('GMT', '') || '+00:00'; return o === '+00:00' ? 0 : (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))); };
  const std = Math.min(offAt(jan), offAt(jul));
  return {
    tz, instant_utc: new Date(t).toISOString(), epoch_seconds: Math.floor(t / 1000), epoch_ms: t,
    local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`, weekday: parts.weekday,
    utc_offset: off, utc_offset_minutes: offMin, abbreviation: abbr, dst_in_effect: offMin > std, defaulted_to_now: p.at == null || p.at === '',
  };
}

// ---- unit conversion ----
// factor to the category's base unit; temperature handled apart
const U = {
  length: { base: 'm', f: { mm: 1e-3, cm: 1e-2, m: 1, km: 1e3, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 } },
  mass: { base: 'kg', f: { mg: 1e-6, g: 1e-3, kg: 1, t: 1e3, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 } },
  volume: { base: 'l', f: { ml: 1e-3, l: 1, m3: 1e3, tsp: 0.00492892159375, tbsp: 0.01478676478125, floz: 0.0295735295625, cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784 } },
  time: { base: 's', f: { ms: 1e-3, s: 1, min: 60, h: 3600, d: 86400, wk: 604800 } },
  data: { base: 'B', f: { bit: 0.125, B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 } },
  speed: { base: 'm/s', f: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 1852 / 3600, 'ft/s': 0.3048 } },
  area: { base: 'm2', f: { mm2: 1e-6, cm2: 1e-4, m2: 1, km2: 1e6, ha: 1e4, in2: 0.00064516, ft2: 0.09290304, yd2: 0.83612736, ac: 4046.8564224, mi2: 2589988.110336 } },
  pressure: { base: 'Pa', f: { Pa: 1, kPa: 1e3, bar: 1e5, mbar: 100, atm: 101325, psi: 6894.757293168, mmHg: 133.322387415 } },
  energy: { base: 'J', f: { J: 1, kJ: 1e3, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3.6e6, BTU: 1055.05585262 } },
};
const TEMPS = new Set(['C', 'F', 'K']);
function findUnit(u) {
  for (const [cat, d] of Object.entries(U)) if (Object.prototype.hasOwnProperty.call(d.f, u)) return cat;
  // case-insensitive fallback only when it is unambiguous
  const hits = []; for (const [cat, d] of Object.entries(U)) for (const k of Object.keys(d.f)) if (k.toLowerCase() === u.toLowerCase()) hits.push([cat, k]);
  return hits.length === 1 ? hits[0] : null;
}
function convert(p = {}) {
  const raw = need(p, 'value').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) throw bad('value must be a plain number');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw bad('value is out of range');
  let from = capped(need(p, 'from'), 'from').trim(); let to = capped(need(p, 'to'), 'to').trim();
  let out;
  if (TEMPS.has(from.toUpperCase().replace('°', '')) || TEMPS.has(to.toUpperCase().replace('°', ''))) {
    from = from.toUpperCase().replace('°', ''); to = to.toUpperCase().replace('°', '');
    if (!TEMPS.has(from) || !TEMPS.has(to)) throw bad('temperature units are C, F and K and cannot be mixed with other units');
    const k = from === 'C' ? value + 273.15 : from === 'F' ? (value - 32) * 5 / 9 + 273.15 : value;
    if (k < 0) throw bad('that is below absolute zero');
    out = { category: 'temperature', result: to === 'C' ? k - 273.15 : to === 'F' ? (k - 273.15) * 9 / 5 + 32 : k };
  } else {
    const fa = (() => { const c = findUnit(from); return c && (Array.isArray(c) ? c : [c, from]); })();
    const ta = (() => { const c = findUnit(to); return c && (Array.isArray(c) ? c : [c, to]); })();
    if (!fa) throw bad(`unknown unit "${from}"`);
    if (!ta) throw bad(`unknown unit "${to}"`);
    if (fa[0] !== ta[0]) throw bad(`cannot convert ${fa[0]} (${fa[1]}) to ${ta[0]} (${ta[1]})`);
    out = { category: fa[0], result: value * U[fa[0]].f[fa[1]] / U[ta[0]].f[ta[1]] };
    from = fa[1]; to = ta[1];
  }
  const r = Number(out.result.toPrecision(12));
  return { value, from, to, category: out.category, result: r };
}

module.exports = { qr, hash, time, convert, pngOf, matrixOf, units: () => Object.fromEntries(Object.entries(U).map(([k, d]) => [k, Object.keys(d.f)])) };
