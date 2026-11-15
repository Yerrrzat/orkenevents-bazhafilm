# ORKEN EVENTS — «Бажа»

Ticket site for the group screening of «Бажа» (Arman Asia Park, Astana).

## What is here

| Path | What it is |
|---|---|
| `public/index.html` | The whole site in one file (Kazakh / Russian): halls, booking, receipt upload, tickets, admin panel (`#/admin`), entrance scanner (`#/staff`). |
| `public/vendor/` | pdf.js — turns an uploaded PDF receipt into a picture in the browser. |
| `netlify/functions/api.mjs` | Server API (`/api/*`): seat holds, orders, receipt check, tickets, admin, entrance scan. |
| `netlify/functions/lib/` | Rules (`core.mjs`), receipt reader (`receipt.mjs`), database layer (`db.mjs`), hall layouts (`halls.mjs`). |
| `netlify/functions/data/` | Language data for reading receipts and a self-test picture. |
| `tests/run.mjs` | Local tests (in-memory Postgres + real receipt reader). `npm install && npm test` |

## How payment works

1. Buyer picks seats; the seats are held for 15 minutes.
2. Buyer transfers the money by Kaspi and uploads the receipt (screenshot or PDF).
3. The server reads the receipt and checks: amount, receiver, receipt number not used before, time after the order.
4. If everything matches, tickets with QR codes are issued at once.

The check cannot prove that money arrived. Before the screening the organizer compares the receipt
list in the admin panel with Kaspi history and cancels orders with fake receipts — their tickets stop working.

## Netlify environment variables

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string. Without it the site only shows halls (sales closed). |
| `ADMIN_KEY` | Long secret (16+ characters) for the admin panel. |
| `GMAIL_USER` | Gmail address the tickets are emailed from. Optional: without it the site works, letters are just not sent. |
| `GMAIL_APP_PASSWORD` | 16-letter Google "app password" for that mailbox (not the normal password). |
| `STAFF_KEY` | Secret for entrance staff (ticket scanning only). |

Tables are created automatically on the first request. Sales are opened in the admin panel.

Health check: `/api/health` (add `?ocr=1` to test the receipt reader).
