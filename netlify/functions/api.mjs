// HTTP API for the site: /api/*
// Needs environment variables in Netlify: DATABASE_URL (Neon), ADMIN_KEY, STAFF_KEY.
import { mailConfigured } from './lib/mail.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dbConfigured, migrate, q } from './lib/db.mjs';
import * as core from './lib/core.mjs';

export const config = { path: '/api/*' };

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
function role(req) {
  const k = req.headers.get('x-admin-key') || '';
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.length >= 12 && safeEq(k, process.env.ADMIN_KEY)) return 'admin';
  if (process.env.STAFF_KEY && process.env.STAFF_KEY.length >= 8 && safeEq(k, process.env.STAFF_KEY)) return 'staff';
  return null;
}
const need = (req, who) => { const r = role(req); if (r !== 'admin' && !(who === 'staff' && r === 'staff')) throw new core.ApiError(401, 'UNAUTHORIZED', 'Нужен вход'); return r; };

let selfTest = null; // OCR self-test result, computed once per server start
async function ocrSelfTest() {
  if (!selfTest) selfTest = (async () => {
    const { readReceipt, DATA_DIR, ocrStats } = await import('./lib/receipt.mjs');
    const t0 = Date.now();
    try {
      const r = await readReceipt(fs.readFileSync(path.join(DATA_DIR, 'selftest.jpg')), 'ркен М');
      return { ok: r.number === '123456789012345678' && r.amount === 2000 && r.recipientOk && !!r.paidAt, ms: Date.now() - t0, ...ocrStats, number: r.number, amount: r.amount, recipientOk: r.recipientOk, date: r.paidAtText };
    } catch (e) { return { ok: false, ms: Date.now() - t0, ...ocrStats, error: String((e && e.stack) || e).slice(0, 600) }; }
  })();
  // answer before the platform's time limit so we always get a readable result
  const res = await Promise.race([selfTest, new Promise((r) => setTimeout(() => r({ ok: false, pending: true, note: 'still starting after 8 s — open this link again' }), 8000))]);
  if (res.ok === false && !res.pending) selfTest = null;
  return res;
}

export default async function handler(req, context) {
  const url = new URL(req.url), route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, ''), now = Date.now();
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || '';
  const site = (process.env.URL || url.origin).replace(/\/$/, '');
  // work that may finish after the answer is sent (the letter with tickets)
  const later = (p) => { if (context && typeof context.waitUntil === 'function') context.waitUntil(p); else return p; };
  try {
    if (route === 'health') {
      const out = { ok: true, time: new Date(now).toISOString(), db: dbConfigured() ? 'configured' : 'not configured', adminKey: !!process.env.ADMIN_KEY, mail: mailConfigured() ? 'configured' : 'not configured' };
      if (dbConfigured()) { try { await migrate(); await q('SELECT 1 AS x'); out.db = 'connected'; } catch (e) { out.db = 'error: ' + String(e.message).slice(0, 200); out.ok = false; } }
      if (url.searchParams.get('ocr')) out.ocr = await ocrSelfTest();
      return json(200, out);
    }
    if (!dbConfigured()) {
      if (route === 'state') return json(200, { configured: false, salesOpen: false, now });
      throw new core.ApiError(503, 'NO_DB', 'Продажа ещё не открыта');
    }
    await migrate();
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (req.method === 'POST' && req.headers.get('origin') && new URL(req.headers.get('origin')).host !== url.host) throw new core.ApiError(403, 'FORBIDDEN', 'Запрос с другого сайта');

    if (req.method === 'GET' && route === 'state') return json(200, await core.publicState(now), { 'cache-control': 'public, max-age=0, must-revalidate', 'netlify-cdn-cache-control': 'public, s-maxage=3' });
    if (req.method === 'GET' && route === 'orders') return json(200, { now, orders: await core.getOrdersByTokens((url.searchParams.get('tokens') || '').split(','), now) });
    if (req.method === 'POST' && route === 'orders') { await core.cleanup(now); return json(201, { order: await core.createOrder(body, now, ip) }); }
    if (req.method === 'POST' && route === 'orders/cancel') return json(200, { order: await core.cancelByCustomer(body.token, now) });
    if (req.method === 'POST' && route === 'receipt') { const r = await core.submitReceipt(body.token, body.image, now, undefined, body.manual === true); if (r.ok) await later(core.mailTickets(r.order.id, now, site)); return json(200, r); }
    if (req.method === 'POST' && route === 'receipt/review') return json(200, { order: await core.requestReview(body.token, now) });

    if (req.method === 'GET' && route === 'admin/overview') { need(req, 'admin'); return json(200, await core.adminOverview(now)); }
    if (req.method === 'GET' && route === 'admin/receipt') { need(req, 'admin'); return json(200, await core.receiptImage(url.searchParams.get('id'))); }
    if (req.method === 'POST' && route === 'admin/order') {
      need(req, 'admin');
      if (body.action === 'mail') { const res = await core.mailTickets(body.orderId, now, site, true); if (res !== 'SENT') throw new core.ApiError(409, 'MAIL_' + res, res === 'OFF' ? 'Почта не настроена' : res === 'SKIP' ? 'Заказ не оплачен или без email' : 'Письмо не отправилось'); return json(200, { ok: true }); }
      if (body.action === 'reread') { const r = await core.rereadReview(body.orderId, now); if (r.ok) await core.mailTickets(r.order.id, now, site); return json(200, r); }
      const order = await core.adminAction(body, 'admin', now);
      if (body.action === 'approve') await core.mailTickets(order.id, now, site);
      return json(200, { order });
    }
    if (req.method === 'POST' && route === 'admin/settings') { need(req, 'admin'); return json(200, { settings: await core.saveSettings(body, 'admin', now) }); }
    if (req.method === 'GET' && route === 'staff/me') return json(200, { role: need(req, 'staff') });
    if (req.method === 'POST' && route === 'staff/validate') { const r = need(req, 'staff'); return json(200, await core.validateTicket(body, r, now)); }
    throw new core.ApiError(404, 'NOT_FOUND', 'Нет такого адреса');
  } catch (e) {
    if (e instanceof core.ApiError || (e && e.status && e.code)) return json(e.status, { error: { code: e.code, message: e.message, details: e.details || {} } });
    console.error('api error', route, e);
    return json(500, { error: { code: 'INTERNAL', message: 'Ошибка сервера. Попробуйте ещё раз.' } });
  }
}
