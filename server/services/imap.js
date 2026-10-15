import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { get, run, insert } from '../db.js';
import { getSettings, getState, setState } from '../settings.js';
import { emit, logIntegration } from '../events.js';
import { contactById, bumpScore } from '../models.js';
import { stopOnReply } from './sequencer.js';
import { suppress, emailSummary } from './mailer.js';
import { now, addMs, HttpError } from '../util.js';

const makeClient = (s) => new ImapFlow({
  host: s.host,
  port: Number(s.port) || 993,
  secure: !!s.secure,
  auth: { user: s.user, pass: s.pass },
  logger: false,
  socketTimeout: 60_000,
});

export async function testImap() {
  const s = getSettings('imap');
  if (!s.host || !s.user || !s.pass) throw new HttpError(400, 'Fill in IMAP host, username and password first');
  const client = makeClient(s);
  try {
    await client.connect();
    const status = await client.status(s.mailbox || 'INBOX', { messages: true, unseen: true });
    await client.logout();
    return { ok: true, messages: status.messages, unseen: status.unseen };
  } catch (err) {
    try { client.close(); } catch { /* ignore */ }
    throw new HttpError(502, `IMAP connection failed: ${err.responseText || err.message}`);
  }
}

async function parseSource(client, uid, size) {
  if ((size || 0) > 2 * 1024 * 1024) return null;
  const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
  return full?.source ? simpleParser(full.source) : null;
}

async function handleBounce(client, msg, result) {
  const parsed = await parseSource(client, msg.uid, msg.size);
  const text = `${parsed?.text || ''}\n${parsed?.headers?.get('x-failed-recipients') || ''}`;
  const candidates = [...new Set((text.match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((s) => s.toLowerCase()))];
  for (const addr of candidates) {
    const sent = get(`SELECT * FROM emails WHERE to_addr = ? AND direction = 'out' AND status = 'sent' AND sent_at > ?
                      ORDER BY id DESC LIMIT 1`, addr, addMs(-7 * 86_400_000));
    if (!sent) continue;
    run('UPDATE emails SET bounced = 1 WHERE id = ?', sent.id);
    const ids = suppress(addr, 'bounce');
    result.bounces++;
    emit('email.bounced', { email: emailSummary(sent), address: addr, contact: ids[0] ? contactById(ids[0]) : null });
    return;
  }
}

async function handleMessage(client, msg, result) {
  const env = msg.envelope || {};
  const from = String(env.from?.[0]?.address || '').toLowerCase();
  const messageId = env.messageId || null;
  if (messageId && get("SELECT id FROM emails WHERE message_id = ? AND direction = 'in'", messageId)) return;

  const isBounce = /mailer-daemon|postmaster/i.test(from)
    || /undeliver|delivery status notification|returned mail|failure notice|delivery has failed|delivery failed/i.test(env.subject || '');
  if (isBounce) return handleBounce(client, msg, result);

  let original = env.inReplyTo ? get("SELECT * FROM emails WHERE message_id = ? AND direction = 'out'", env.inReplyTo) : null;
  const contact = original?.contact_id
    ? get('SELECT * FROM contacts WHERE id = ?', original.contact_id)
    : (from ? get('SELECT * FROM contacts WHERE email = ?', from) : null);
  if (!contact) return; // not from a CRM contact

  const parsed = await parseSource(client, msg.uid, msg.size);
  const date = env.date ? new Date(env.date).toISOString() : now();
  insert('emails', {
    direction: 'in',
    status: 'received',
    contact_id: contact.id,
    from_addr: from,
    to_addr: env.to?.[0]?.address || null,
    subject: env.subject || '(no subject)',
    body: parsed?.html || parsed?.textAsHtml || '',
    text_body: parsed?.text ? parsed.text.slice(0, 20_000) : null,
    message_id: messageId,
    in_reply_to: env.inReplyTo || null,
    sent_at: date,
    created_at: date,
  });
  if (!original) {
    original = get(`SELECT * FROM emails WHERE contact_id = ? AND direction = 'out' AND status = 'sent' AND replied_at IS NULL
                    ORDER BY id DESC LIMIT 1`, contact.id);
  }
  if (original) run('UPDATE emails SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', date, original.id);
  run('UPDATE contacts SET last_contacted_at = ? WHERE id = ?', date, contact.id);
  bumpScore(contact.id, 10);
  const stopped = stopOnReply(contact.id);
  result.replies++;
  emit('email.replied', {
    contact: contactById(contact.id),
    reply: { from, subject: env.subject, date, snippet: String(parsed?.text || '').slice(0, 500) },
    original: emailSummary(original),
    sequences_stopped: stopped,
  });
}

let syncing = false;
export async function syncInbox({ force = false } = {}) {
  const s = getSettings('imap');
  if (!force && !s.enabled) return { skipped: 'disabled' };
  if (!s.host || !s.user || !s.pass) {
    if (force) throw new HttpError(400, 'IMAP is not configured');
    return { skipped: 'not configured' };
  }
  if (syncing) return { skipped: 'already running' };
  syncing = true;
  const client = makeClient(s);
  const result = { scanned: 0, replies: 0, bounces: 0 };
  try {
    await client.connect();
    const lock = await client.getMailboxLock(s.mailbox || 'INBOX');
    try {
      const mb = client.mailbox;
      const state = getState('imap', {});
      let lastUid = Number(state.lastUid) || 0;
      // First sync (or mailbox reset): only look at the latest ~100 messages.
      if (String(state.uidValidity) !== String(mb.uidValidity)) lastUid = Math.max(0, Number(mb.uidNext) - 101);
      let maxUid = lastUid;
      if (Number(mb.uidNext) - 1 > lastUid) {
        const batch = [];
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, size: true }, { uid: true })) {
          if (msg.uid <= lastUid) continue;
          batch.push(msg);
          maxUid = Math.max(maxUid, msg.uid);
        }
        for (const msg of batch) {
          result.scanned++;
          try { await handleMessage(client, msg, result); } catch (err) { console.error('[imap] message', msg.uid, err.message); }
        }
      }
      setState('imap', { uidValidity: String(mb.uidValidity), lastUid: maxUid, lastSyncAt: now() });
    } finally {
      lock.release();
    }
    await client.logout();
    logIntegration('imap', 'sync', 'ok', JSON.stringify(result));
    return result;
  } catch (err) {
    try { client.close(); } catch { /* ignore */ }
    logIntegration('imap', 'sync', 'error', err.responseText || err.message);
    throw new HttpError(502, `IMAP sync failed: ${err.responseText || err.message}`);
  } finally {
    syncing = false;
  }
}
