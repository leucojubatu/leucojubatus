'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./store');
const { SessionStore, parseCookies, rateLimiter } = require('./security');

const PORT = Number(process.env.PORT) || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // set to 1 when served over HTTPS
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;

const info = store.init();
if (info.generatedPassword) {
  console.log('');
  console.log('  Admin password (generated, shown once): ' + info.generatedPassword);
  console.log('  Log in with it, then change it on the Bills tab.');
  console.log('  To choose your own next time, set ADMIN_PASSWORD before the first start.');
  console.log('');
}

const sessions = new SessionStore(SESSION_HOURS * 3600 * 1000);

// The app page is one HTML file. Its data is injected per request (see below).
const TEMPLATE_FILE = path.join(__dirname, 'views', 'index.html');
const TEMPLATE = fs.readFileSync(TEMPLATE_FILE, 'utf8');
const MARK = '/*__BOOT__*/null';
if (TEMPLATE.indexOf(MARK) < 0) throw new Error('views/index.html is missing the boot marker');

const loginLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const orderLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const trackLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 120 });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

function currentSession(req) {
  return sessions.get(parseCookies(req.headers.cookie).lj_sid);
}

/** JSON that is safe to place inside a <script> tag. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sessionCookie(token) {
  return 'lj_sid=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
    (SESSION_HOURS * 3600) + (COOKIE_SECURE ? '; Secure' : '');
}

// ---- The app page -----------------------------------------------------------

app.get('/', (req, res) => {
  const s = currentSession(req);
  const boot = s
    ? { server: true, admin: true, me: { name: s.name, role: s.role }, version: store.getVersion(), state: store.adminView() }
    : { server: true, admin: false, version: store.getVersion(), state: store.publicView() };
  res.set('Cache-Control', 'no-store');
  res.type('html').send(TEMPLATE.replace(MARK, scriptJson(boot)));
});

// ---- Public API ---------------------------------------------------------------

app.get('/api/public', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.publicView());
});

app.get('/api/track', trackLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ orders: store.trackOrders(String(req.query.q || '')) });
});

app.post('/api/orders', orderLimit, (req, res, next) => {
  try {
    const order = store.createOrder(req.body || {});
    res.status(201).json({ order: store.publicOrder(order) });
  } catch (e) {
    next(e);
  }
});

// ---- Login ----------------------------------------------------------------------

app.post('/api/login', loginLimit, (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (!password) return res.status(400).json({ error: 'Enter the password' });
  const who = store.checkLogin(password);
  if (!who) return res.status(401).json({ error: 'Wrong password. Try again.' });
  const token = sessions.create(who);
  res.set('Set-Cookie', sessionCookie(token));
  res.json({ name: who.name, role: who.role });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).lj_sid;
  if (token) sessions.destroy(token);
  res.set('Set-Cookie', 'lj_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

// ---- Admin ----------------------------------------------------------------------

app.put('/api/admin/state', (req, res, next) => {
  const s = currentSession(req);
  if (!s) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  try {
    const body = req.body || {};
    res.json(store.applyAdminWrite(body.state, body.baseVersion, s));
  } catch (e) {
    next(e);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: store.getVersion() }));

// ---- Errors ---------------------------------------------------------------------

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Something went wrong on the server.' : err.message;
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log('LEUCO JUBATUS store running at http://localhost:' + PORT);
});
