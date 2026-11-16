// Local tests: real Postgres engine in memory (PGlite) + the real receipt reader.
// Run: npm test            (optional: RECEIPT=/path/to/real-receipt.jpg npm test)
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { useDb, migrate, q } from '../netlify/functions/lib/db.mjs';
import * as core from '../netlify/functions/lib/core.mjs';
import { readReceipt } from '../netlify/functions/lib/receipt.mjs';

const pg = new PGlite();
useDb({ query: async (t, p = []) => (await pg.query(t, p)).rows, tx: (st) => pg.transaction(async (x) => { const out = []; for (const [t, p = []] of st) out.push((await x.query(t, p)).rows); return out; }) });
await migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  → ' + extra : '')); };
const code = async (f) => { try { await f(); return 'OK'; } catch (e) { return e.code || String(e.message); } };
const T0 = Date.UTC(2026, 10, 15, 15, 10);                    // 20:10 Astana
const base = (o = {}) => ({ idem: 'idem-' + Math.random().toString(36).slice(2) + 'xxxx', scrId: 'scr1', seatIds: ['h1r2s5'], name: 'Тест Тестов', phone: '8 701 123 45 67', email: 'buyer@example.com', offer: true, pd: true, ...o });
// fake receipt reader for rule tests (the real one is tested separately below)
const fake = (r) => async () => ({ number: '111111111111111111', amount: 2000, paidAt: T0 + 60000, paidAtText: 'x', recipientOk: true, sender: 'A', success: true, failedWord: false, text: '', ...r });
const IMG = 'data:image/jpeg;base64,AAAA';

ok('sales closed by default', (await code(() => core.createOrder(base(), T0, '1'))) === 'SALES_CLOSED');
await core.saveSettings({ salesOpen: true }, 'test', T0);
ok('hall 4 closed', (await code(() => core.createOrder(base({ scrId: 'scr4', seatIds: ['h4r1s1'] }), T0, '1'))) === 'SALES_CLOSED');
ok('unknown seat refused', (await code(() => core.createOrder(base({ seatIds: ['h1r99s1'] }), T0, '1'))) === 'VALIDATION_ERROR');
ok('bad phone refused', (await code(() => core.createOrder(base({ phone: '123' }), T0, '1'))) === 'VALIDATION_ERROR');

const A = await core.createOrder(base({ idem: 'same-key-12345' }), T0, '1');
ok('order created, 15 min hold', A.status === 'PENDING_PAYMENT' && A.total === 2000 && A.holdExp === T0 + 15 * 60000 && A.customer.phone === '+77011234567');
ok('same idempotency key → same order', (await core.createOrder(base({ idem: 'same-key-12345' }), T0, '1')).id === A.id);
ok('second buyer cannot take the seat', (await code(() => core.createOrder(base({ phone: '87010000002' }), T0, '2'))) === 'SEATS_TAKEN');
ok('state shows held seat', (await core.publicState(T0)).taken.scr1.h1r2s5 === 'H');

// 30 buyers click the same free seat at the same moment → exactly one wins
const race = await Promise.all(Array.from({ length: 30 }, (_, i) => code(() => core.createOrder(base({ seatIds: ['h1r3s3', 'h1r3s4'], phone: '8701' + String(1000000 + i) }), T0, 'ip' + i))));
ok('race for one seat: exactly 1 winner of 30', race.filter((x) => x === 'OK').length === 1 && race.filter((x) => x === 'SEATS_TAKEN').length === 29, race.filter((x) => x === 'OK').length + ' ok');

ok('too many unpaid orders from one phone', (await (async () => { await core.createOrder(base({ seatIds: ['h1r4s1'] }), T0, '1'); await core.createOrder(base({ seatIds: ['h1r4s2'] }), T0, '1'); return code(() => core.createOrder(base({ seatIds: ['h1r4s3'] }), T0, '1')); })()) === 'TOO_MANY_ORDERS');

// receipts
let r = await core.submitReceipt(A.token, IMG, T0 + 120000, fake({ amount: 4000 }));
ok('wrong amount rejected', !r.ok && r.problems.includes('WRONG_AMOUNT') && r.order.status === 'PENDING_PAYMENT' && r.order.attempts === 1);
r = await core.submitReceipt(A.token, IMG, T0 + 120000, fake({ recipientOk: false }));
ok('wrong recipient rejected', !r.ok && r.problems.includes('WRONG_RECIPIENT'));
r = await core.submitReceipt(A.token, IMG, T0 + 120000, fake({ paidAt: T0 - 3600000 }));
ok('receipt older than the order rejected', !r.ok && r.problems.includes('TOO_OLD'));
r = await core.submitReceipt(A.token, IMG, T0 + 120000, fake({ number: null }));
ok('unreadable number rejected', !r.ok && r.problems.includes('NO_NUMBER'));
r = await core.submitReceipt(A.token, IMG, T0 + 120000, fake({}));
ok('good receipt → paid, 1 ticket', r.ok && r.order.status === 'PAID' && r.order.tickets.length === 1 && r.order.tickets[0].status === 'VALID');
ok('state shows sold seat', (await core.publicState(T0 + 120000)).taken.scr1.h1r2s5 === 'S');
ok('paid order cannot take another receipt', (await code(() => core.submitReceipt(A.token, IMG, T0 + 130000, fake({})))) === 'CONFLICT');

const B = await core.createOrder(base({ seatIds: ['h1r5s1'], phone: '87010000009' }), T0, '9');
r = await core.submitReceipt(B.token, IMG, T0 + 120000, fake({}));
ok('same receipt number on another order rejected', !r.ok && r.problems.includes('DUPLICATE') && r.order.status === 'PENDING_PAYMENT');

// manual review
ok('duplicate receipt cannot be sent to manual review', (await code(() => core.requestReview(B.token, T0 + 125000))) === 'DUPLICATE');
r = await core.submitReceipt(B.token, IMG, T0 + 126000, fake({ number: '555555555555555555', recipientOk: false }));
const rv = await core.requestReview(B.token, T0 + 130000);
ok('review requested: 24h hold', rv.review && rv.holdExp === T0 + 130000 + 24 * 3600000);
ok('no upload while in review', (await code(() => core.submitReceipt(B.token, IMG, T0 + 140000, fake({ number: '222222222222222222' })))) === 'IN_REVIEW');
let b2 = await core.adminAction({ orderId: B.id, action: 'rejectReview', note: 'Не тот получатель' }, 'admin', T0 + 150000);
ok('admin rejects review → buyer can retry', !b2.review && b2.status === 'PENDING_PAYMENT' && b2.lastReceipt.reason === 'Не тот получатель');
b2 = await core.adminAction({ orderId: B.id, action: 'approve' }, 'admin', T0 + 160000);
ok('admin approves manually → paid with ticket', b2.status === 'PAID' && b2.tickets.length === 1);

// reader unavailable or buyer asks for a human → picture is kept, order waits for the admin
const M1 = await core.createOrder(base({ seatIds: ['h3r1s1'], scrId: 'scr3', phone: '87010000020' }), T0, '20');
let m = await core.submitReceipt(M1.token, IMG, T0 + 1000, async () => { throw new Error('engine down'); });
ok('reader crash → order goes to manual review', !m.ok && m.review && m.order.review && m.order.holdExp === T0 + 1000 + 24 * 3600000);
const M2 = await core.createOrder(base({ seatIds: ['h3r1s2'], scrId: 'scr3', phone: '87010000021' }), T0, '21');
m = await core.submitReceipt(M2.token, IMG, T0 + 1000, fake({}), true);
ok('manual flag → review without reading', m.review && m.order.lastReceipt.status === 'REVIEW');
const M3 = await core.createOrder(base({ seatIds: ['h3r1s3'], scrId: 'scr3', phone: '87010000022' }), T0, '22');
ok('not an image → refused', (await code(() => core.submitReceipt(M3.token, 'hello', T0 + 1000, fake({})))) === 'BAD_IMAGE');
ok('admin approves manual review → ticket', (await core.adminAction({ orderId: M1.id, action: 'approve' }, 'admin', T0 + 5000)).tickets.length === 1);

// expiry
const C = await core.createOrder(base({ seatIds: ['h1r6s1', 'h1r6s2'], phone: '87010000010' }), T0, '10');
const late = T0 + 16 * 60000;
ok('receipt after hold ran out → HOLD_EXPIRED', (await code(() => core.submitReceipt(C.token, IMG, late, fake({ number: '333333333333333333', amount: 4000, paidAt: late })))) === 'HOLD_EXPIRED');
ok('expired seats are free again', !(await core.publicState(late)).taken.scr1?.h1r6s1 && (await core.getOrdersByTokens([C.token], late))[0].status === 'EXPIRED');
const D = await core.createOrder(base({ seatIds: ['h1r6s1'], phone: '87010000011' }), late, '11');
ok('admin cannot approve expired order whose seat was taken', (await code(() => core.adminAction({ orderId: C.id, action: 'approve' }, 'admin', late))) === 'SEATS_TAKEN');
ok('…and the other buyer keeps the seat, nothing half-sold', (await core.publicState(late)).taken.scr1.h1r6s1 === 'H' && !(await core.publicState(late)).taken.scr1.h1r6s2);
ok('buyer cancels unpaid order', (await core.cancelByCustomer(D.token, late)).status === 'CANCELLED' && !(await core.publicState(late)).taken.scr1?.h1r6s1);

// entrance
const tk = (await core.getOrdersByTokens([A.token], late))[0].tickets[0];
ok('ticket accepted once', (await core.validateTicket({ qr: 'BZ1.' + tk.token, scrId: 'scr1' }, 'staff', late)).res === 'ACCEPTED');
ok('second scan refused', (await core.validateTicket({ qr: 'BZ1.' + tk.token, scrId: 'scr1' }, 'staff', late)).res === 'ALREADY_USED');
ok('wrong hall detected', (await core.validateTicket({ qr: b2.tickets[0].number, scrId: 'scr2' }, 'staff', late)).res === 'WRONG_SCREENING');
ok('unknown code refused', (await core.validateTicket({ qr: 'BZ1.nope' }, 'staff', late)).res === 'INVALID_TOKEN');
const par = await Promise.all(Array.from({ length: 10 }, () => core.validateTicket({ qr: b2.tickets[0].number, scrId: 'scr1' }, 'staff', late)));
ok('10 scanners at once: exactly 1 accepts', par.filter((x) => x.res === 'ACCEPTED').length === 1);

// tickets already scanned at the entrance, then the order is cancelled → seats still return
{
  const t = late + 500000;
  const U1 = await core.createOrder({ idem: 'used-then-cancel', scrId: 'scr3', seatIds: ['h3r2s1', 'h3r2s2'], name: 'Скан Отмена', phone: '87017770001', email: 'buyer@example.com', offer: true, pd: true }, t, '9.9.9.9');
  const pd = await core.adminAction({ orderId: U1.id, action: 'approve' }, 'admin', t + 1000);
  const sc = await core.validateTicket({ qr: 'BZ1.' + pd.tickets[0].token }, 'staff', t + 2000);
  const cn = await core.adminAction({ orderId: U1.id, action: 'cancel' }, 'admin', t + 3000);
  const st = (await core.publicState(t + 3000)).taken.scr3 || {};
  ok('cancel after scan: both seats free, tickets dead', sc.res === 'ACCEPTED' && cn.status === 'CANCELLED' && cn.tickets.every((x) => x.status === 'CANCELLED') && !st.h3r2s1 && !st.h3r2s2, JSON.stringify([sc.res, cn.status, st]));
  const again = await core.validateTicket({ qr: 'BZ1.' + pd.tickets[0].token }, 'staff', t + 4000);
  ok('cancelled ticket is refused at the entrance', again.res !== 'ACCEPTED', again.res);
}
// receipt number wrapped onto a second line: its tail must not be taken for the amount
{
  const { parseReceipt } = await import('../netlify/functions/lib/receipt.mjs');
  const a = parseReceipt('Перевод успешно совершен\n\nӨркен М.\n\n№ квитанции 9098938 76336095\n864\n\nДата и время 16.11.2026 00:53\n');
  ok('wrapped number: joined, tail is not an amount', a.number === '909893876336095864' && a.amount === null, JSON.stringify([a.number, a.amount]));
  const b = parseReceipt('Перевод успешно совершен\n2 000 т\n\nӨркен М.\n\n№ квитанции 9098983016748923\n56\n\nДата и время 16.11.2026 01:11\n');
  ok('wrapped number with amount above', b.number === '909898301674892356' && b.amount === 2000, JSON.stringify([b.number, b.amount]));
}
// tickets by email
{
  const { useMailer } = await import('../netlify/functions/lib/mail.mjs');
  const t = late + 900000, box = [];
  let noMail = null; try { await core.createOrder({ idem: 'no-mail-order', scrId: 'scr3', seatIds: ['h3r4s1'], name: 'Без Почты', phone: '87017770009', offer: true, pd: true }, t, '9.9.9.8'); } catch (e) { noMail = e.code; }
  ok('order without email is refused', noMail === 'VALIDATION_ERROR', noMail);
  const M = await core.createOrder({ idem: 'mail-order-1', scrId: 'scr3', seatIds: ['h3r4s1', 'h3r4s2'], name: 'Почта <Тест>', phone: '87017770002', email: 'guest@example.com', offer: true, pd: true }, t, '9.9.9.7');
  ok('no letter when mail is not set up', (await core.mailTickets(M.id, t, 'https://x.test')) === 'OFF');
  useMailer(async (l) => { box.push(l); });
  ok('no letter for an unpaid order', (await core.mailTickets(M.id, t, 'https://x.test')) === 'SKIP' && box.length === 0);
  const paid = await core.adminAction({ orderId: M.id, action: 'approve' }, 'admin', t + 1000);
  const r1 = await Promise.all([core.mailTickets(M.id, t + 2000, 'https://x.test'), core.mailTickets(M.id, t + 2000, 'https://x.test')]);
  const l = box[0] || {};
  ok('paid order: exactly one letter', r1.sort().join() === 'ALREADY,SENT' && box.length === 1, r1.join());
  ok('letter has link, seats and ticket numbers', l.to === 'guest@example.com' && l.text.includes('https://x.test/#/order/' + M.token) && paid.tickets.every((k) => l.text.includes(k.number) && l.html.includes(k.number)) && l.html.includes('&lt;Тест&gt;') && !l.html.includes('<Тест>'));
  ok('order shows when the letter went', !!(await core.getOrdersByTokens([M.token], t + 3000))[0].mailAt);
  ok('admin can send again', (await core.mailTickets(M.id, t + 4000, 'https://x.test', true)) === 'SENT' && box.length === 2);
  useMailer(async () => { throw new Error('mailbox full'); });
  const f = await core.mailTickets(M.id, t + 5000, 'https://x.test', true), o2 = (await core.getOrdersByTokens([M.token], t + 6000))[0];
  ok('failed letter: order stays paid, error is kept', f === 'FAILED' && o2.status === 'PAID' && o2.mailErr === 'mailbox full' && !o2.mailAt, JSON.stringify([f, o2.status, o2.mailErr]));
  useMailer(null);
}
// reader was down at upload → receipt waits for a human → admin runs the reader again
{
  const t = late + 1500000, img = 'data:image/jpeg;base64,AAAA';
  const mk = async (n, seat) => { const o = await core.createOrder(base({ idem: 'reread-order-' + n, scrId: 'scr3', seatIds: [seat], phone: '8701888000' + n }), t, '8.8.8.' + n); const r = await core.submitReceipt(o.token, img, t + 1000, async () => { throw new Error('engine down'); }); return [o, r]; };
  const good = (num, amount = 2000) => async () => ({ success: true, number: num, amount, recipientOk: true, paidAt: t + 500, paidAtText: 'x', sender: 'Тест Т.', text: 'txt' });
  const [a, ra] = await mk(1, 'h3r5s1'), [b] = await mk(2, 'h3r5s2'), [c] = await mk(3, 'h3r5s3');
  ok('reader down → receipt waits for a human', ra.review === true && ra.order.review === true);
  const r1 = await core.rereadReview(a.id, t + 7200000, good('909000000000000001'));
  ok('read again: correct receipt → paid, ticket issued', r1.ok && r1.order.status === 'PAID' && r1.order.tickets.length === 1, JSON.stringify([r1.ok, r1.problems]));
  const r2 = await core.rereadReview(b.id, t + 7200000, good('909000000000000001'));
  ok('read again: number already used → stays in review', !r2.ok && r2.problems.join() === 'DUPLICATE' && r2.order.status === 'PENDING_PAYMENT' && r2.order.review, JSON.stringify(r2.problems));
  const r3 = await core.rereadReview(c.id, t + 7200000, good('909000000000000003', 864));
  const ov = await core.adminOverview(t + 7200000), rc3 = ov.receipts.find((x) => x.order_id === c.id);
  ok('read again: wrong amount → stays in review, admin sees what was read', !r3.ok && r3.problems.join() === 'WRONG_AMOUNT' && rc3.status === 'REVIEW' && rc3.amount === 864 && rc3.number === '909000000000000003', JSON.stringify([r3.problems, rc3.status, rc3.amount]));
  let again = null; try { await core.rereadReview(a.id, t + 7300000, good('909000000000000009')); } catch (e) { again = e.code; }
  ok('read again on a paid order is refused', again === 'CONFLICT', again);
}
// fake receipt found later → admin cancels, ticket stops working, seat returns
const E = await core.createOrder(base({ seatIds: ['h1r7s1'], phone: '87010000012' }), late, '12');
const ePaid = (await core.submitReceipt(E.token, IMG, late + 1000, fake({ number: '444444444444444444', paidAt: late }))).order;
const eCan = await core.adminAction({ orderId: E.id, action: 'cancel', note: 'Деньги не пришли' }, 'admin', late + 2000);
ok('admin cancels paid order: ticket dead, seat free', eCan.status === 'CANCELLED' && eCan.tickets[0].status === 'CANCELLED' && !(await core.publicState(late + 2000)).taken.scr1?.h1r7s1
  && (await core.validateTicket({ qr: 'BZ1.' + ePaid.tickets[0].token }, 'staff', late + 3000)).res === 'CANCELLED');
const ov = await core.adminOverview(late + 3000);
ok('admin overview lists orders, receipts and audit', ov.orders.length >= 6 && ov.receipts.length >= 6 && ov.audit.length >= 3 && ov.receipts.every((x) => !('image' in x)));

// real reader on the built-in self-test picture
const st = await readReceipt(fs.readFileSync(new URL('../netlify/functions/data/selftest.jpg', import.meta.url)));
ok('reader: self-test picture', st.number === '123456789012345678' && st.amount === 2000 && st.recipientOk && st.paidAtText === '01.01.2026 12:00', JSON.stringify({ n: st.number, a: st.amount, r: st.recipientOk, d: st.paidAtText }));

// real reader + real rules on a real receipt, if one is given
for (const f of (process.env.RECEIPT || '').split(',').filter(Boolean)) {
  const img = 'data:image/' + (f.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(f).toString('base64');
  const o1 = await core.createOrder(base({ seatIds: ['h2r1s' + (1 + pass % 20)], scrId: 'scr2', phone: '8702' + String(1000000 + pass) }), T0, 'r' + pass);
  const t0 = Date.now(), res = await core.submitReceipt(o1.token, img, T0 + 4 * 60000);
  ok('REAL receipt ' + f.split('/').pop() + ' (' + (Date.now() - t0) + ' ms)', res.ok || res.problems.join() === 'DUPLICATE', res.ok ? 'accepted, ticket ' + res.order.tickets[0].number : res.problems.join(',') + ' ' + JSON.stringify(res.read));
  const o2 = await core.createOrder(base({ seatIds: ['h2r2s1', 'h2r2s2'], scrId: 'scr2', phone: '8703' + String(1000000 + pass) }), T0, 'q' + pass);
  const res2 = await core.submitReceipt(o2.token, img, T0 + 4 * 60000);
  ok('REAL receipt for a 2-ticket order → refused', !res2.ok, res2.problems.join(','));
  await core.cancelByCustomer(o2.token, T0 + 4 * 60000);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
