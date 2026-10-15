import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const now = () => new Date().toISOString();
export const addMs = (ms, from = Date.now()) => new Date(from + ms).toISOString();
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

// express.Router whose handlers may be async: rejected promises go to the error handler.
export function Router() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) =>
      original(path, ...handlers.map((h) => (req, res, next) => {
        try {
          const out = h(req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (err) {
          next(err);
        }
      }));
  }
  return router;
}

export function pick(obj, fields) {
  const out = {};
  if (!obj) return out;
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  return out;
}

export function intOr(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function required(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '');
  if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);
}

// Tags are stored as ",a,b," so a single LIKE '%,tag,%' finds them.
export function tagsIn(v) {
  if (v === undefined) return undefined;
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  return unique.length ? `,${unique.join(',')},` : '';
}
export const tagsOut = (s) => (s ? String(s).split(',').filter(Boolean) : []);

export function jsonOut(s, fallback = {}) {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const isEmail = (s) => typeof s === 'string' && /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(s.trim());

export function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) s = s.split('@').pop();
  try {
    if (!/^https?:\/\//.test(s)) s = `http://${s}`;
    return new URL(s).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (key, s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// Signs short values (tracking links) with the app secret.
export const sign = (s) => hmac(config.secret, s).slice(0, 32);
export function verifySig(s, sig) {
  const expected = Buffer.from(sign(s));
  const given = Buffer.from(String(sig || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Plain text typed into the composer becomes simple HTML; real HTML is left alone.
export function ensureHtml(body) {
  const s = String(body || '');
  if (/<(p|div|br|table|a|span|b|strong|ul|ol|h\d|img)\b/i.test(s)) return s;
  return s.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// ---------- CSV ----------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const str = Array.isArray(v) ? v.join(';') : String(v);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [columns.map((c) => esc(c.label || c.key)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return lines.join('\r\n');
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
