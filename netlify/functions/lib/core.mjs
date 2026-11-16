// Business rules: holding seats, receipts, tickets, admin actions.
// Every function takes `now` (ms) so the rules can be tested with a fixed clock.
import crypto from 'node:crypto';
import { q, tx } from './db.mjs';
import { SCREENINGS } from './halls.mjs';
import { readReceipt, checkReceipt } from './receipt.mjs';
import { mailConfigured, sendMail, ticketLetter } from './mail.mjs';

export const DEFAULTS = {
  salesOpen: false,                                  // master switch: false = site only shows halls
  hallsOpen: { scr1: true, scr2: true, scr3: true, scr4: false, scr5: false },
  price: 2000, vipPrice: 5000, holdMin: 15, maxSeats: 10,   // vipPrice: a seat in the VIP hall
  startsAt: '2026-11-19T19:00',
  kaspi: '+7 775 912 0048',                          // number buyers transfer to
  recipient: 'Өркен М.', recipientPattern: 'ркен М', // how the receiver appears on a Kaspi receipt
};
const SETTING_KEYS = Object.keys(DEFAULTS);

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details || {}; }
}
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');
const uid = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const J = (v) => JSON.stringify(v);
const isUnique = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(String(e.message)));

export function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^77\d{9}$/.test(d) ? '+' + d : null;
}

export async function getSettings() {
  const r = await q(`SELECT value FROM settings WHERE key='main'`);
  const v = r[0]?.value || {};
  return { ...DEFAULTS, ...v, hallsOpen: { ...DEFAULTS.hallsOpen, ...(v.hallsOpen || {}) } };
}
export async function saveSettings(patch, actor, now) {
  const cur = await getSettings(), next = { ...cur };
  for (const k of SETTING_KEYS) if (patch[k] !== undefined) next[k] = patch[k];
  next.price = Math.round(Number(next.price)); next.vipPrice = Math.round(Number(next.vipPrice)); next.holdMin = Math.round(Number(next.holdMin)); next.maxSeats = Math.round(Number(next.maxSeats));
  if (!(next.price >= 100 && next.price <= 100000)) throw new ApiError(400, 'VALIDATION_ERROR', 'Цена: от 100 до 100 000 ₸');
  if (!(next.vipPrice >= 100 && next.vipPrice <= 100000)) throw new ApiError(400, 'VALIDATION_ERROR', 'Цена VIP: от 100 до 100 000 ₸');
  if (!(next.holdMin >= 5 && next.holdMin <= 120)) throw new ApiError(400, 'VALIDATION_ERROR', 'Время брони: от 5 до 120 минут');
  if (!(next.maxSeats >= 1 && next.maxSeats <= 20)) throw new ApiError(400, 'VALIDATION_ERROR', 'Мест в заказе: от 1 до 20');
  next.salesOpen = !!next.salesOpen;
  await q(`INSERT INTO settings(key,value) VALUES('main',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=$1::jsonb`, [J(next)]);
  await audit(now, actor, 'settings.update', 'settings', Object.keys(patch).join(','));
  return next;
}
export async function audit(now, actor, action, entity, detail) {
  await q(`INSERT INTO audit(at,actor,action,entity,detail) VALUES($1,$2,$3,$4,$5)`, [now, actor || 'system', action, entity || '', String(detail || '').slice(0, 500)]);
}

const cleanupStmts = (now) => [
  [`UPDATE orders SET status='EXPIRED' WHERE status='PENDING_PAYMENT' AND hold_exp<$1`, [now]],
  [`DELETE FROM seat_locks WHERE status='HELD' AND exp<$1`, [now]],
  // a cancelled order never keeps seats (also repairs orders cancelled after their tickets were scanned)
  [`DELETE FROM seat_locks WHERE order_id IN (SELECT id FROM orders WHERE status='CANCELLED')`, []],
  [`UPDATE tickets SET status='CANCELLED' WHERE status<>'CANCELLED' AND order_id IN (SELECT id FROM orders WHERE status='CANCELLED')`, []],
];
export async function cleanup(now) { await tx(cleanupStmts(now)); }

/** What every visitor may see: settings and which seats are taken. */
export async function publicState(now) {
  const s = await getSettings();
  const rows = await q(`SELECT scr_id, seat_id, status FROM seat_locks WHERE status='SOLD' OR exp>$1`, [now]);
  const taken = {};
  for (const r of rows) (taken[r.scr_id] ||= {})[r.seat_id] = r.status === 'SOLD' ? 'S' : 'H';
  return { configured: true, now, salesOpen: s.salesOpen, hallsOpen: s.hallsOpen, price: s.price, vipPrice: s.vipPrice, holdMin: s.holdMin, maxSeats: s.maxSeats, startsAt: s.startsAt, kaspi: s.kaspi, recipient: s.recipient, taken };
}

function shapeOrder(o, tickets, receipt, now) {
  const status = o.status === 'PENDING_PAYMENT' && o.hold_exp < now ? 'EXPIRED' : o.status;
  return {
    id: o.id, number: o.number, token: o.token, scrId: o.scr_id, status, items: o.items, total: o.total, currency: 'KZT',
    holdExp: o.hold_exp, created: o.created, paidAt: o.paid_at, cancelReason: o.cancel_reason, review: o.review, attempts: o.attempts,
    customer: { name: o.name, phone: o.phone, email: o.email || '' },
    mailAt: o.mail_at || null, mailErr: o.mail_err || null,
    lastReceipt: receipt ? { status: receipt.status, reason: receipt.reason, number: receipt.number, amount: receipt.amount, paidAt: receipt.paid_at, created: receipt.created } : null,
    tickets: tickets.map((t) => ({ id: t.id, orderId: t.order_id, itemId: t.item_id, number: t.number, token: t.token, status: t.status, checkedAt: t.checked_at })),
  };
}
async function loadOrders(where, params, now) {
  const orders = await q(`SELECT * FROM orders WHERE ${where}`, params);
  if (!orders.length) return [];
  const ids = J(orders.map((o) => o.id));
  const tickets = await q(`SELECT * FROM tickets WHERE order_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY r, n`, [ids]);
  const receipts = await q(`SELECT DISTINCT ON (order_id) order_id, status, reason, number, amount, paid_at, created FROM receipts WHERE order_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY order_id, created DESC`, [ids]);
  return orders.map((o) => shapeOrder(o, tickets.filter((t) => t.order_id === o.id), receipts.find((r) => r.order_id === o.id), now));
}
export async function getOrdersByTokens(tokens, now) {
  const list = [...new Set((tokens || []).filter((t) => typeof t === 'string' && t.length >= 20))].slice(0, 30);
  if (!list.length) return [];
  return loadOrders(`token IN (SELECT jsonb_array_elements_text($1::jsonb))`, [J(list)], now);
}
async function orderByToken(token, now) {
  const r = await loadOrders(`token=$1`, [String(token || '')], now);
  if (!r.length) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден');
  return r[0];
}

/** Hold seats and create an order. The database refuses a second hold on the same seat. */
export async function createOrder(inp, now, ip) {
  const s = await getSettings();
  if (!inp.idem || String(inp.idem).length < 8) throw new ApiError(400, 'VALIDATION_ERROR', 'Нет ключа идемпотентности');
  const idem = String(inp.idem).slice(0, 80);
  const again = await loadOrders(`idem=$1`, [idem], now);
  if (again.length) return again[0];
  const scr = SCREENINGS[inp.scrId];
  if (!scr) throw new ApiError(404, 'NOT_FOUND', 'Сеанс не найден');
  if (!s.salesOpen || !s.hallsOpen[inp.scrId] || new Date(s.startsAt + ':00+05:00').getTime() <= now) throw new ApiError(409, 'SALES_CLOSED', 'Продажа на этот сеанс закрыта');
  const seatIds = [...new Set(Array.isArray(inp.seatIds) ? inp.seatIds.map(String) : [])];
  if (!seatIds.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Выберите хотя бы одно место');
  if (seatIds.length > s.maxSeats) throw new ApiError(400, 'VALIDATION_ERROR', `Не больше ${s.maxSeats} мест в одном заказе`);
  if (seatIds.some((id) => !scr.seats.has(id))) throw new ApiError(400, 'VALIDATION_ERROR', 'Некоторые места недоступны');
  const name = String(inp.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) throw new ApiError(400, 'VALIDATION_ERROR', 'Укажите имя и фамилию');
  const phone = normPhone(inp.phone);
  if (!phone) throw new ApiError(400, 'VALIDATION_ERROR', 'Введите номер в формате +7 7XX XXX XX XX');
  const email = String(inp.email || '').trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw new ApiError(400, 'VALIDATION_ERROR', 'Укажите email — на него придут билеты');
  if (!inp.offer || !inp.pd) throw new ApiError(400, 'VALIDATION_ERROR', 'Нужно согласие с офертой и на обработку персональных данных');
  // per phone: 3 unpaid orders. Per address: 20 — mobile operators put many phones behind one address, so a tight limit would block honest buyers
  const busy = await q(`SELECT count(*) FILTER (WHERE phone=$2)::int AS c, count(*) FILTER (WHERE ip=$3)::int AS i FROM orders WHERE status='PENDING_PAYMENT' AND hold_exp>$1 AND (phone=$2 OR ip=$3)`, [now, phone, ip || '-']);
  if (busy[0].c >= 3 || busy[0].i >= 20) throw new ApiError(429, 'TOO_MANY_ORDERS', 'У вас уже есть неоплаченные заказы. Оплатите или отмените их.');

  const id = uid('ord'), token = rnd(24), number = 'BZ-' + s.startsAt.slice(2, 10).replace(/-/g, '') + '-' + code(4);
  const price = scr.vip ? s.vipPrice : s.price;
  const items = seatIds.map((sid) => ({ id: uid('itm'), seatId: sid, r: scr.seats.get(sid).r, n: scr.seats.get(sid).n, cat: scr.vip ? 'VIP' : 'STANDARD', price, status: 'ACTIVE' }));
  const total = items.length * price, holdExp = now + s.holdMin * 60000;
  try {
    await tx([
      [`DELETE FROM seat_locks WHERE scr_id=$1 AND status='HELD' AND exp<$2 AND seat_id IN (SELECT jsonb_array_elements_text($3::jsonb))`, [inp.scrId, now, J(seatIds)]],
      [`INSERT INTO orders(id,token,number,idem,scr_id,status,name,phone,email,total,items,hold_exp,created,ip) VALUES($1,$2,$3,$4,$5,'PENDING_PAYMENT',$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [id, token, number, idem, inp.scrId, name, phone, email || null, total, J(items), holdExp, now, ip || null]],
      [`INSERT INTO seat_locks(scr_id,seat_id,order_id,status,exp) SELECT $1, x, $2, 'HELD', $3 FROM jsonb_array_elements_text($4::jsonb) AS x`, [inp.scrId, id, holdExp, J(seatIds)]],
    ]);
  } catch (e) {
    if (!isUnique(e)) throw e;
    const dup = await loadOrders(`idem=$1`, [idem], now);
    if (dup.length) return dup[0];
    const t = await q(`SELECT seat_id FROM seat_locks WHERE scr_id=$1 AND seat_id IN (SELECT jsonb_array_elements_text($2::jsonb))`, [inp.scrId, J(seatIds)]);
    throw new ApiError(409, 'SEATS_TAKEN', 'Эти места только что заняли', { seatIds: t.map((x) => x.seat_id) });
  }
  return orderByToken(token, now);
}

export async function cancelByCustomer(token, now) {
  const o = await orderByToken(token, now);
  if (o.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'Этот заказ нельзя отменить');
  await tx([[`UPDATE orders SET status='CANCELLED' WHERE id=$1 AND status='PENDING_PAYMENT'`, [o.id]], [`DELETE FROM seat_locks WHERE order_id=$1 AND status='HELD'`, [o.id]]]);
  return orderByToken(token, now);
}

const newTickets = (o) => o.items.filter((i) => i.status === 'ACTIVE').map((i) => ({ id: uid('tkt'), item_id: i.id, seat_id: i.seatId, r: i.r, n: i.n, price: i.price, number: 'BZT-' + code(4) + '-' + code(4), token: rnd(24) }));
const ticketInsert = (o, tickets, now) => [
  `INSERT INTO tickets(id,order_id,item_id,scr_id,seat_id,r,n,price,number,token,status,created)
   SELECT t.id,$1,t.item_id,$2,t.seat_id,t.r,t.n,t.price,t.number,t.token,'VALID',$3
   FROM jsonb_to_recordset($4::jsonb) AS t(id text,item_id text,seat_id text,r int,n int,price int,number text,token text)
   WHERE EXISTS(SELECT 1 FROM orders WHERE id=$1 AND status='PAID') ON CONFLICT (item_id) DO NOTHING`,
  [o.id, o.scrId, now, J(tickets)]];
/** Statements that turn a held order into a paid one with tickets. Each step only runs if the previous one took effect. */
const payStmts = (o, now) => [
  [`UPDATE orders SET status='PAID', paid_at=$2, review=false WHERE id=$1 AND status='PENDING_PAYMENT' AND hold_exp>$2`, [o.id, now]],
  [`UPDATE seat_locks SET status='SOLD', exp=NULL WHERE order_id=$1 AND EXISTS(SELECT 1 FROM orders WHERE id=$1 AND status='PAID')`, [o.id]],
  ticketInsert(o, newTickets(o), now),
];

/**
 * Buyer uploads a receipt. We read it, compare with the order and, if everything matches, issue tickets at once.
 * This cannot prove that money arrived — a forged picture passes too. The admin can cancel tickets later.
 */
export async function submitReceipt(token, image, now, read = readReceipt, manual = false) {
  await cleanup(now);
  const o = await orderByToken(token, now);
  if (o.status === 'EXPIRED') throw new ApiError(410, 'HOLD_EXPIRED', 'Время брони истекло, места освобождены');
  if (o.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'Заказ не ожидает оплаты');
  if (o.review) throw new ApiError(409, 'IN_REVIEW', 'Чек уже на проверке');
  if (o.attempts >= 8) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Слишком много попыток. Отправьте чек на ручную проверку.');
  const s = await getSettings();
  if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png);base64,/.test(image) || image.length > 4_000_000) throw new ApiError(400, 'BAD_IMAGE', 'Нужен скриншот или PDF чека');
  let r = null;
  if (!manual) {
    try { r = await read(image, s.recipientPattern); }
    catch (e) { if (e.code === 'BAD_IMAGE') throw new ApiError(400, 'BAD_IMAGE', e.message); console.error('receipt reader failed', e); }
  }
  if (!r) { // the reader is unavailable: keep the picture and let a human decide; seats stay held for 24 hours
    const exp = now + 24 * 3600000;
    await tx([
      [`INSERT INTO receipts(id,order_id,status,reason,image,created) VALUES($1,$2,'REVIEW','MANUAL',$3,$4)`, [uid('rc'), o.id, image, now]],
      [`UPDATE orders SET review=true, hold_exp=$2 WHERE id=$1 AND status='PENDING_PAYMENT'`, [o.id, exp]],
      [`UPDATE seat_locks SET exp=$2 WHERE order_id=$1 AND status='HELD'`, [o.id, exp]],
    ]);
    return { ok: false, review: true, order: await orderByToken(token, now) };
  }
  let problems = checkReceipt(r, o, now);
  const rid = uid('rc');
  const save = (status, reason) => [`INSERT INTO receipts(id,order_id,number,amount,paid_at,sender,status,reason,ocr_text,image,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [rid, o.id, r.number, r.amount, r.paidAt, r.sender, status, reason, r.text || '', typeof image === 'string' ? image : null, now]];
  if (!problems.length) {
    try {
      await tx([save('ACCEPTED', null), ...payStmts(o, now)]);
      const after = await orderByToken(token, now);
      if (after.status === 'PAID') return { ok: true, order: after };
      await q(`DELETE FROM receipts WHERE id=$1`, [rid]); // hold ran out in the same second
      throw new ApiError(410, 'HOLD_EXPIRED', 'Время брони истекло, места освобождены');
    } catch (e) { if (!isUnique(e)) throw e; problems = ['DUPLICATE']; }
  }
  await tx([save('REJECTED', problems.join(',')), [`UPDATE orders SET attempts=attempts+1 WHERE id=$1`, [o.id]]]);
  return { ok: false, problems, read: { number: r.number, amount: r.amount, paidAtText: r.paidAtText, recipientOk: r.recipientOk }, expected: { total: o.total, recipient: s.recipient }, order: await orderByToken(token, now) };
}

/**
 * Admin: run the reader again over a receipt that waits for a human (for example the reader was down when it was uploaded).
 * A correct receipt is accepted and tickets are issued; otherwise what was read is saved next to the picture.
 */
export async function rereadReview(orderId, now, read = readReceipt) {
  await cleanup(now);
  const o = await orderById(orderId, now);
  if (o.status !== 'PENDING_PAYMENT' || !o.review) throw new ApiError(409, 'CONFLICT', 'У этого заказа нет чека на проверке');
  const rc = (await q(`SELECT id,image FROM receipts WHERE order_id=$1 AND status='REVIEW' AND image IS NOT NULL ORDER BY created DESC LIMIT 1`, [o.id]))[0];
  if (!rc) throw new ApiError(409, 'CONFLICT', 'Картинка чека не сохранена');
  const s = await getSettings();
  let r; try { r = await read(rc.image, s.recipientPattern); } catch (e) { console.error('receipt reader failed', e); throw new ApiError(503, 'OCR_FAILED', 'Программа не смогла прочитать чек'); }
  // the buyer may have waited for hours: compare the receipt time with the upload time, not with "now"
  let problems = checkReceipt(r, o, now).filter((p) => p !== 'IN_FUTURE');
  try {
    await q(`UPDATE receipts SET number=$2, amount=$3, paid_at=$4, sender=$5, ocr_text=$6, reason=$7 WHERE id=$1`, [rc.id, r.number, r.amount, r.paidAt, r.sender, r.text || '', problems.join(',') || 'MANUAL']);
  } catch (e) {
    if (!isUnique(e)) throw e;
    problems = ['DUPLICATE'];
    await q(`UPDATE receipts SET amount=$2, paid_at=$3, sender=$4, ocr_text=$5, reason='DUPLICATE' WHERE id=$1`, [rc.id, r.amount, r.paidAt, r.sender, r.text || '']);
  }
  if (problems.length) return { ok: false, problems, order: await orderById(o.id, now) };
  return { ok: true, order: await adminAction({ orderId: o.id, action: 'approve', note: 'auto: receipt read again' }, 'reader', now) };
}

/** Buyer asks a human to look at the last rejected receipt. Seats stay held for 24 hours. */
export async function requestReview(token, now) {
  await cleanup(now);
  const o = await orderByToken(token, now);
  if (o.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'Заказ не ожидает оплаты');
  if (o.review) return o;
  const last = await q(`SELECT id FROM receipts WHERE order_id=$1 AND status='REJECTED' AND image IS NOT NULL ORDER BY created DESC LIMIT 1`, [o.id]);
  if (!last.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Сначала загрузите чек');
  const exp = now + 24 * 3600000;
  try {
    await tx([
      [`UPDATE receipts SET status='REVIEW' WHERE id=$1`, [last[0].id]],
      [`UPDATE orders SET review=true, hold_exp=$2 WHERE id=$1 AND status='PENDING_PAYMENT'`, [o.id, exp]],
      [`UPDATE seat_locks SET exp=$2 WHERE order_id=$1 AND status='HELD'`, [o.id, exp]],
    ]);
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'DUPLICATE', 'Этот чек уже использован для другого заказа'); throw e; }
  return orderByToken(token, now);
}

// ───────────────────────────── admin ─────────────────────────────
export async function adminOverview(now) {
  await cleanup(now);
  const orders = await loadOrders(`true ORDER BY created DESC LIMIT 3000`, [], now);
  const receipts = await q(`SELECT id, order_id, number, amount, paid_at, sender, status, reason, created, (image IS NOT NULL) AS has_image FROM receipts ORDER BY created DESC LIMIT 6000`);
  const log = await q(`SELECT at, actor, action, entity, detail FROM audit ORDER BY id DESC LIMIT 200`);
  return { now, settings: await getSettings(), orders, receipts, audit: log };
}
export async function receiptImage(id) {
  const r = await q(`SELECT image, ocr_text FROM receipts WHERE id=$1`, [String(id)]);
  if (!r.length) throw new ApiError(404, 'NOT_FOUND', 'Чек не найден');
  return r[0];
}
async function orderById(id, now) { const r = await loadOrders(`id=$1`, [String(id)], now); if (!r.length) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден'); return r[0]; }

export async function adminAction(inp, actor, now) {
  await cleanup(now);
  const o = await orderById(inp.orderId, now);
  if (inp.action === 'approve') { // accept without (or despite) the automatic check: review queue, expired order, cash, etc.
    if (!['PENDING_PAYMENT', 'EXPIRED'].includes(o.status)) throw new ApiError(409, 'CONFLICT', 'Этот заказ уже обработан');
    const seatIds = o.items.map((i) => i.seatId);
    try {
      await tx([
        [`DELETE FROM seat_locks WHERE scr_id=$1 AND status='HELD' AND exp<$2`, [o.scrId, now]],
        [`INSERT INTO seat_locks(scr_id,seat_id,order_id,status,exp) SELECT $1, x, $2, 'SOLD', NULL FROM jsonb_array_elements_text($3::jsonb) AS x
          ON CONFLICT (scr_id,seat_id) DO UPDATE SET status='SOLD', exp=NULL WHERE seat_locks.order_id=EXCLUDED.order_id`, [o.scrId, o.id, J(seatIds)]],
        [`UPDATE orders SET status='PAID', paid_at=$2, review=false WHERE id=$1 AND status IN ('PENDING_PAYMENT','EXPIRED')
          AND (SELECT count(*) FROM seat_locks WHERE order_id=$1 AND status='SOLD')=$3`, [o.id, now, seatIds.length]],
        // if another order took one of the seats, undo our part so nothing is half-sold
        [`DELETE FROM seat_locks WHERE order_id=$1 AND NOT EXISTS(SELECT 1 FROM orders WHERE id=$1 AND status='PAID')`, [o.id]],
        [`UPDATE receipts SET status='ACCEPTED', reason=NULL WHERE order_id=$1 AND status='REVIEW' AND EXISTS(SELECT 1 FROM orders WHERE id=$1 AND status='PAID')`, [o.id]],
        ticketInsert(o, newTickets(o), now),
      ]);
    } catch (e) { if (isUnique(e)) throw new ApiError(409, 'DUPLICATE', 'Чек с таким номером уже принят в другом заказе'); throw e; }
    const after = await orderById(o.id, now);
    if (after.status !== 'PAID') throw new ApiError(409, 'SEATS_TAKEN', 'Места этого заказа уже заняты другими');
    await audit(now, actor, 'order.approve', o.number, inp.note || '');
    return after;
  }
  if (inp.action === 'rejectReview') {
    if (o.status !== 'PENDING_PAYMENT' || !o.review) throw new ApiError(409, 'CONFLICT', 'Этот заказ не на проверке');
    const s = await getSettings(), exp = now + s.holdMin * 60000, reason = String(inp.note || '').trim().slice(0, 200) || 'MANUAL_REJECT';
    await tx([
      [`UPDATE receipts SET status='REJECTED', reason=$2 WHERE order_id=$1 AND status='REVIEW'`, [o.id, reason]],
      [`UPDATE orders SET review=false, hold_exp=$2, attempts=0 WHERE id=$1`, [o.id, exp]],
      [`UPDATE seat_locks SET exp=$2 WHERE order_id=$1 AND status='HELD'`, [o.id, exp]],
    ]);
    await audit(now, actor, 'receipt.reject', o.number, reason);
    return orderById(o.id, now);
  }
  if (inp.action === 'cancel') { // e.g. the receipt turned out to be fake: tickets stop working, seats go back on sale
    if (o.status === 'CANCELLED') return o;
    const reason = String(inp.note || '').trim().slice(0, 200) || 'Отменён администратором';
    await tx([
      [`UPDATE orders SET status='CANCELLED', cancel_reason=$2, review=false WHERE id=$1`, [o.id, reason]],
      [`UPDATE tickets SET status='CANCELLED' WHERE order_id=$1`, [o.id]],       // also tickets already scanned at the entrance
      [`DELETE FROM seat_locks WHERE order_id=$1`, [o.id]],
    ]);
    await audit(now, actor, 'order.cancel', o.number, reason);
    return orderById(o.id, now);
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Неизвестное действие');
}

/**
 * Email the tickets of a paid order. Never throws: a failed letter must not undo a sale.
 * Sent once per order unless `force` (the admin's "send again" button).
 */
export async function mailTickets(orderId, now, site, force = false) {
  try {
    if (!mailConfigured()) return 'OFF';
    const o = await orderById(orderId, now);
    if (o.status !== 'PAID' || !o.customer.email) return 'SKIP';
    if (!force) { const got = await q(`UPDATE orders SET mail_at=$2 WHERE id=$1 AND mail_at IS NULL RETURNING id`, [o.id, now]); if (!got.length) return 'ALREADY'; } // claim first: two requests never send twice
    const s = await getSettings();
    try {
      await sendMail(ticketLetter(o, { site, startsAt: s.startsAt, hall: SCREENINGS[o.scrId].hall, phone: s.kaspi }));
      await q(`UPDATE orders SET mail_at=$2, mail_err=NULL WHERE id=$1`, [o.id, now]);
      return 'SENT';
    } catch (e) {
      console.error('mail failed', o.number, e);
      await q(`UPDATE orders SET mail_at=NULL, mail_err=$2 WHERE id=$1`, [o.id, String(e && e.message || e).slice(0, 200)]);
      return 'FAILED';
    }
  } catch (e) { console.error('mail failed', e); return 'FAILED'; }
}

/** Entrance check. A ticket is accepted exactly once: the UPDATE only matches while it is still VALID. */
export async function validateTicket(inp, staff, now) {
  const s = String(inp.qr || '').trim();
  const rows = s.startsWith('BZ1.') ? await q(`SELECT * FROM tickets WHERE token=$1`, [s.slice(4)]) : s ? await q(`SELECT * FROM tickets WHERE number=$1`, [s.toUpperCase()]) : [];
  if (!rows.length) return { res: 'INVALID_TOKEN' };
  const t = rows[0], info = { number: t.number, scrId: t.scr_id, hall: SCREENINGS[t.scr_id]?.hall, r: t.r, n: t.n, status: t.status, checkedAt: t.checked_at };
  if (inp.scrId && t.scr_id !== inp.scrId) return { res: 'WRONG_SCREENING', info };
  if (t.status === 'USED') return { res: 'ALREADY_USED', info };
  if (t.status !== 'VALID') return { res: 'CANCELLED', info };
  const upd = await q(`UPDATE tickets SET status='USED', checked_at=$2, checked_by=$3 WHERE id=$1 AND status='VALID' RETURNING checked_at`, [t.id, now, staff || 'staff']);
  if (!upd.length) return { res: 'ALREADY_USED', info: { ...info, status: 'USED' } };
  return { res: 'ACCEPTED', info: { ...info, status: 'USED', checkedAt: now } };
}
