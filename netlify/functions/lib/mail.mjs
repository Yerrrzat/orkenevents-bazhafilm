// Sends tickets by email through a Gmail mailbox (free: up to 500 letters a day).
// Needs two settings in Netlify: GMAIL_USER (the address) and GMAIL_APP_PASSWORD (an "app password", not the normal one).
import nodemailer from 'nodemailer';   // a plain import, so the packager always ships it

let custom = null;
/** tests replace the real sender */
export function useMailer(fn) { custom = fn; }
export const mailConfigured = () => !!custom || !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
      connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 8000,
      tls: process.env.SMTP_INSECURE ? { rejectUnauthorized: false } : undefined,
    });
  }
  return transport;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The letter itself: Kazakh first, then Russian. `o` is an order as the API returns it. */
export function ticketLetter(o, info) {
  const link = `${info.site}/#/order/${o.token}`;
  const [d, t] = info.startsAt.split('T'), date = d.split('-').reverse().join('.');
  const seats = o.items.map((i) => {
    const tk = o.tickets.find((x) => x.itemId === i.id);
    return { r: i.r, n: i.n, num: tk ? tk.number : '' };
  });
  const text = [
    `Сәлеметсіз бе, ${o.customer.name}!`, '',
    `«Бажа» фильміне билеттеріңіз дайын.`, `Күні: ${date}, ${t}`, `Орны: Arman Asia Park, Астана — ${info.hall}-зал`, '',
    ...seats.map((s) => `${s.r}-қатар, ${s.n}-орын — билет № ${s.num}`), '',
    `Билеттерді ашу (QR-код және PDF): ${link}`, `Кіреберісте QR-кодты телефоннан көрсетіңіз.`, '',
    '— — —', '',
    `Здравствуйте, ${o.customer.name}!`, '',
    `Ваши билеты на фильм «Бажа» готовы.`, `Дата: ${date}, ${t}`, `Место: Arman Asia Park, Астана — зал ${info.hall}`, '',
    ...seats.map((s) => `Ряд ${s.r}, место ${s.n} — билет № ${s.num}`), '',
    `Открыть билеты (QR-код и PDF): ${link}`, `На входе покажите QR-код с телефона.`, '',
    `Тапсырыс / Заказ: ${o.number}`, `ORKEN EVENTS · ${info.phone}`,
  ].join('\n');
  const rows = (kk) => seats.map((s) => `<tr><td style="padding:6px 12px 6px 0">${kk ? `${s.r}-қатар, ${s.n}-орын` : `Ряд ${s.r}, место ${s.n}`}</td><td style="padding:6px 0;font-family:monospace">№ ${esc(s.num)}</td></tr>`).join('');
  const btn = (label) => `<p style="margin:18px 0"><a href="${esc(link)}" style="background:#d4a017;color:#111;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">${label}</a></p>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
<p>Сәлеметсіз бе, ${esc(o.customer.name)}!</p>
<p><b>«Бажа» фильміне билеттеріңіз дайын.</b><br>Күні: ${date}, ${t}<br>Орны: Arman Asia Park, Астана — ${info.hall}-зал</p>
<table style="border-collapse:collapse">${rows(true)}</table>${btn('Билеттерді ашу')}
<p style="color:#555">Кіреберісте QR-кодты телефоннан көрсетіңіз.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:22px 0">
<p>Здравствуйте, ${esc(o.customer.name)}!</p>
<p><b>Ваши билеты на фильм «Бажа» готовы.</b><br>Дата: ${date}, ${t}<br>Место: Arman Asia Park, Астана — зал ${info.hall}</p>
<table style="border-collapse:collapse">${rows(false)}</table>${btn('Открыть билеты')}
<p style="color:#555">На входе покажите QR-код с телефона.</p>
<p style="color:#888;font-size:13px">Тапсырыс / Заказ: ${esc(o.number)}<br>ORKEN EVENTS · ${esc(info.phone)}</p></div>`;
  return { to: o.customer.email, subject: `«Бажа» — билеттеріңіз / ваши билеты (${o.number})`, text, html };
}

export async function sendMail(letter) {
  if (custom) return custom(letter);
  await getTransport().sendMail({ from: `"ORKEN EVENTS" <${process.env.GMAIL_USER}>`, ...letter });
}
