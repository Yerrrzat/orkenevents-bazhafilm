// Reads a Kaspi transfer receipt image and pulls out the fields we check.
// The receipt is a picture (Kaspi's PDF has no text layer), so we use OCR.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export const ocrStats = { initMs: null, engine: null, dataDir: null };
// The function may be bundled into one file, so look for the data folder in a few places.
function findDataDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tries = [path.join(here, '..', 'data'), path.join(here, 'data'), path.join(process.cwd(), 'netlify', 'functions', 'data'), path.join(here, '..', '..', 'netlify', 'functions', 'data')];
  return tries.find((d) => fs.existsSync(path.join(d, 'rus.traineddata.gz'))) || tries[0];
}
export const DATA_DIR = findDataDir();
ocrStats.dataDir = DATA_DIR + (fs.existsSync(path.join(DATA_DIR, 'rus.traineddata.gz')) ? ' (found)' : ' (MISSING)');
// The recognition engine (Tesseract compiled to WebAssembly) runs right here, in the same process.
// No worker threads and no downloads: an error can always be caught and reported.
let enginePromise = null;
function getEngine() {
  if (!enginePromise) enginePromise = (async () => {
    const t0 = Date.now(), require = createRequire(import.meta.url);
    let factory, variant = 'simd';
    try { factory = require('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'); }
    catch (e) { variant = 'plain'; factory = require('tesseract.js-core/tesseract-core-lstm.wasm.js'); }
    let M;
    try { M = await factory({}); } catch (e) { variant = 'plain'; M = await require('tesseract.js-core/tesseract-core-lstm.wasm.js')({}); }
    M.FS.writeFile('rus.traineddata', zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, 'rus.traineddata.gz'))));
    const api = new M.TessBaseAPI();
    if (api.Init(null, 'rus', 1) === -1) throw new Error('OCR engine failed to start');   // 1 = LSTM only
    api.SetVariable('tessedit_pageseg_mode', '6');                                        // one uniform block of text
    ocrStats.initMs = Date.now() - t0; ocrStats.engine = variant;
    return { M, api };
  })().catch((e) => { enginePromise = null; throw e; });
  return enginePromise;
}
async function recognize(png) {
  const { M, api } = await getEngine();
  M.FS.writeFile('/input', png);
  if (api.SetImageFile(1, 0) === 1) throw new Error('OCR engine could not read the image');
  try { api.Recognize(null); return api.GetUTF8Text() || ''; }
  finally { try { api.Clear(); } catch (e) {} try { M.FS.unlink('/input'); } catch (e) {} }   // without this every receipt leaves ~25 MB behind
}

/** dataURL or Buffer (JPEG/PNG) -> { w, h, gray: Uint8Array } */
export function decodeImage(input) {
  let buf = input;
  if (typeof input === 'string') {
    const m = input.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/s);
    if (!m) throw Object.assign(new Error('Нужен скриншот или PDF чека'), { code: 'BAD_IMAGE' });
    buf = Buffer.from(m[2], 'base64');
  }
  if (buf.length > 3_000_000) throw Object.assign(new Error('Файл слишком большой'), { code: 'BAD_IMAGE' });
  let w, h, rgba;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) { const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); w = d.width; h = d.height; rgba = d.data; }
    else { const d = PNG.sync.read(buf); w = d.width; h = d.height; rgba = d.data; }
  } catch (e) { throw Object.assign(new Error('Не удалось прочитать изображение'), { code: 'BAD_IMAGE' }); }
  if (w < 200 || h < 200 || w * h > 12_000_000) throw Object.assign(new Error('Неподходящий размер изображения'), { code: 'BAD_IMAGE' });
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  return { w, h, gray };
}

/** Black-and-white PNG of a region, optionally enlarged. Coloured bands become plain black-on-white text. */
export function toBinaryPng({ w, h, gray }, region = { x: 0, y: 0, w, h }, scale = 1) {
  let min = 255, max = 0, sum = 0;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) { const v = gray[y * w + x]; if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / (region.w * region.h), invert = mean < 110, span = Math.max(1, max - min);
  // one grey byte per pixel, each row starts with a zero "filter" byte — the raw form a PNG file wraps
  const W = Math.round(region.w * scale), H = Math.round(region.h * scale), raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = gray[(region.y + Math.min(region.h - 1, Math.floor(y / scale))) * w + region.x + Math.min(region.w - 1, Math.floor(x / scale))];
    v = ((v - min) * 255) / span; if (invert) v = 255 - v;
    raw[y * (W + 1) + 1 + x] = v > 150 ? 255 : 0;
  }
  return grayPng(W, H, raw);
}

// Own tiny PNG writer: the pngjs one keeps ~8 MB after every call, and a busy server ran out of memory after a few dozen receipts.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  let c = 0xffffffff; for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length); return out;
}
function grayPng(W, H, raw) {
  const head = Buffer.alloc(13); head.writeUInt32BE(W, 0); head.writeUInt32BE(H, 4); head[8] = 8; head[9] = 0;   // 8 bits, greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const digits = (s) => s.replace(/[^\d]/g, '');

function findAmount(text) {
  for (const line of text.split('\n')) {
    if (/омисс|Комис/i.test(line)) continue;
    const m = line.match(/^\s*(\d{1,3}(?:[ .,]\d{3})+|\d{3,7})\s*[₸TТтt₮Ŧ]?\s*$/);
    if (m) { const v = parseInt(digits(m[1]), 10); if (v >= 100 && v <= 5_000_000) return v; }
  }
  return null;
}

/** Text from OCR -> fields. Works for Russian and Kazakh receipts: it relies on patterns, not on labels. */
export function parseReceipt(text, recipientPattern = 'ркен М') {
  const t = text.replace(/ /g, ' ');
  let number = null;
  // a long receipt number is often wrapped: its last digits stand alone on the next line
  const lines = t.split('\n'), skip = new Set();
  for (let i = 0; i < lines.length && !number; i++) {
    const m = lines[i].match(/(\d[\d ]{10,24}\d)\s*$/); if (!m) continue;
    let d = digits(m[1]), j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
    const tail = j < lines.length && /^\s*\d{1,6}\s*$/.test(lines[j]) ? lines[j].trim() : '';
    if (tail && d.length >= 12 && d.length + tail.length <= 20) { d += tail; skip.add(j); }
    if (d.length >= 15 && d.length <= 20) number = d; else skip.clear();
  }
  const rest = lines.filter((_, i) => !skip.has(i)).join('\n');
  let paidAt = null, paidAtText = null;
  const dm = t.match(/(\d{2})[.,](\d{2})[.,](20\d{2})\s+(\d{1,2})[:.](\d{2})/);
  if (dm) {
    const [, d, mo, y, hh, mi] = dm.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh < 24 && mi < 60) { paidAt = Date.UTC(y, mo - 1, d, hh - 5, mi); paidAtText = dm[0]; } // receipt time is Astana time (UTC+5)
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-zа-яёәғқңөұүһі0-9]/gi, '');
  const recipientOk = norm(t).includes(norm(recipientPattern));
  const sm = t.match(/(?:Отправитель|Жіберуші|Жiберушi)\s+(.+)/i);
  const success = /успешно\s+совершен|сәтті|сатти|сәттi/i.test(t);
  const failedWord = /отклон|не выполнен|ошибк|отмен[её]н|қабылданбады|орындалмады/i.test(t);
  return { number, paidAt, paidAtText, amount: findAmount(rest), recipientOk, sender: sm ? sm[1].trim().slice(0, 60) : null, success, failedWord };
}

/** Full pipeline: image -> OCR (two passes) -> fields. */
export async function readReceipt(input, recipientPattern) {
  const img = decodeImage(input);
  const scale = img.w < 900 ? Math.min(2.5, 1300 / img.w) : 1;
  const full = await recognize(toBinaryPng(img, undefined, scale));
  let text = full, parsed = parseReceipt(full, recipientPattern);
  if (parsed.amount == null) {
    // the amount sits in a coloured band at the top: read the upper half again, enlarged
    const top = { x: 0, y: 0, w: img.w, h: Math.round(img.h * 0.5) };
    const extra = await recognize(toBinaryPng(img, top, Math.min(3, Math.max(1.5, 2200 / img.w))));
    text = extra + '\n' + full; parsed = parseReceipt(text, recipientPattern);
  }
  return { ...parsed, text: text.slice(0, 4000) };
}

/** Compare the receipt with the order. Returns a list of problems (empty = accept). */
export function checkReceipt(r, order, now) {
  const p = [];
  if (r.failedWord) p.push('NOT_SUCCESS');
  if (r.number == null) p.push('NO_NUMBER');
  if (r.amount == null) p.push('NO_AMOUNT'); else if (r.amount !== order.total) p.push('WRONG_AMOUNT');
  if (!r.recipientOk) p.push('WRONG_RECIPIENT');
  if (r.paidAt == null) p.push('NO_DATE');
  else if (r.paidAt < order.created - 2 * 60000) p.push('TOO_OLD');   // receipt minutes are rounded down
  else if (r.paidAt > now + 5 * 60000) p.push('IN_FUTURE');
  return p;
}
