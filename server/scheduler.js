import { config } from './config.js';
import { all, run } from './db.js';
import { emit, retryFailedDeliveries } from './events.js';
import { activityById } from './models.js';
import { processQueue, recoverInterrupted } from './services/mailer.js';
import { runSequences } from './services/sequencer.js';
import { syncInbox } from './services/imap.js';
import { pruneSessions } from './auth.js';
import { now } from './util.js';

// Fires task.due once per task so n8n can send reminders (Slack, WhatsApp, email…).
function taskReminders() {
  const due = all(`SELECT id FROM activities WHERE type = 'task' AND done = 0 AND reminded = 0
                   AND due_at IS NOT NULL AND due_at <= ? LIMIT 200`, now());
  for (const t of due) {
    run('UPDATE activities SET reminded = 1 WHERE id = ?', t.id);
    emit('task.due', { activity: activityById(t.id) });
  }
}

const jobs = [
  ['sequences', runSequences],
  ['email queue', processQueue],
  ['webhook retries', retryFailedDeliveries],
  ['task reminders', taskReminders],
];

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const [name, fn] of jobs) {
      try { await fn(); } catch (err) { console.error(`[scheduler] ${name}:`, err.message); }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  recoverInterrupted();
  setTimeout(tick, 5_000);
  setInterval(tick, config.schedulerIntervalMs);
  setInterval(() => syncInbox().catch((err) => console.error('[imap]', err.message)), config.imapIntervalMin * 60_000);
  setInterval(pruneSessions, 6 * 3_600_000);
}
