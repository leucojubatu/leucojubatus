'use strict';

/*
 * The whole shop lives in one JSON document ("state"), the same shape the
 * front-end has always used. This module owns that document:
 *
 *  - persists it to data/store.json (atomic write)
 *  - creates customer orders itself, so prices, coupons and stock are never
 *    taken from the browser
 *  - applies admin saves, merging them with orders that customers placed while
 *    the admin page was open, so nothing is silently lost
 *  - produces the two views that are sent to browsers: public (storefront
 *    only) and admin (everything except secrets)
 */

const fs = require('fs');
const path = require('path');
const { hashSecret, verifySecret, randomPassword } = require('./security');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const SEED_FILE = path.join(__dirname, '..', 'seed', 'initial-state.json');
const SOLD_LOG_MAX = 5000;

let db = null; // { version, state, soldLog: [{v,pid,j,n}], soldFrom }

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

function freshState() {
  const st = readJSON(SEED_FILE);
  st.orders = st.orders || [];
  st.customers = st.customers || [];
  st.staff = [];
  st.notes = st.notes || [];
  st.log = st.log || [];
  st.plans = st.plans || [];
  st.nid = st.nid || 1;
  st.cid = st.cid || 1;
  st.pid = st.pid || 100;
  return st;
}

/** Load (or create) the database. Returns a generated admin password if one was made. */
function init() {
  if (fs.existsSync(DATA_FILE)) {
    db = readJSON(DATA_FILE);
  } else {
    db = { version: 1, state: freshState(), soldLog: [], soldFrom: 0 };
  }
  let generated = null;
  if (!db.state.adminPinHash) {
    const pw = process.env.ADMIN_PASSWORD;
    if (pw && pw.length >= 4) {
      db.state.adminPinHash = hashSecret(pw);
    } else {
      generated = randomPassword();
      db.state.adminPinHash = hashSecret(generated);
    }
    persist();
  }
  return { generatedPassword: generated };
}

const getVersion = () => db.version;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Storefront data only. Safe to show anyone. No orders, customers or staff. */
function publicView() {
  const st = db.state;
  return {
    shopv: 1,
    linksv: 1,
    pinv: 2,
    products: st.products || [],
    shop: st.shop || {},
    social: st.social || {},
    icons: st.icons || {},
    iconBg: st.iconBg || {},
    coupons: (st.coupons || []).filter(c => c.on).map(c => ({ code: c.code, pct: c.pct, flat: c.flat, on: true })),
    ship: st.ship,
    low: st.low,
    offers: st.offers || [],
    theme: st.theme || {},
    pubAt: st.pubAt,
    orders: [],
    customers: [],
    notes: [],
    log: [],
    staff: [],
    plans: [],
    nid: 0,
    cid: 0,
    pid: 0,
  };
}

const stripInternal = (arr) => (arr || []).map(x => {
  const y = Object.assign({}, x);
  delete y._v;
  return y;
});

/** Everything the admin app needs. Secrets are removed. */
function adminView() {
  const st = JSON.parse(JSON.stringify(db.state));
  delete st.adminPinHash;
  delete st.pin;
  st.staff = (db.state.staff || []).map(s => ({ id: s.id, name: s.name, role: s.role, pinLen: s.pinLen || 4 }));
  st.orders = stripInternal(st.orders);
  st.customers = stripInternal(st.customers);
  st.notes = stripInternal(st.notes);
  return st;
}

/** The part of an order a customer may see. No phone number, no address. */
function publicOrder(o) {
  return {
    id: o.id,
    cust: o.cust,
    items: o.items,
    sub: o.sub,
    disc: o.disc,
    code: o.code,
    ship: o.ship,
    total: o.total,
    method: o.method,
    ts: o.ts,
    status: o.status,
    payStatus: o.payStatus,
    track: o.track,
    date: o.date,
  };
}

/** Orders matching an order number, or a full phone number. */
function trackOrders(q) {
  const raw = String(q || '').trim();
  if (!raw) return [];
  const up = raw.toUpperCase();
  const digits = raw.replace(/\D/g, '');
  return (db.state.orders || [])
    .filter(o =>
      String(o.id).toUpperCase() === up ||
      (digits.length >= 7 && String(o.phone || '').replace(/\D/g, '') === digits))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 20)
    .map(publicOrder);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** Returns { name, role } for a valid owner or staff password, otherwise null. */
function checkLogin(password) {
  if (verifySecret(password, db.state.adminPinHash)) return { name: 'Owner', role: 'owner' };
  const st = (db.state.staff || []).find(s => verifySecret(password, s.pinHash));
  return st ? { name: st.name, role: st.role } : null;
}

// ---------------------------------------------------------------------------
// Customer orders
// ---------------------------------------------------------------------------

function newOrderId(st, digits) {
  st.nid = (st.nid || 1) + 1;
  if (!digits) return '#00' + (1000 + st.nid);
  const base = '#00' + digits.slice(-6).split('').reverse().join('');
  let id = base;
  let n = 1;
  while (st.orders.some(o => o.id === id)) id = base + '-' + (++n);
  return id;
}

/**
 * Create an order from a customer checkout. Prices, coupon discounts and stock
 * are all computed here; whatever the browser thinks they are is ignored.
 */
function createOrder(input) {
  const st = db.state;
  st.orders = st.orders || [];
  st.customers = st.customers || [];
  st.notes = st.notes || [];

  const name = str(input.name, 80);
  const phone = str(input.phone, 30);
  const address = str(input.address, 300);
  const email = str(input.email, 120);
  const method = str(input.method, 40);
  const coupon = str(input.coupon, 30).toUpperCase();
  const digits = phone.replace(/\D/g, '');

  if (!name) throw new HttpError(400, 'Enter your name');
  if (digits.length < 7) throw new HttpError(400, 'Enter a valid phone number');
  if (!address) throw new HttpError(400, 'Enter your delivery address');
  if (!Array.isArray(input.items) || !input.items.length) throw new HttpError(400, 'Your cart is empty');
  if (input.items.length > 40) throw new HttpError(400, 'Too many items in one order');

  // Resolve every cart line against the real catalogue.
  const lines = input.items.map(it => {
    const id = Number(it && it.id);
    const j = Number(it && it.j);
    const n = Number(it && it.n);
    if (!Number.isInteger(id) || !Number.isInteger(j) || j < 0 || !Number.isInteger(n) || n < 1 || n > 999) {
      throw new HttpError(400, 'Invalid cart item');
    }
    const p = (st.products || []).find(x => x.id === id);
    if (!p) throw new HttpError(400, 'A product in your cart is no longer available');
    const v = (p.v || [])[j];
    if (!v) throw new HttpError(400, 'A product size or colour in your cart is no longer available');
    return { p, j, v, n };
  });

  // Stock check, adding up quantities for the same variant.
  const want = new Map();
  lines.forEach(l => {
    const k = l.p.id + '|' + l.j;
    want.set(k, (want.get(k) || 0) + l.n);
  });
  const checked = new Set();
  for (const l of lines) {
    const k = l.p.id + '|' + l.j;
    if (checked.has(k)) continue;
    checked.add(k);
    if (l.v.q < want.get(k)) {
      throw new HttpError(409, 'Only ' + l.v.q + ' left of ' + l.p.name + ' (' + l.v.c + ', ' + l.v.s + '). Please reduce the quantity.');
    }
  }

  const items = lines.map(l => ({
    pid: l.p.id,
    name: l.p.name,
    s: l.v.s,
    c: l.v.c,
    n: l.n,
    price: Number(l.p.price) || 0,
  }));
  const sub = items.reduce((a, i) => a + i.price * i.n, 0);

  let disc = 0;
  let code = '';
  if (coupon) {
    const c = (st.coupons || []).find(x => String(x.code).toUpperCase() === coupon && x.on);
    if (!c) throw new HttpError(400, 'Coupon not valid');
    disc = c.pct ? Math.round(sub * c.pct / 100) : Math.min(Number(c.flat) || 0, sub);
    code = disc ? coupon : '';
  }

  const ship = Number(st.ship) || 0;
  const version = db.version + 1;

  // Find or create the customer by phone number.
  let cu = st.customers.find(x => String(x.phone) === phone);
  if (!cu) {
    cu = { id: st.cid || 1, name, phone, email, addr: address, _v: version };
    st.cid = (st.cid || 1) + 1;
    st.customers.push(cu);
  } else {
    cu.name = name;
    cu.addr = address;
    if (email) cu.email = email;
  }

  const id = newOrderId(st, digits);

  // Take the stock and record it so that a concurrent admin save can be merged.
  lines.forEach(l => {
    l.v.q -= l.n;
    db.soldLog.push({ v: version, pid: l.p.id, j: l.j, n: l.n });
  });
  while (db.soldLog.length > SOLD_LOG_MAX) {
    const dropped = db.soldLog.shift();
    db.soldFrom = Math.max(db.soldFrom, dropped.v);
  }

  const order = {
    id,
    cid: cu.id,
    cust: name,
    phone,
    addr: address,
    items,
    sub,
    disc,
    code,
    ship,
    total: sub - disc + ship,
    method,
    ts: Date.now(),
    status: 'New',
    payStatus: 'Pending',
    track: '',
    date: new Date().toLocaleDateString(),
    _v: version,
  };
  st.orders.unshift(order);
  st.notes.unshift({ m: 'New order ' + id + ' from ' + name, t: new Date().toLocaleString(), _v: version });

  db.version = version;
  persist();
  return order;
}

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

/** Keep the internal _v marker on entities that already exist, and stamp new ones. */
function reconcile(list, curList, keyFn, newVersion) {
  const curMap = new Map((curList || []).map(x => [keyFn(x), x]));
  return (list || []).map(x => {
    const y = Object.assign({}, x);
    const c = curMap.get(keyFn(x));
    y._v = c ? (c._v || 0) : newVersion;
    return y;
  });
}

/** Staff passwords are hashed. Owner-only. Duplicate passwords are refused. */
function mergeStaff(clientList, curList, adminHash) {
  const out = [];
  const list = Array.isArray(clientList) ? clientList : [];
  for (const s of list) {
    if (!s || !s.name) continue;
    const name = str(s.name, 80);
    const role = str(s.role, 30) || 'staff';
    if (role === 'owner') throw new HttpError(400, 'Owner access cannot be given to staff');
    const cur = s.id != null ? curList.find(x => String(x.id) === String(s.id)) : null;
    let pinHash;
    let pinLen;
    if (typeof s.pin === 'string' && s.pin.length) {
      if (s.pin.length < 4) throw new HttpError(400, 'Password must be at least 4 characters');
      const others = list
        .filter(x => String(x.id) !== String(s.id))
        .map(x => curList.find(c => String(c.id) === String(x.id)))
        .filter(Boolean);
      const clash =
        verifySecret(s.pin, adminHash) ||
        others.some(x => verifySecret(s.pin, x.pinHash)) ||
        out.some(x => verifySecret(s.pin, x.pinHash));
      if (clash) throw new HttpError(400, 'That password is already in use');
      pinHash = hashSecret(s.pin);
      pinLen = s.pin.length;
    } else if (cur) {
      pinHash = cur.pinHash;
      pinLen = cur.pinLen || 4;
    } else {
      throw new HttpError(400, 'Set a password for ' + name);
    }
    out.push({ id: s.id != null ? s.id : Date.now(), name, role, pinHash, pinLen });
  }
  return out;
}

/**
 * Stock when the admin saved from an older copy of the page: start from the
 * admin's number and subtract the sales that happened since that copy.
 */
function mergeStock(clientProducts, curProducts, base) {
  const complete = base >= db.soldFrom;
  const soldSince = (pid, j) => db.soldLog.reduce(
    (a, e) => (e.v > base && e.pid === pid && e.j === j ? a + e.n : a), 0);
  return clientProducts.map(cp => {
    const sp = curProducts.find(p => p.id === cp.id);
    if (!sp) return cp;
    const v = (cp.v || []).map((cv, j) => {
      const sv = (sp.v || [])[j];
      if (!sv || sv.s !== cv.s || sv.c !== cv.c) return cv;
      const q = complete ? Math.max(0, cv.q - soldSince(cp.id, j)) : Math.min(cv.q, sv.q);
      return Object.assign({}, cv, { q });
    });
    return Object.assign({}, cp, { v });
  });
}

/**
 * Apply a full-state save from the admin app.
 *  - Only an owner can change the admin password or the staff list.
 *  - If the save was made from an out-of-date copy, orders placed since then
 *    are kept and stock is recalculated from the sales log.
 */
function applyAdminWrite(incoming, baseVersion, session) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new HttpError(400, 'Invalid data');
  }
  const cur = db.state;
  const base = Number(baseVersion) || 0;
  const stale = base !== db.version;
  const newVersion = db.version + 1;
  const owner = session.role === 'owner';

  const next = JSON.parse(JSON.stringify(incoming));
  let adminPinHash = cur.adminPinHash;
  if (owner && typeof next.pin === 'string' && next.pin.length) {
    if (next.pin.length < 4) throw new HttpError(400, 'Password must be at least 4 characters');
    adminPinHash = hashSecret(next.pin);
  }
  delete next.pin;
  delete next.adminPinHash;

  const staff = owner ? mergeStaff(next.staff, cur.staff || [], adminPinHash) : (cur.staff || []);

  next.products = Array.isArray(next.products) ? next.products : (cur.products || []);
  if (stale) next.products = mergeStock(next.products, cur.products || [], base);

  next.orders = reconcile(next.orders, cur.orders, o => String(o.id), newVersion);
  next.customers = reconcile(next.customers, cur.customers, c => String(c.id), newVersion);
  next.notes = reconcile(next.notes, cur.notes, n => n.m + '|' + n.t, newVersion);

  if (stale) {
    // Orders and notes created on the server after the admin's copy was made.
    const haveOrder = new Set(next.orders.map(o => String(o.id)));
    const haveCust = new Set(next.customers.map(c => String(c.id)));
    const haveNote = new Set(next.notes.map(n => n.m + '|' + n.t));
    const newOrders = (cur.orders || []).filter(o => o._v > base && !haveOrder.has(String(o.id)));
    const newCust = (cur.customers || []).filter(c => c._v > base && !haveCust.has(String(c.id)));
    const newNotes = (cur.notes || []).filter(n => n._v > base && !haveNote.has(n.m + '|' + n.t));
    next.orders = newOrders.concat(next.orders);
    next.customers = newCust.concat(next.customers);
    next.notes = newNotes.concat(next.notes);
  }

  next.nid = Math.max(Number(next.nid) || 1, cur.nid || 1);
  next.cid = Math.max(Number(next.cid) || 1, cur.cid || 1);
  next.pid = Math.max(Number(next.pid) || 100, cur.pid || 100);
  next.staff = staff;
  next.adminPinHash = adminPinHash;

  db.state = next;
  db.version = newVersion;
  persist();
  return { version: db.version, state: adminView(), merged: stale };
}

/**
 * Replace everything with an exported copy of the old browser data.
 * Used by scripts/import-state.js.
 */
function importState(obj) {
  const next = JSON.parse(JSON.stringify(obj));
  if (typeof next.pin === 'string' && next.pin.length >= 4) {
    next.adminPinHash = hashSecret(next.pin);
  } else {
    next.adminPinHash = db.state.adminPinHash;
  }
  delete next.pin;
  next.staff = (obj.staff || [])
    .filter(s => s && typeof s.pin === 'string' && s.pin.length >= 4)
    .map(s => ({ id: s.id, name: s.name, role: s.role, pinHash: hashSecret(s.pin), pinLen: s.pin.length }));
  next.orders = next.orders || [];
  next.customers = next.customers || [];
  next.notes = next.notes || [];
  db.state = next;
  db.version += 1;
  db.soldLog = [];
  db.soldFrom = db.version; // any older copy must not use the sales log
  persist();
  return db.version;
}

module.exports = {
  HttpError,
  init,
  getVersion,
  publicView,
  adminView,
  publicOrder,
  trackOrders,
  checkLogin,
  createOrder,
  applyAdminWrite,
  importState,
};
