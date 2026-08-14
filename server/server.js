/* ═══════════════════════════════════════════════════════════════════════════
   YS NEW YORK — the register server
   Owns the one thing the browser must never own: the hundred numbers.

   Edition logic:
   - Numbers 1..100 exist as rows from the start.
   - A number is FREE, HELD (expires_at set, order pending), or SOLD.
   - Assignment is a single SQL transaction: the next FREE number is claimed
     atomically, so two simultaneous buyers can never receive the same one.
   - Holds expire after HOLD_HOURS; a sweep frees them lazily on every read.

   Payments:
   - With STRIPE_SECRET_KEY set, /api/orders creates a Stripe Checkout Session
     and returns its URL; the webhook marks numbers SOLD on payment.
   - Without it, the server runs in DEMO mode: orders confirm instantly and are
     marked demo=1. Never point real customers at demo mode.

   Run:  node server.js            (PORT, DATABASE_PATH, STRIPE_SECRET_KEY,
                                    STRIPE_WEBHOOK_SECRET, RESEND_API_KEY,
                                    CORS_ORIGIN optional)
   ═══════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const HOLD_HOURS = 48;
const PRICE_CENTS = 58000;                    // $580 — keep in one place
const CURRENCY = 'usd';
const EDITION = 100;
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const db = new Database(process.env.DATABASE_PATH || 'register.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS numbers (
    n INTEGER PRIMARY KEY CHECK(n BETWEEN 1 AND ${EDITION}),
    state TEXT NOT NULL DEFAULT 'FREE' CHECK(state IN ('FREE','HELD','SOLD')),
    hold_token TEXT, expires_at INTEGER, order_id TEXT
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
    first TEXT NOT NULL, last TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, city TEXT, country TEXT,
    address TEXT, ship TEXT NOT NULL, numbers TEXT NOT NULL, total_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','CANCELLED')),
    stripe_session TEXT, account_id TEXT, demo INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, name TEXT, email TEXT, subject TEXT, body TEXT, created_at INTEGER
  );
`);
const seeded = db.prepare('SELECT COUNT(*) c FROM numbers').get().c;
if (seeded === 0) {
  const ins = db.prepare('INSERT INTO numbers(n) VALUES (?)');
  const tx = db.transaction(() => { for (let n = 1; n <= EDITION; n++) ins.run(n); });
  tx();
}

const app = express();
// Stripe webhooks need the raw body; everything else JSON.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const now = () => Math.floor(Date.now() / 1000);
const uid = (p) => p + '-' + crypto.randomBytes(9).toString('base64url');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Lazy sweep: any expired hold returns to the pool before we read. */
const sweep = db.prepare(
  `UPDATE numbers SET state='FREE', hold_token=NULL, expires_at=NULL
   WHERE state='HELD' AND expires_at < ?`);
function freshen() { sweep.run(now()); }

/* ── transactional e-mail. Wire RESEND_API_KEY; until then, log. ── */
async function sendMail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) { console.log(`[mail:demo] to=${to} :: ${subject}`); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
               'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'YS New York <register@ysnewyork.com>', to, subject, text })
  }).catch(e => console.error('mail failed', e.message));
}
const padN = n => String(n).padStart(3, '0');

/* ═══ EDITION ═══ */

app.get('/api/edition', (req, res) => {
  freshen();
  const r = db.prepare(`SELECT
      SUM(state='FREE') free, SUM(state='HELD') held, SUM(state='SOLD') sold
    FROM numbers`).get();
  const next = db.prepare(`SELECT n FROM numbers WHERE state='FREE' ORDER BY n LIMIT 1`).get();
  res.json({ edition: EDITION, free: r.free, held: r.held, sold: r.sold,
             next: next ? next.n : null, price_cents: PRICE_CENTS, hold_hours: HOLD_HOURS });
});

/* Claim the next free number atomically. Returns {n, hold_token, expires_at}. */
const claimTx = db.transaction((token, exp) => {
  const row = db.prepare(`SELECT n FROM numbers WHERE state='FREE' ORDER BY n LIMIT 1`).get();
  if (!row) return null;
  db.prepare(`UPDATE numbers SET state='HELD', hold_token=?, expires_at=? WHERE n=? AND state='FREE'`)
    .run(token, exp, row.n);
  return row.n;
});
app.post('/api/holds', (req, res) => {
  freshen();
  const token = uid('hold'), exp = now() + HOLD_HOURS * 3600;
  const n = claimTx(token, exp);
  if (n == null) return res.status(410).json({ error: 'The edition is spoken for.' });
  res.json({ n, hold_token: token, expires_at: exp });
});
app.delete('/api/holds/:token', (req, res) => {
  const r = db.prepare(
    `UPDATE numbers SET state='FREE', hold_token=NULL, expires_at=NULL
     WHERE hold_token=? AND state='HELD'`).run(req.params.token);
  res.json({ released: r.changes > 0 });
});

/* ═══ ACCOUNTS ═══ */

function auth(req) {
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!t) return null;
  const s = db.prepare('SELECT account_id FROM sessions WHERE token=?').get(t);
  return s ? db.prepare('SELECT id,email,first,last FROM accounts WHERE id=?').get(s.account_id) : null;
}
app.post('/api/auth/register', async (req, res) => {
  const { email, password, first, last } = req.body || {};
  if (!EMAIL.test(email || '')) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Eight characters or more.' });
  if (!first || !last) return res.status(400).json({ error: 'Name required.' });
  if (db.prepare('SELECT 1 FROM accounts WHERE email=?').get(email.toLowerCase()))
    return res.status(409).json({ error: 'That email is already in the register.' });
  const id = uid('acct');
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?)')
    .run(id, email.toLowerCase(), await bcrypt.hash(password, 11), first, last, now());
  const token = uid('sess');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, id, now());
  res.json({ token, account: { email: email.toLowerCase(), first, last } });
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const a = db.prepare('SELECT * FROM accounts WHERE email=?').get((email || '').toLowerCase());
  if (!a || !(await bcrypt.compare(password || '', a.pw_hash)))
    return res.status(401).json({ error: 'No account with that email and password.' });
  const token = uid('sess');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, a.id, now());
  res.json({ token, account: { email: a.email, first: a.first, last: a.last } });
});
app.get('/api/auth/me', (req, res) => {
  const a = auth(req);
  if (!a) return res.status(401).json({ error: 'Signed out.' });
  const orders = db.prepare(
    `SELECT id, numbers, status, created_at FROM orders
     WHERE account_id=? AND status IN ('PAID','PENDING') ORDER BY created_at DESC`).all(a.id);
  res.json({ account: { email: a.email, first: a.first, last: a.last },
             orders: orders.map(o => ({ ...o, numbers: JSON.parse(o.numbers) })) });
});
app.post('/api/auth/logout', (req, res) => {
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.json({ ok: true });
});

/* ═══ ORDERS ═══ */

app.post('/api/orders', async (req, res) => {
  freshen();
  const { holds, email, name, address, city, country, ship } = req.body || {};
  if (!Array.isArray(holds) || !holds.length) return res.status(400).json({ error: 'Nothing held.' });
  if (!EMAIL.test(email || '')) return res.status(400).json({ error: 'Enter a valid email.' });

  const rows = holds.map(t =>
    db.prepare(`SELECT n FROM numbers WHERE hold_token=? AND state='HELD' AND expires_at>?`)
      .get(t, now()));
  if (rows.some(r => !r))
    return res.status(410).json({ error: 'A hold has expired — the number returned to the register.' });
  const nums = rows.map(r => r.n);

  const shipCents = ship === 'express' ? 4000 : 0;
  const total = nums.length * PRICE_CENTS + shipCents;
  const id = uid('YS').toUpperCase();
  const a = auth(req);

  db.prepare(`INSERT INTO orders
      (id,email,name,city,country,address,ship,numbers,total_cents,status,account_id,demo,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, email.toLowerCase(), name || '', city || '', country || '', address || '',
         ship === 'express' ? 'express' : 'standard',
         JSON.stringify(nums), total, 'PENDING', a ? a.id : null, stripe ? 0 : 1, now());
  db.prepare(`UPDATE numbers SET order_id=? WHERE n IN (${nums.map(() => '?').join(',')})`)
    .run(id, ...nums);

  if (!stripe) {
    // DEMO: confirm instantly. Real launches must set STRIPE_SECRET_KEY.
    finalize(id);
    return res.json({ demo: true, order_id: id, numbers: nums, total_cents: total });
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email.toLowerCase(),
    line_items: nums.map(n => ({
      price_data: { currency: CURRENCY, unit_amount: PRICE_CENTS,
        product_data: { name: `L'Écharpe Monogramme — N° ${padN(n)} / ${EDITION}` } },
      quantity: 1 })),
    shipping_options: [{ shipping_rate_data: {
      display_name: ship === 'express' ? 'Express, ten days' : 'Insured, four weeks',
      type: 'fixed_amount',
      fixed_amount: { amount: shipCents, currency: CURRENCY } } }],
    metadata: { order_id: id },
    success_url: (process.env.SITE_URL || 'https://ysnewyork.com') + '/?order=' + id,
    cancel_url: (process.env.SITE_URL || 'https://ysnewyork.com') + '/?cancelled=1'
  });
  db.prepare('UPDATE orders SET stripe_session=? WHERE id=?').run(session.id, id);
  res.json({ checkout_url: session.url, order_id: id });
});

function finalize(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.status === 'PAID') return;
  const nums = JSON.parse(o.numbers);
  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET status=? WHERE id=?').run('PAID', orderId);
    db.prepare(`UPDATE numbers SET state='SOLD', hold_token=NULL, expires_at=NULL
                WHERE n IN (${nums.map(() => '?').join(',')})`).run(...nums);
  });
  tx();
  sendMail(o.email, `Entered in the register — N° ${nums.map(padN).join(' · ')}`,
`Your number is being written.

L'Écharpe Monogramme — N° ${nums.map(padN).join(' · ')} of ${EDITION}
Order ${orderId}

Woven double-face in merino and mulberry silk; the edge turned once and
whipped by hand. ${o.ship === 'express' ? 'Ten days' : 'Four weeks'}, insured, to ${o.city || 'you'}.

The edition number is written by hand on the care label after the cloth
is finished.

— YS New York`);
}

app.post('/api/stripe/webhook', (req, res) => {
  if (!stripe) return res.sendStatus(400);
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  if (event.type === 'checkout.session.completed')
    finalize(event.data.object.metadata.order_id);
  res.json({ received: true });
});

app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT id,numbers,status,ship,created_at FROM orders WHERE id=?')
    .get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No such order.' });
  res.json({ ...o, numbers: JSON.parse(o.numbers) });
});

/* ═══ CONTACT ═══ */

app.post('/api/contact', (req, res) => {
  const { name, email, subject, body } = req.body || {};
  if (!name || !EMAIL.test(email || '') || !subject || !body)
    return res.status(400).json({ error: 'Check the fields.' });
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)')
    .run(uid('msg'), name, email.toLowerCase(), subject, body, now());
  sendMail('hello@ysnewyork.com', `[site] ${subject}`, `${name} <${email}>\n\n${body}`);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, stripe: !!stripe }));

app.listen(PORT, () => console.log(
  `register server on :${PORT} — ${stripe ? 'STRIPE LIVE' : 'DEMO MODE (no STRIPE_SECRET_KEY)'}`));
