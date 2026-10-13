// tools/llm/media.js — fetch and measure caller-supplied images, audio and pages for the Phase B routes (R11 B).
//
// Every fetch goes through lib/safe-fetch.js (public hosts only, ports 80 and 443, 3 redirects, the content type and the
// declared length checked BEFORE the body downloads, a byte cap while it streams) and honours robots.txt for the host the way
// tools/webmd.js does. The bytes are sniffed against their magic numbers, so a mislabelled Content-Type is not trusted, and the
// size facts a cap depends on (pixels a side, seconds of audio) are read from the file's own header here rather than asked of the
// model. A file whose size cannot be read is a 400, never "probably fine".
'use strict';
const crypto = require('crypto');
const { safeFetch } = require('../../lib/safe-fetch');
const WEBMD = require('../webmd');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app; fetches one URL on a caller\'s request)';

const robots = new Map();
async function robotsOk(u, fetchImpl) {
  const origin = `${u.protocol}//${u.host}`; const hit = robots.get(origin); let txt;
  if (hit && Date.now() - hit.at < 3600e3) txt = hit.txt;
  else { try { txt = (await fetchImpl(`${origin}/robots.txt`, { maxBytes: 200000, timeoutMs: 4000, userAgent: UA, accept: 'text/plain' })).body.toString('utf8'); } catch { txt = ''; } robots.set(origin, { at: Date.now(), txt }); if (robots.size > 2000) robots.delete(robots.keys().next().value); }
  if (!WEBMD._robotsAllows(txt, u.pathname + u.search)) throw bad(`${u.host}/robots.txt disallows this path for automated fetches`);
}
function parseUrl(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) throw bad('missing required parameter: url (an absolute http or https URL)');
  if (s.length > 2048) throw bad('url is longer than 2,048 characters');
  let u; try { u = new URL(s); } catch { throw bad('url must be an absolute http or https URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('url must be an absolute http or https URL');
  return u;
}
/** -> { url, finalUrl, contentType, body, sha256 } */
async function fetchMedia(raw, { maxBytes, okTypes, accept, fetchImpl = safeFetch }) {
  const u = parseUrl(raw);
  await robotsOk(u, fetchImpl);
  const r = await fetchImpl(u.href, { maxBytes, userAgent: UA, accept, okTypes });
  return { url: u.href, finalUrl: r.url, contentType: r.contentType, body: r.body, sha256: crypto.createHash('sha256').update(r.body).digest('hex') };
}

// ---------- images ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
function sniffImage(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}
function imageSize(b, type) {
  if (type === 'image/png') return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  if (type === 'image/gif') return b.length >= 10 ? { w: b.readUInt16LE(6), h: b.readUInt16LE(8) } : null;
  if (type === 'image/webp') {
    const k = b.subarray(12, 16).toString('latin1');
    if (k === 'VP8X' && b.length >= 30) return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (k === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    if (k === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (type === 'image/jpeg') {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      o += 2 + b.readUInt16BE(o + 2);
    }
    return null;
  }
  return null;
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; const MAX_SIDE = 4096;
async function getImage(raw, deps = {}) {
  const m = await fetchMedia(raw, { maxBytes: MAX_IMAGE_BYTES, okTypes: IMAGE_TYPES, accept: IMAGE_TYPES.join(','), fetchImpl: deps.fetchMedia || safeFetch });
  const type = sniffImage(m.body);
  if (!type) throw bad('the file is not a PNG, JPEG, WebP or GIF image (its bytes do not match)');
  const size = imageSize(m.body, type);
  if (!size || !size.w || !size.h) throw bad('the image dimensions could not be read');
  if (size.w > MAX_SIDE || size.h > MAX_SIDE) throw bad(`the image is ${size.w}x${size.h}; the limit is ${MAX_SIDE} pixels a side`);
  return { ...m, mimeType: type, width: size.w, height: size.h };
}

// ---------- audio ----------
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/ogg', 'application/ogg', 'audio/webm', 'video/webm', 'video/mp4', 'application/octet-stream', 'binary/octet-stream'];
function sniffAudio(b) {
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (b.length > 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (b.length > 3 && b.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}
// bitrate tables by [MPEG1 L1, L2, L3, MPEG2 L1, MPEG2 L2/L3] and sample rates by version
const MP3_BR = { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 4: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 5: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Seconds(b) {
  let o = 0;
  if (b.subarray(0, 3).toString('latin1') === 'ID3') o = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  let secs = 0; let frames = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) { o++; continue; }
    const ver = (b[o + 1] >> 3) & 3; const layer = (b[o + 1] >> 1) & 3; const bi = b[o + 2] >> 4; const si = (b[o + 2] >> 2) & 3; const pad = (b[o + 2] >> 1) & 1;
    if (ver === 1 || layer === 0 || bi === 0 || bi === 15 || si === 3) { o++; continue; }
    const lay = 4 - layer; // 1, 2 or 3
    const col = ver === 3 ? lay : (lay === 1 ? 4 : 5);
    const br = MP3_BR[col][bi] * 1000; const sr = MP3_SR[ver][si];
    const spf = lay === 1 ? 384 : (lay === 3 && ver !== 3 ? 576 : 1152);
    const len = lay === 1 ? (Math.floor(12 * br / sr) + pad) * 4 : Math.floor((spf / 8) * br / sr) + pad;
    if (len < 4) { o++; continue; }
    secs += spf / sr; frames++; o += len;
  }
  return frames > 3 ? secs : null;
}
function wavSeconds(b) {
  let o = 12; let byteRate = 0;
  while (o + 8 <= b.length) {
    const id = b.subarray(o, o + 4).toString('latin1'); const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 20 <= b.length) byteRate = b.readUInt32LE(o + 16);
    if (id === 'data') return byteRate ? Math.min(sz, b.length - o - 8) / byteRate : null;
    o += 8 + sz + (sz & 1);
  }
  return null;
}
function mp4Seconds(b) {
  const find = (start, end, name) => { let o = start; while (o + 8 <= end) { let sz = b.readUInt32BE(o); const t = b.subarray(o + 4, o + 8).toString('latin1'); let hdr = 8; if (sz === 1) { sz = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } if (sz === 0) sz = end - o; if (sz < hdr) return null; if (t === name) return { s: o + hdr, e: Math.min(end, o + sz) }; o += sz; } return null; };
  const moov = find(0, b.length, 'moov'); if (!moov) return null;
  const mvhd = find(moov.s, moov.e, 'mvhd'); if (!mvhd) return null;
  const v = b[mvhd.s];
  const ts = v === 1 ? b.readUInt32BE(mvhd.s + 20) : b.readUInt32BE(mvhd.s + 12);
  const dur = v === 1 ? Number(b.readBigUInt64BE(mvhd.s + 24)) : b.readUInt32BE(mvhd.s + 16);
  return ts ? dur / ts : null;
}
function oggSeconds(b) {
  let sr = null; const oi = b.indexOf('OpusHead'); let pre = 0;
  if (oi >= 0) { sr = 48000; pre = b.readUInt16LE(oi + 10); } else { const v = b.indexOf(Buffer.from([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])); if (v >= 0) sr = b.readUInt32LE(v + 12); }
  if (!sr) return null;
  const last = b.lastIndexOf('OggS'); if (last < 0 || last + 14 > b.length) return null;
  const gp = Number(b.readBigUInt64LE(last + 6)); if (gp <= 0) return null;
  return (gp - pre) / sr;
}
function webmSeconds(b) {
  const head = b.subarray(0, Math.min(b.length, 8192));
  const di = head.indexOf(Buffer.from([0x44, 0x89])); if (di < 0) return null;
  const len = head[di + 2] & 0x7f;
  let dur; if (len === 4) dur = head.readFloatBE(di + 3); else if (len === 8) dur = head.readDoubleBE(di + 3); else return null;
  let scale = 1000000; const ti = head.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  if (ti >= 0) { const n = head[ti + 3] & 0x0f; let v = 0; for (let k = 0; k < n; k++) v = v * 256 + head[ti + 4 + k]; if (v) scale = v; }
  return dur * scale / 1e9;
}
function audioSeconds(b, type) {
  try {
    if (type === 'audio/wav') return wavSeconds(b);
    if (type === 'audio/mpeg') return mp3Seconds(b);
    if (type === 'audio/mp4') return mp4Seconds(b);
    if (type === 'audio/ogg') return oggSeconds(b);
    if (type === 'audio/webm') return webmSeconds(b);
  } catch { /* unreadable header */ }
  return null;
}
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; const MAX_AUDIO_SECONDS = 300;
async function getAudio(raw, deps = {}) {
  const m = await fetchMedia(raw, { maxBytes: MAX_AUDIO_BYTES, okTypes: AUDIO_TYPES, accept: 'audio/*', fetchImpl: deps.fetchMedia || safeFetch });
  const type = sniffAudio(m.body);
  if (!type) throw bad('the file is not mp3, wav, m4a, ogg or webm audio (its bytes do not match)');
  const secs = audioSeconds(m.body, type);
  if (!secs || !Number.isFinite(secs) || secs <= 0) throw bad('the length of this audio could not be read from the file, so it cannot be accepted');
  if (secs > MAX_AUDIO_SECONDS) throw bad(`the audio is ${Math.round(secs)} seconds; the limit is ${MAX_AUDIO_SECONDS} (5 minutes)`);
  return { ...m, mimeType: type, seconds: Math.round(secs * 100) / 100 };
}

module.exports = { fetchMedia, getImage, getAudio, sniffImage, imageSize, sniffAudio, audioSeconds, parseUrl, MAX_IMAGE_BYTES, MAX_SIDE, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, UA };
