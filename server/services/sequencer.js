import { get, all, run, insert, update } from '../db.js';
import { getSettings } from '../settings.js';
import { emit } from '../events.js';
import { contactById, createActivity } from '../models.js';
import { prepareEmail, deliverEmail, render, buildVars, isSuppressed } from './mailer.js';
import { now, addMs, DAY, HOUR, HttpError } from '../util.js';

export const stepDelayMs = (step) => (Number(step.delay_days) || 0) * DAY + (Number(step.delay_hours) || 0) * HOUR;

export function getSteps(sequenceId) {
  return all('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position, id', sequenceId);
}

export function enroll(sequenceId, contactIds, user) {
  const seq = get('SELECT * FROM sequences WHERE id = ?', sequenceId);
  if (!seq) throw new HttpError(404, 'Sequence not found');
  const steps = getSteps(sequenceId);
  if (!steps.length) throw new HttpError(400, 'This sequence has no steps yet');
  const needsEmail = steps.some((s) => s.type === 'email');
  const result = { enrolled: 0, skipped: [] };
  for (const raw of contactIds || []) {
    const cid = Number(raw);
    const c = get('SELECT id, email, unsubscribed FROM contacts WHERE id = ?', cid);
    if (!c) { result.skipped.push({ id: cid, reason: 'not found' }); continue; }
    if (needsEmail && !c.email) { result.skipped.push({ id: cid, reason: 'no email address' }); continue; }
    if (c.unsubscribed || (c.email && isSuppressed(c.email))) { result.skipped.push({ id: cid, reason: 'unsubscribed' }); continue; }
    const existing = get('SELECT * FROM enrollments WHERE sequence_id = ? AND contact_id = ?', sequenceId, cid);
    if (existing?.status === 'active') { result.skipped.push({ id: cid, reason: 'already enrolled' }); continue; }
    const t = now();
    const fields = {
      status: 'active', current_step: 0, next_run_at: addMs(stepDelayMs(steps[0])), last_error: null,
      enrolled_by: user?.id ?? null, updated_at: t, completed_at: null,
    };
    if (existing) update('enrollments', existing.id, fields);
    else insert('enrollments', { sequence_id: sequenceId, contact_id: cid, created_at: t, ...fields });
    insert('activities', { type: 'system', subject: `Enrolled in sequence "${seq.name}"`, contact_id: cid, user_id: user?.id ?? null, done: 1, created_at: t });
    result.enrolled++;
    emit('sequence.enrolled', { sequence: { id: seq.id, name: seq.name }, contact: contactById(cid) });
  }
  return result;
}

export function inBusinessHours(date = new Date()) {
  const { timezone } = getSettings('company');
  const m = getSettings('mail');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  }
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday').value);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const days = (m.business_days || []).map(Number);
  return days.includes(day) && hour >= Number(m.business_start) && hour < Number(m.business_end);
}

function finish(en) {
  const t = now();
  update('enrollments', en.id, { status: 'completed', completed_at: t, updated_at: t, next_run_at: null });
  emit('sequence.completed', { sequence: { id: en.sequence_id, name: en.sequence_name }, contact: contactById(en.contact_id) });
}

async function runStep(en) {
  const steps = getSteps(en.sequence_id);
  const step = steps[en.current_step];
  if (!step) return finish(en);
  const contact = contactById(en.contact_id);
  if (!contact) return update('enrollments', en.id, { status: 'stopped', last_error: 'Contact deleted', updated_at: now() });
  const user = en.enrolled_by ? get('SELECT * FROM users WHERE id = ?', en.enrolled_by) : null;
  try {
    if (step.type === 'email') {
      let subject = step.subject;
      let body = step.body;
      if (step.template_id) {
        const tpl = get('SELECT * FROM email_templates WHERE id = ?', step.template_id);
        subject = subject || tpl?.subject;
        body = body || tpl?.body;
      }
      const prev = get("SELECT subject, message_id FROM emails WHERE enrollment_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1", en.id);
      if (!subject && prev) subject = /^re:/i.test(prev.subject) ? prev.subject : `Re: ${prev.subject}`;
      const id = prepareEmail({
        contactId: en.contact_id, subject, body, user, enrollmentId: en.id, templateId: step.template_id || null, bulk: true,
        inReplyTo: prev && /^re:/i.test(subject || '') ? prev.message_id : null,
      });
      const sent = await deliverEmail(id);
      if (sent.status === 'failed') throw new Error(sent.error || 'Send failed');
    } else if (step.type === 'task') {
      const vars = buildVars(contact, user);
      createActivity({
        type: 'task',
        subject: render(step.task_title || 'Follow up', vars),
        body: step.body ? render(step.body, vars) : null,
        contact_id: en.contact_id,
        assigned_to: contact.owner_id || en.enrolled_by,
        due_at: now(),
        meta: { sequence_id: en.sequence_id, enrollment_id: en.id },
      }, user);
    }
    const next = steps[en.current_step + 1];
    if (next) {
      update('enrollments', en.id, { current_step: en.current_step + 1, next_run_at: addMs(stepDelayMs(next)), updated_at: now(), last_error: null });
    } else {
      finish(en);
    }
  } catch (err) {
    const status = err.status === 409 ? 'unsubscribed' : 'failed';
    update('enrollments', en.id, { status, last_error: String(err.message).slice(0, 500), updated_at: now() });
  }
}

let running = false;
export async function runSequences() {
  if (running) return;
  running = true;
  try {
    const due = all(`SELECT e.*, s.business_hours, s.name AS sequence_name
                     FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
                     WHERE e.status = 'active' AND s.status = 'active' AND e.next_run_at <= ?
                     ORDER BY e.next_run_at LIMIT 100`, now());
    if (!due.length) return;
    const open = inBusinessHours();
    for (const en of due) {
      if (en.business_hours && !open) continue;
      await runStep(en);
    }
  } finally {
    running = false;
  }
}

export function stopOnReply(contactId) {
  return run(`UPDATE enrollments SET status = 'replied', updated_at = ?
              WHERE contact_id = ? AND status = 'active'
                AND sequence_id IN (SELECT id FROM sequences WHERE stop_on_reply = 1)`, now(), contactId).changes;
}
