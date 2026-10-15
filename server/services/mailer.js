import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { get, all, run, insert } from '../db.js';
import { getSettings } from '../settings.js';
import { emit } from '../events.js';
import { contactById, bumpScore, fullName } from '../models.js';
import { HttpError, now, escapeHtml, ensureHtml, htmlToText, randomToken, sign, isEmail } from '../util.js';

let cached = { key: null, transport: null };

function transportFor(smtp) {
  if (smtp.dry_run) return nodemailer.createTransport({ jsonTransport: true });
  if (!smtp.host) throw new HttpError(400, 'Email is not set up yet. Add your SMTP server under Integrations → Email.');
  const key = JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.user, smtp.pass]);
  if (cached.key !== key) {
    try { cached.transport?.close(); } catch { /* ignore */ }
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port) || 587,
        secure: !!smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        pool: true,
        maxConnections: 3,
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
      }),
    };
  }
  return cached.transport;
}

export async function verifySmtp() {
  const smtp = getSettings('smtp');
  if (smtp.dry_run) return { ok: true, dry_run: true };
  await transportFor(smtp).verify();
  return { ok: true };
}

export function isSuppressed(email) {
  return !!get('SELECT email FROM suppressions WHERE email = ?', String(email || '').trim().toLowerCase());
}

// ---------- templating ----------
export const TEMPLATE_VARIABLES = [
  'first_name', 'last_name', 'full_name', 'email', 'title', 'phone', 'city', 'country', 'company',
  'sender_name', 'sender_email', 'signature', 'my_company', 'my_website', 'my_address', 'my_phone', 'unsubscribe_url',
];

export function buildVars(contact, user) {
  const company = getSettings('company');
  const smtp = getSettings('smtp');
  return {
    first_name: contact?.first_name || '',
    last_name: contact?.last_name || '',
    full_name: contact ? fullName(contact) : '',
    email: contact?.email || '',
    title: contact?.title || '',
    phone: contact?.phone || contact?.mobile || '',
    city: contact?.city || '',
    country: contact?.country || '',
    company: contact?.company_name || '',
    company_name: contact?.company_name || '',
    sender_name: user?.name || smtp.from_name || company.name,
    sender_email: smtp.from_email || user?.email || '',
    signature: user?.signature || '',
    my_company: company.name,
    my_website: company.website,
    my_address: company.address,
    my_address_line: company.address ? ` · ${company.address}` : '',
    my_phone: company.phone,
  };
}

const VAR_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*(?:\|([^}]*))?\}\}/gi;
const RAW_HTML_VARS = new Set(['signature']);

export function render(template, vars, { html = false } = {}) {
  return String(template || '').replace(VAR_RE, (m, key, fallback) => {
    const k = key.toLowerCase();
    let v = vars[k];
    if (v === undefined || v === null || v === '') v = fallback !== undefined ? fallback.trim() : '';
    return html && !RAW_HTML_VARS.has(k) ? escapeHtml(v) : String(v);
  });
}

const decodeAmp = (s) => s.replace(/&amp;/g, '&');

function addTracking(html, trackingId, base) {
  const linked = html.replace(/<a\s([^>]*?)href\s*=\s*(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, rawUrl) => {
    const url = decodeAmp(rawUrl);
    if (url.startsWith(`${base}/u/`)) return m; // never wrap the unsubscribe link
    const href = `${base}/t/c/${trackingId}?u=${encodeURIComponent(url)}&s=${sign(`${trackingId}|${url}`)}`;
    return `<a ${pre}href=${q}${href.replace(/&/g, '&amp;')}${q}`;
  });
  const pixel = `<img src="${base}/t/o/${trackingId}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  return /<\/body>/i.test(linked) ? linked.replace(/<\/body>/i, `${pixel}</body>`) : linked + pixel;
}

// ---------- compose & send ----------
export function prepareEmail({
  contactId, to, subject, body, user, dealId, campaignId, enrollmentId, templateId,
  cc, bcc, inReplyTo, bulk = false, force = false,
}) {
  const contact = contactId ? contactById(contactId) : null;
  if (contactId && !contact) throw new HttpError(404, 'Contact not found');
  const toAddr = String(to || contact?.email || '').trim().toLowerCase();
  if (!isEmail(toAddr)) throw new HttpError(400, contact ? `${contact.full_name} has no valid email address` : 'A valid recipient email is required');
  if (!force && (isSuppressed(toAddr) || contact?.unsubscribed)) {
    throw new HttpError(409, `${toAddr} has unsubscribed or bounced, so emails to it are blocked.`);
  }
  if (templateId) {
    const tpl = get('SELECT * FROM email_templates WHERE id = ?', templateId);
    if (!tpl) throw new HttpError(400, 'Template not found');
    subject = subject || tpl.subject;
    body = body || tpl.body;
  }
  if (!subject || !String(subject).trim()) throw new HttpError(400, 'Subject is required');
  if (!body || !String(body).trim()) throw new HttpError(400, 'Email body is required');

  const trackingId = randomToken(16);
  const base = config.baseUrl;
  const vars = { ...buildVars(contact, user), unsubscribe_url: `${base}/u/${trackingId}` };
  const mailCfg = getSettings('mail');
  let html = render(ensureHtml(body), vars, { html: true });
  if (bulk && mailCfg.footer && !/unsubscribe_url/i.test(body)) html += `\n${render(mailCfg.footer, vars, { html: true })}`;
  const text = htmlToText(html);
  if (mailCfg.tracking) html = addTracking(html, trackingId, base);
  const smtp = getSettings('smtp');

  return insert('emails', {
    direction: 'out',
    status: 'queued',
    contact_id: contact?.id ?? null,
    deal_id: dealId || null,
    user_id: user?.id ?? null,
    campaign_id: campaignId || null,
    enrollment_id: enrollmentId || null,
    template_id: templateId || null,
    from_addr: smtp.from_email || smtp.user || null,
    to_addr: toAddr,
    cc: cc || null,
    bcc: bcc || null,
    subject: render(subject, vars),
    body: html,
    text_body: text,
    in_reply_to: inReplyTo || null,
    tracking_id: trackingId,
    created_at: now(),
  });
}

export const emailSummary = (e) => e && ({
  id: e.id, direction: e.direction, status: e.status, subject: e.subject, to_addr: e.to_addr, from_addr: e.from_addr,
  contact_id: e.contact_id, deal_id: e.deal_id, campaign_id: e.campaign_id, enrollment_id: e.enrollment_id,
  sent_at: e.sent_at, opened_at: e.opened_at, open_count: e.open_count, clicked_at: e.clicked_at,
  click_count: e.click_count, replied_at: e.replied_at, error: e.error, message_id: e.message_id,
});

export async function deliverEmail(id) {
  const e = get('SELECT * FROM emails WHERE id = ?', id);
  if (!e || !['queued', 'failed'].includes(e.status)) return e;
  run("UPDATE emails SET status = 'sending' WHERE id = ?", id);
  const smtp = getSettings('smtp');
  const company = getSettings('company');
  try {
    const transport = transportFor(smtp);
    const fromEmail = smtp.from_email || smtp.user;
    if (!fromEmail && !smtp.dry_run) throw new Error('Set a "From email" under Integrations → Email');
    const user = e.user_id ? get('SELECT name FROM users WHERE id = ?', e.user_id) : null;
    const unsubscribeUrl = `${config.baseUrl}/u/${e.tracking_id}`;
    const info = await transport.sendMail({
      from: { name: smtp.from_name || user?.name || company.name, address: fromEmail || 'dry-run@localhost' },
      to: e.to_addr,
      cc: e.cc || undefined,
      bcc: e.bcc || undefined,
      replyTo: smtp.reply_to || undefined,
      subject: e.subject,
      html: e.body,
      text: e.text_body,
      inReplyTo: e.in_reply_to || undefined,
      references: e.in_reply_to || undefined,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-CRM-Email-Id': String(e.id),
      },
    });
    const t = now();
    run("UPDATE emails SET status = 'sent', sent_at = ?, message_id = ?, error = ? WHERE id = ?",
      t, info.messageId || null, smtp.dry_run ? 'Dry run: not actually delivered' : null, id);
    if (e.contact_id) {
      run("UPDATE contacts SET last_contacted_at = ?, status = CASE WHEN status = 'lead' THEN 'contacted' ELSE status END WHERE id = ?", t, e.contact_id);
    }
    const sent = get('SELECT * FROM emails WHERE id = ?', id);
    emit('email.sent', { email: emailSummary(sent), contact: e.contact_id ? contactById(e.contact_id) : null, dry_run: !!smtp.dry_run });
    return sent;
  } catch (err) {
    run("UPDATE emails SET status = 'failed', error = ? WHERE id = ?", String(err.message || err).slice(0, 500), id);
    const failed = get('SELECT * FROM emails WHERE id = ?', id);
    emit('email.failed', { email: emailSummary(failed), error: failed.error });
    return failed;
  }
}

export async function sendEmail(opts) {
  return deliverEmail(prepareEmail(opts));
}

let processing = false;
export async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const rate = Math.max(1, Number(getSettings('mail').rate_per_minute) || 20);
    const rows = all("SELECT id FROM emails WHERE status = 'queued' AND direction = 'out' ORDER BY id LIMIT ?", rate);
    for (const r of rows) await deliverEmail(r.id);
    run(`UPDATE campaigns SET status = 'sent'
         WHERE status = 'sending' AND NOT EXISTS (SELECT 1 FROM emails WHERE campaign_id = campaigns.id AND status IN ('queued', 'sending'))`);
  } finally {
    processing = false;
  }
}

// An email left in 'sending' means the process stopped mid-send; never resend it blindly.
export function recoverInterrupted() {
  run("UPDATE emails SET status = 'failed', error = 'Interrupted by a restart; check before retrying' WHERE status = 'sending'");
}

// ---------- tracking ----------
export function recordOpen(trackingId) {
  const e = get('SELECT * FROM emails WHERE tracking_id = ?', trackingId);
  if (!e) return;
  const first = !e.opened_at;
  run('UPDATE emails SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', now(), e.id);
  if (first) {
    bumpScore(e.contact_id, 1);
    emit('email.opened', { email: emailSummary(get('SELECT * FROM emails WHERE id = ?', e.id)), contact: e.contact_id ? contactById(e.contact_id) : null });
  }
}

export function recordClick(trackingId, url) {
  const e = get('SELECT * FROM emails WHERE tracking_id = ?', trackingId);
  if (!e) return;
  const first = !e.clicked_at;
  run('UPDATE emails SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?), opened_at = COALESCE(opened_at, ?) WHERE id = ?', now(), now(), e.id);
  if (first) {
    bumpScore(e.contact_id, 3);
    emit('email.clicked', { email: emailSummary(get('SELECT * FROM emails WHERE id = ?', e.id)), url, contact: e.contact_id ? contactById(e.contact_id) : null });
  }
}

export function suppress(email, reason) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return;
  run('INSERT OR IGNORE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)', addr, reason, now());
  const contacts = all('SELECT id FROM contacts WHERE email = ?', addr);
  for (const c of contacts) {
    run('UPDATE contacts SET unsubscribed = 1, email_status = COALESCE(?, email_status), updated_at = ? WHERE id = ?', reason === 'bounce' ? 'bounced' : null, now(), c.id);
    run("UPDATE enrollments SET status = ?, updated_at = ? WHERE contact_id = ? AND status = 'active'", reason === 'bounce' ? 'bounced' : 'unsubscribed', now(), c.id);
    insert('activities', {
      type: 'system', subject: reason === 'bounce' ? `Email bounced: ${addr}` : `Unsubscribed from emails (${addr})`,
      contact_id: c.id, done: 1, created_at: now(),
    });
  }
  return contacts.map((c) => c.id);
}

export function unsubscribeByTracking(trackingId) {
  const e = get('SELECT * FROM emails WHERE tracking_id = ?', trackingId);
  if (!e) return null;
  if (isSuppressed(e.to_addr)) return e;
  const ids = suppress(e.to_addr, 'unsubscribe');
  emit('contact.unsubscribed', { email: e.to_addr, contact: ids[0] ? contactById(ids[0]) : null, via_email_id: e.id });
  return e;
}
