import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now } from './util.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// node:sqlite only binds null/number/bigint/string/Buffer.
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    if (cache.size > 500) cache.clear();
    cache.set(sql, s);
  }
  return s;
}

const plain = (row) => (row ? { ...row } : row);
export const all = (sql, ...params) => stmt(sql).all(...params.map(norm)).map(plain);
export const get = (sql, ...params) => plain(stmt(sql).get(...params.map(norm)));
export const run = (sql, ...params) => stmt(sql).run(...params.map(norm));

// Table and column names always come from code-side whitelists, never from request input.
export function insert(table, data) {
  const cols = Object.keys(data);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return Number(run(sql, ...cols.map((c) => data[c])).lastInsertRowid);
}

export function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return 0;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  return run(sql, ...cols.map((c) => data[c]), id).changes;
}

let depth = 0;
export function tx(fn) {
  const sp = `sp_${depth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (err) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw err;
  } finally {
    depth--;
  }
}

// Builds a paginated list query. `where` holds SQL fragments with `?` placeholders matched by `params`.
export function listQuery({ select, from, where = [], params = [], search, searchCols = [], sort, sorts = {}, defaultSort, limit, offset, groupBy = '' }) {
  const w = [...where];
  const p = [...params];
  if (search && searchCols.length) {
    const terms = String(search).trim().split(/\s+/).slice(0, 5);
    for (const t of terms) {
      w.push(`(${searchCols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < searchCols.length; i++) p.push(`%${t}%`);
    }
  }
  const whereSql = w.length ? `WHERE ${w.join(' AND ')}` : '';
  let orderSql = defaultSort;
  if (sort) {
    const desc = String(sort).startsWith('-');
    const key = desc ? String(sort).slice(1) : String(sort);
    if (sorts[key]) orderSql = `${sorts[key]} ${desc ? 'DESC' : 'ASC'}`;
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = all(`SELECT ${select} FROM ${from} ${whereSql} ${groupBy} ORDER BY ${orderSql} LIMIT ${lim} OFFSET ${off}`, ...p);
  const total = groupBy
    ? get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from} ${whereSql} ${groupBy})`, ...p).n
    : get(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`, ...p).n;
  return { rows, total, limit: lim, offset: off };
}

// ---------- schema ----------
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'sales',
    active INTEGER NOT NULL DEFAULT 1,
    signature TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT COLLATE NOCASE,
    website TEXT,
    industry TEXT,
    employees INTEGER,
    annual_revenue REAL,
    phone TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    linkedin_url TEXT,
    description TEXT,
    tags TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    apollo_id TEXT,
    custom TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_companies_domain ON companies(domain);
  CREATE INDEX idx_companies_apollo ON companies(apollo_id);

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    email TEXT COLLATE NOCASE,
    phone TEXT,
    mobile TEXT,
    title TEXT,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'lead',
    source TEXT,
    linkedin_url TEXT,
    website TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    timezone TEXT,
    tags TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    email_status TEXT,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    apollo_id TEXT,
    notes TEXT,
    last_contacted_at TEXT,
    custom TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_contacts_email ON contacts(email);
  CREATE INDEX idx_contacts_company ON contacts(company_id);
  CREATE INDEX idx_contacts_apollo ON contacts(apollo_id);
  CREATE INDEX idx_contacts_status ON contacts(status);

  CREATE TABLE stages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    probability INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE deals (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    currency TEXT,
    stage_id INTEGER REFERENCES stages(id),
    status TEXT NOT NULL DEFAULT 'open',
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expected_close TEXT,
    probability INTEGER,
    source TEXT,
    lost_reason TEXT,
    description TEXT,
    tags TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0,
    closed_at TEXT,
    stage_changed_at TEXT,
    custom TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_deals_stage ON deals(stage_id);
  CREATE INDEX idx_deals_contact ON deals(contact_id);
  CREATE INDEX idx_deals_company ON deals(company_id);

  CREATE TABLE activities (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_at TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    reminded INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_act_contact ON activities(contact_id);
  CREATE INDEX idx_act_company ON activities(company_id);
  CREATE INDEX idx_act_deal ON activities(deal_id);
  CREATE INDEX idx_act_due ON activities(type, done, due_at);

  CREATE TABLE email_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    category TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    filter TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    total INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );

  CREATE TABLE sequences (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    stop_on_reply INTEGER NOT NULL DEFAULT 1,
    business_hours INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sequence_steps (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'email',
    delay_days INTEGER NOT NULL DEFAULT 0,
    delay_hours INTEGER NOT NULL DEFAULT 0,
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    subject TEXT,
    body TEXT,
    task_title TEXT
  );
  CREATE TABLE enrollments (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    current_step INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT,
    enrolled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (sequence_id, contact_id)
  );
  CREATE INDEX idx_enroll_due ON enrollments(status, next_run_at);

  CREATE TABLE emails (
    id INTEGER PRIMARY KEY,
    direction TEXT NOT NULL DEFAULT 'out',
    status TEXT NOT NULL DEFAULT 'queued',
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL,
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    from_addr TEXT,
    to_addr TEXT,
    cc TEXT,
    bcc TEXT,
    subject TEXT,
    body TEXT,
    text_body TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    tracking_id TEXT UNIQUE,
    error TEXT,
    sent_at TEXT,
    opened_at TEXT,
    open_count INTEGER NOT NULL DEFAULT 0,
    clicked_at TEXT,
    click_count INTEGER NOT NULL DEFAULT 0,
    replied_at TEXT,
    bounced INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_emails_contact ON emails(contact_id);
  CREATE INDEX idx_emails_status ON emails(status);
  CREATE INDEX idx_emails_msgid ON emails(message_id);
  CREATE INDEX idx_emails_campaign ON emails(campaign_id);

  CREATE TABLE suppressions (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    reason TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '*',
    secret TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    last_status INTEGER,
    last_delivery_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status_code INTEGER,
    response TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    success INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_deliveries_retry ON webhook_deliveries(success, next_retry_at);

  CREATE TABLE forms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    tags TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'lead',
    source TEXT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sequence_id INTEGER REFERENCES sequences(id) ON DELETE SET NULL,
    redirect_url TEXT,
    create_deal INTEGER NOT NULL DEFAULT 0,
    submissions INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE integration_log (
    id INTEGER PRIMARY KEY,
    integration TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    credits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  `,
];

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function seedDefaults() {
  if (get('SELECT COUNT(*) AS n FROM stages').n === 0) {
    const stages = [
      ['New lead', 10, 'open'],
      ['Qualified', 25, 'open'],
      ['Meeting booked', 40, 'open'],
      ['Proposal sent', 60, 'open'],
      ['Negotiation', 80, 'open'],
      ['Won', 100, 'won'],
      ['Lost', 0, 'lost'],
    ];
    stages.forEach(([name, probability, kind], i) => insert('stages', { name, probability, kind, position: i }));
  }

  if (get('SELECT COUNT(*) AS n FROM email_templates').n === 0) {
    const t = now();
    const templates = [
      {
        name: 'Cold intro',
        category: 'Outreach',
        subject: 'Quick idea for {{company|your team}}',
        body: `<p>Hi {{first_name|there}},</p>
<p>I'm {{sender_name}} from {{my_company}}. We help teams like {{company|yours}} win more business with less manual work.</p>
<p>Would you be open to a 15-minute call next week to see if it's a fit?</p>
<p>Best,<br>{{sender_name}}<br>{{my_company}}</p>`,
      },
      {
        name: 'Follow-up 1',
        category: 'Outreach',
        subject: 'Re: Quick idea for {{company|your team}}',
        body: `<p>Hi {{first_name|there}},</p>
<p>Just bringing this back to the top of your inbox. Is improving this a priority for {{company|you}} this quarter?</p>
<p>Thanks,<br>{{sender_name}}</p>`,
      },
      {
        name: 'Break-up',
        category: 'Outreach',
        subject: 'Should I close your file?',
        body: `<p>Hi {{first_name|there}},</p>
<p>I haven't heard back, so I'll assume the timing isn't right. If anything changes, just reply to this email and I'll pick it up.</p>
<p>All the best,<br>{{sender_name}}</p>`,
      },
      {
        name: 'Meeting confirmation',
        category: 'Sales',
        subject: 'Confirming our call',
        body: `<p>Hi {{first_name|there}},</p>
<p>Thanks for your time. This is to confirm our call. I'll send over an agenda beforehand.</p>
<p>Regards,<br>{{sender_name}}<br>{{my_company}}</p>`,
      },
      {
        name: 'Proposal follow-up',
        category: 'Sales',
        subject: 'Your proposal from {{my_company}}',
        body: `<p>Hi {{first_name|there}},</p>
<p>I wanted to check whether you had a chance to review the proposal. Happy to walk through any questions.</p>
<p>Best,<br>{{sender_name}}</p>`,
      },
    ];
    for (const tpl of templates) insert('email_templates', { ...tpl, created_at: t, updated_at: t });

    const seqId = insert('sequences', {
      name: 'Cold outreach (4 steps)',
      description: 'Intro email, follow-up after 3 days, call task 2 days later, break-up email 3 days after that. Stops when the contact replies.',
      status: 'active',
      stop_on_reply: 1,
      business_hours: 1,
      created_at: t,
      updated_at: t,
    });
    const tplId = (name) => get('SELECT id FROM email_templates WHERE name = ?', name).id;
    insert('sequence_steps', { sequence_id: seqId, position: 0, type: 'email', delay_days: 0, template_id: tplId('Cold intro') });
    insert('sequence_steps', { sequence_id: seqId, position: 1, type: 'email', delay_days: 3, template_id: tplId('Follow-up 1') });
    insert('sequence_steps', { sequence_id: seqId, position: 2, type: 'task', delay_days: 2, task_title: 'Call {{full_name}} at {{company}}' });
    insert('sequence_steps', { sequence_id: seqId, position: 3, type: 'email', delay_days: 3, template_id: tplId('Break-up') });
  }
}

migrate();
seedDefaults();
