'use strict';

const crypto = require('crypto');

// ---- Passwords / PINs -------------------------------------------------------
// Stored as "scrypt$<saltHex>$<hashHex>". Never store or log the plain value.

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(secret), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomPassword() {
  // 12 URL-safe characters, roughly 72 bits of entropy.
  return crypto.randomBytes(9).toString('base64url');
}

// ---- Sessions ---------------------------------------------------------------

class SessionStore {
  constructor(ttlMs) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  create(data) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.map.set(token, Object.assign({}, data, { exp: Date.now() + this.ttl }));
    return token;
  }
  get(token) {
    if (!token) return null;
    const s = this.map.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) {
      this.map.delete(token);
      return null;
    }
    return s;
  }
  destroy(token) {
    this.map.delete(token);
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i > 0) {
      const key = part.slice(0, i).trim();
      try {
        out[key] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        out[key] = '';
      }
    }
  });
  return out;
}

// ---- Rate limiting (fixed window, per client IP) ----------------------------

function rateLimiter(opts) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  const hits = new Map();
  return function (req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (hits.size > 10000) hits.clear(); // keep memory bounded
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = {
  hashSecret,
  verifySecret,
  randomPassword,
  SessionStore,
  parseCookies,
  rateLimiter,
};
