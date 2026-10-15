import express from 'express';
import { get, run, insert } from '../db.js';
import { getSettings } from '../settings.js';
import { emit } from '../events.js';
import { upsertContact, createContact, createDeal, bumpScore, fullName } from '../models.js';
import { recordOpen, recordClick, unsubscribeByTracking, isSuppressed } from '../services/mailer.js';
import { enroll } from '../services/sequencer.js';
import { Router, HttpError, verifySig, escapeHtml, isEmail, now } from '../util.js';

// ---------- open / click tracking and unsubscribe (linked from emails) ----------
export const trackingRoutes = Router();

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

trackingRoutes.get('/t/o/:file', (req, res) => {
  const tid = String(req.params.file).replace(/\.gif$/, '');
  try { recordOpen(tid); } catch (err) { console.error('[track:open]', err.message); }
  res.set({ 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', pragma: 'no-cache' });
  res.end(PIXEL);
});

trackingRoutes.get('/t/c/:tid', (req, res) => {
  const { tid } = req.params;
  const url = String(req.query.u || '');
  if (!/^https?:\/\//i.test(url) || !verifySig(`${tid}|${url}`, req.query.s)) {
    return res.status(400).type('html').send(page('Link not valid', '<p>This link is broken or has expired.</p>'));
  }
  try { recordClick(tid, url); } catch (err) { console.error('[track:click]', err.message); }
  res.redirect(302, url);
});

function page(title, body) {
  const company = escapeHtml(getSettings('company').name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${company}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#1d2433;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:32px;max-width:420px;width:100%;text-align:center}
h1{font-size:20px;margin:0 0 12px}p{color:#5b6475;line-height:1.5}button{background:#1f5fd1;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer}
.muted{font-size:13px;color:#8a92a3;margin-top:20px}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>${body}<p class="muted">${company}</p></div></body></html>`;
}

trackingRoutes.get('/u/:tid', (req, res) => {
  const e = get('SELECT to_addr FROM emails WHERE tracking_id = ?', req.params.tid);
  if (!e) return res.status(404).type('html').send(page('Link not found', '<p>We could not find this subscription.</p>'));
  if (isSuppressed(e.to_addr)) return res.type('html').send(page('You are unsubscribed', `<p><b>${escapeHtml(e.to_addr)}</b> will not receive further emails from us.</p>`));
  res.type('html').send(page('Unsubscribe', `<p>Stop emails to <b>${escapeHtml(e.to_addr)}</b>?</p>
    <form method="post" action="/u/${encodeURIComponent(req.params.tid)}"><button type="submit">Unsubscribe</button></form>`));
});

// Handles the confirm button and RFC 8058 one-click unsubscribe from mail clients.
trackingRoutes.post('/u/:tid', express.urlencoded({ extended: false }), (req, res) => {
  const e = unsubscribeByTracking(req.params.tid);
  if (!e) return res.status(404).type('html').send(page('Link not found', '<p>We could not find this subscription.</p>'));
  res.type('html').send(page('You are unsubscribed', `<p><b>${escapeHtml(e.to_addr)}</b> will not receive further emails from us.</p>`));
});

// ---------- public lead capture (website forms, landing pages, n8n, Facebook/Google lead ads via n8n) ----------
export const publicApiRoutes = Router();

publicApiRoutes.use((req, res, next) => {
  res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
publicApiRoutes.use(express.json({ limit: '200kb' }), express.urlencoded({ extended: false, limit: '200kb' }));

const hits = new Map();
function rateLimit(ip) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${ip}|${minute}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) hits.clear();
  if (n > 30) throw new HttpError(429, 'Too many submissions, please try again in a minute');
}

const KNOWN = new Set(['first_name', 'last_name', 'name', 'full_name', 'email', 'phone', 'mobile', 'company', 'company_name', 'title', 'job_title',
  'website', 'city', 'country', 'linkedin_url', '_gotcha']);

publicApiRoutes.post('/forms/:token', (req, res) => {
  rateLimit(req.ip);
  const form = get('SELECT * FROM forms WHERE token = ? AND active = 1', req.params.token);
  if (!form) throw new HttpError(404, 'Form not found');
  const b = req.body || {};
  const wantsHtml = req.is('application/x-www-form-urlencoded');
  const done = (contactId) => {
    if (wantsHtml && form.redirect_url) return res.redirect(303, form.redirect_url);
    if (wantsHtml) return res.type('html').send(page('Thank you!', '<p>We received your details and will be in touch shortly.</p>'));
    return res.json({ ok: true, contact_id: contactId ?? null });
  };
  if (b._gotcha) return done(null); // honeypot: bots fill hidden fields

  let first = b.first_name || null;
  let last = b.last_name || null;
  const fullNameField = b.name || b.full_name;
  if (!first && !last && fullNameField) {
    const [f, ...rest] = String(fullNameField).trim().split(/\s+/);
    first = f;
    last = rest.join(' ') || null;
  }
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  if (email && !isEmail(email)) throw new HttpError(400, 'Please enter a valid email address');
  if (!email && !b.phone && !b.mobile) throw new HttpError(400, 'Please provide an email address or phone number');

  const owner = form.owner_id ? get('SELECT * FROM users WHERE id = ?', form.owner_id) : null;
  const data = {
    first_name: first, last_name: last, email, phone: b.phone || null, mobile: b.mobile || null,
    title: b.title || b.job_title || null, company_name: b.company || b.company_name || null, city: b.city || null, country: b.country || null,
    linkedin_url: b.linkedin_url || null, website: b.website || null,
    source: form.source || `Form: ${form.name}`, status: form.status || 'lead', tags: form.tags, owner_id: form.owner_id,
  };
  const { contact, created } = email ? upsertContact(data, owner) : { contact: createContact(data, owner), created: true };

  const extra = Object.fromEntries(Object.entries(b).filter(([k]) => !KNOWN.has(k)).map(([k, v]) => [k, String(v).slice(0, 2000)]));
  const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n');
  insert('activities', {
    type: 'note', subject: `Form submitted: ${form.name}`, body: lines || null, contact_id: contact.id, user_id: null, done: 1,
    meta: JSON.stringify({ form_id: form.id, fields: extra }), created_at: now(),
  });
  run('UPDATE forms SET submissions = submissions + 1 WHERE id = ?', form.id);
  bumpScore(contact.id, 5);
  if (form.create_deal) {
    createDeal({ title: `${contact.company_name || fullName(contact)} – inbound`, contact_id: contact.id, source: data.source, owner_id: form.owner_id }, owner);
  }
  if (form.sequence_id && email) {
    try { enroll(form.sequence_id, [contact.id], owner); } catch (err) { console.error('[form] enroll', err.message); }
  }
  emit('form.submitted', { form: { id: form.id, name: form.name }, contact, created, fields: extra });
  return done(contact.id);
});
