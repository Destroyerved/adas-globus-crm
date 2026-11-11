import { type SeedTarget } from './seed.js';

/**
 * The large synthetic data set for performance work (PRD 12.2; AGENTS.md section 6):
 * `pnpm db:seed --size=large` loads 20,000 companies, 60,000 contacts and 300,000 activities,
 * plus leads, deals, tasks and tags in proportion, on top of the small baseline.
 *
 * - Everything is invented. Names are built from the name parts below, domains end in
 *   example.com or example.ca, and phone numbers use the reserved 555-01xx range.
 * - Rows are generated inside PostgreSQL with generate_series, in chunks, so nothing large
 *   crosses the wire. Every value is a pure function of the row number: the same command
 *   always builds the same data, and running it again adds nothing (ON CONFLICT DO NOTHING).
 * - Three in four records are U.S. and one in four Canadian, owned by the seeded people of
 *   the matching team, so own, team and all scopes each see a realistic share.
 */

export interface LargeSeedSize {
  companies: number;
  contacts: number;
  activities: number;
  leads: number;
  deals: number;
  tasks: number;
}

/** PRD 12.2's design size. 500 of the deals are open in the default pipeline. */
export const LARGE_SEED_SIZE: LargeSeedSize = {
  companies: 20_000,
  contacts: 60_000,
  activities: 300_000,
  leads: 12_000,
  deals: 2_500,
  tasks: 6_000,
};

const CHUNK = 10_000;

const FIRST = [
  'Avery',
  'Blake',
  'Carmen',
  'Dana',
  'Elliot',
  'Farah',
  'Gideon',
  'Harper',
  'Imani',
  'Jonah',
  'Keira',
  'Landon',
  'Maren',
  'Nadia',
  'Owen',
  'Priya',
  'Quentin',
  'Rosa',
  'Soren',
  'Tessa',
  'Uma',
  'Victor',
  'Wren',
  'Xavier',
  'Yara',
  'Zane',
  'Aiden',
  'Bianca',
  'Callum',
  'Delia',
  'Emil',
  'Freya',
  'Grant',
  'Hana',
  'Idris',
  'Jules',
  'Kai',
  'Lena',
  'Milo',
  'Noor',
  'Oscar',
] as const;

/**
 * Surnames are built from three parts (20 x 20 x 10), giving 4,000 invented names such as
 * "Haranwell" or "Belolford". A CRM's real surnames are that varied; a short list would make
 * every name search match thousands of rows and say nothing about search speed.
 */
const SURNAME_START = [
  'Har',
  'Bel',
  'Cor',
  'Dun',
  'Ever',
  'Fen',
  'Gar',
  'Hol',
  'Iver',
  'Jar',
  'Kes',
  'Lan',
  'Mer',
  'Nor',
  'Oak',
  'Pem',
  'Quin',
  'Ram',
  'San',
  'Thack',
] as const;
const SURNAME_MIDDLE = [
  'a',
  'e',
  'i',
  'o',
  'u',
  'ar',
  'er',
  'or',
  'an',
  'en',
  'in',
  'on',
  'al',
  'el',
  'il',
  'ol',
  'as',
  'es',
  'is',
  'os',
] as const;
const SURNAME_END = [
  'well',
  'wick',
  'ford',
  'ton',
  'ley',
  'man',
  'son',
  'field',
  'wood',
  'worth',
] as const;
const SURNAMES = SURNAME_START.length * SURNAME_MIDDLE.length * SURNAME_END.length;

const FIRM_SUFFIX = [
  'CPA Group',
  'Tax Partners',
  '& Associates CPA',
  'Accounting LLP',
  'Chartered Accountants',
  'Advisory CPA',
  'Tax & Audit',
  'CPA Professional Corp',
] as const;

const US_STATE = ['IL', 'TX', 'FL', 'NY', 'CA', 'WA', 'GA', 'OH', 'PA', 'MA', 'CO', 'AZ'] as const;
const US_CITY = [
  'Chicago',
  'Austin',
  'Tampa',
  'New York',
  'San Diego',
  'Seattle',
  'Atlanta',
  'Columbus',
  'Pittsburgh',
  'Boston',
  'Denver',
  'Phoenix',
] as const;
const US_ZONE = [
  'America/Chicago',
  'America/Chicago',
  'America/New_York',
  'America/New_York',
  'America/Los_Angeles',
  'America/Los_Angeles',
  'America/New_York',
  'America/New_York',
  'America/New_York',
  'America/New_York',
  'America/Denver',
  'America/Phoenix',
] as const;
const CA_STATE = ['ON', 'QC', 'BC', 'AB', 'MB', 'NS'] as const;
const CA_CITY = ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Winnipeg', 'Halifax'] as const;
const CA_ZONE = [
  'America/Toronto',
  'America/Toronto',
  'America/Vancouver',
  'America/Edmonton',
  'America/Winnipeg',
  'America/Halifax',
] as const;

const US_OWNER = ['usr_mgr_1', 'usr_bdr_2', 'usr_ae_1'] as const;
const FIRM_TYPE = [
  'CPA firm',
  'CPA firm',
  'CPA firm',
  'Tax practice (EA)',
  'Bookkeeping firm',
  'Audit firm',
] as const;
const STAFF_BAND = ['1–5', '6–20', '6–20', '21–50', '21–50', '51–200', '201+'] as const;
const SOFTWARE = [
  '["QuickBooks","Drake Tax"]',
  '["UltraTax CS","QuickBooks","SafeSend"]',
  '["CCH Axcess","Xero"]',
  '["CaseWare","Xero"]',
  '["Lacerte","QuickBooks","Gusto"]',
  '["ProSeries","Bill.com"]',
  '["Sage","ADP"]',
  '["NetSuite","Paychex","Dext"]',
] as const;
const SERVICES = [
  '["Tax preparation and review"]',
  '["Accounting and bookkeeping","Payroll, AP and AR"]',
  '["Audit support"]',
  '["Dedicated professionals"]',
  '["Tax preparation and review","Audit support"]',
  '["Full back-office suite"]',
] as const;
const TITLE = [
  'Managing Partner',
  'Partner',
  'Tax Director',
  'Audit Director',
  'Firm Administrator',
  'Senior Tax Manager',
  'Operations Manager',
  'Controller',
  'Principal',
] as const;
const JOB_FUNCTION = [
  'Partner / Principal',
  'Partner / Principal',
  'Tax Director',
  'Audit / Assurance',
  'Operations / Firm Admin',
  'Tax Director',
  'Operations / Firm Admin',
  'Finance',
  'Partner / Principal',
] as const;
const SENIORITY = [
  'Managing Partner',
  'Partner',
  'Director',
  'Director',
  'Manager',
  'Manager',
  'Manager',
  'Manager',
  'Partner',
] as const;
const LEAD_SOURCE = [
  'Website: trial form',
  'Website: contact form',
  'Apollo',
  'Apollo',
  'Referral',
  'Event',
  'Import',
  'LinkedIn (manual research)',
  'Manual',
] as const;
const LEAD_STATUS = [
  'New',
  'New',
  'Researching',
  'Contacted',
  'Contacted',
  'Engaged',
  'Qualified',
  'Disqualified',
] as const;
const OPEN_STAGE = ['stg_new', 'stg_disc', 'stg_trial', 'stg_prop', 'stg_neg'] as const;
const OPEN_STAGE_NAME = [
  'New Opportunity',
  'Discovery Scheduled',
  'Free Trial (3-Day)',
  'Proposal Sent',
  'Negotiation / MSA',
] as const;
const OPEN_STAGE_PROBABILITY = ['10', '25', '50', '70', '85'] as const;
const ENGAGEMENT = ['Part-time', 'Full-time', 'Seasonal', 'Dedicated team', 'Project'] as const;
const LOST_REASON = [
  'Price',
  'Chose another provider',
  'Hiring locally or in-house',
  'Timing',
  'No response',
] as const;
const TASK_TYPE = ['call', 'email', 'follow_up', 'meeting', 'research', 'proposal'] as const;
const TASK_TITLE = [
  'Call about tax season capacity',
  'Send the staffing overview',
  'Follow up on the proposal',
  'Discovery meeting',
  'Research the firm before outreach',
  'Prepare the proposal',
] as const;
const PRIORITY = ['low', 'normal', 'normal', 'normal', 'high', 'urgent'] as const;
const ACTIVITY_TYPE = ['call', 'email_logged', 'note', 'meeting', 'email_logged', 'call'] as const;
const ACTIVITY_TITLE = [
  'Call logged',
  'Email logged',
  'Note added',
  'Meeting logged',
  'Email logged',
  'Call logged',
] as const;
const ACTIVITY_DETAIL = [
  'Talked through busy-season staffing and review turnaround.',
  'Sent the overview of the offshore tax preparation team.',
  'Prefers a short trial before any commitment.',
  'Walked through the onboarding steps and data security.',
  'Shared sample workpapers and pricing for two preparers.',
  'Left a voicemail and will try again next week.',
] as const;
const TAGS = [
  'busy-season',
  'trial-interest',
  'referral',
  'conference-2026',
  'cas-practice',
  'audit-heavy',
  'multi-office',
  'price-sensitive',
] as const;

/** A SQL text array from developer-written values (no quotes inside any of them). */
const sqlArray = (items: readonly string[]): string =>
  `ARRAY[${items.map((item) => `'${item}'`).join(',')}]`;

/** One value of a list, chosen by an integer SQL expression. */
const pick = (items: readonly string[], expr: string): string =>
  `(${sqlArray(items)})[1 + ((${expr}) % ${items.length})]`;

/** Market, team, owner and place for the company with number `c` (an int SQL expression). */
function companyTraits(c: string) {
  const ca = `((${c}) % 4 = 0)`;
  return {
    market: `CASE WHEN ${ca} THEN 'CA' ELSE 'US' END`,
    team: `CASE WHEN ${ca} THEN 'team_ca' ELSE 'team_us' END`,
    owner: `CASE WHEN ${ca} THEN 'usr_bdr_1' ELSE ${pick(US_OWNER, `(${c}) / 4`)} END`,
    state: `CASE WHEN ${ca} THEN ${pick(CA_STATE, `(${c}) / 4`)} ELSE ${pick(US_STATE, c)} END`,
    city: `CASE WHEN ${ca} THEN ${pick(CA_CITY, `(${c}) / 4`)} ELSE ${pick(US_CITY, c)} END`,
    zone: `CASE WHEN ${ca} THEN ${pick(CA_ZONE, `(${c}) / 4`)} ELSE ${pick(US_ZONE, c)} END`,
    currency: `CASE WHEN ${ca} THEN 'CAD' ELSE 'USD' END`,
    tld: `CASE WHEN ${ca} THEN 'ca' ELSE 'com' END`,
  };
}

/**
 * The surname for an integer SQL expression. Multiplying by a prime that shares no factor
 * with the number of surnames spreads neighbouring rows across all of them evenly.
 */
const surname = (expr: string): string => {
  const k = `((((${expr})::bigint * 7919) % ${SURNAMES})::int)`;
  return `(${pick(SURNAME_START, k)} || ${pick(SURNAME_MIDDLE, `${k} / ${SURNAME_START.length}`)} || ${pick(SURNAME_END, `${k} / ${SURNAME_START.length * SURNAME_MIDDLE.length}`)})`;
};

/** Two surnames for company `c`, never the same one twice, so firm names don't repeat. */
const firmNames = (c: string) => ({
  a: surname(c),
  b: surname(`(${c}) * 3 + 1711`),
});

const companyDomain = (c: string): string => {
  const names = firmNames(c);
  const t = companyTraits(c);
  return `LOWER(${names.a} || ${names.b}) || (${c}) || '.example.' || ${t.tld}`;
};

/** A time in the last `days` days, spread evenly by row number. */
const ago = (n: string, days: number, step: number): string =>
  `NOW() - make_interval(secs => ((${n})::bigint * ${step}) % ${days * 86_400})`;

function companiesSql(from: number, to: number): string {
  const t = companyTraits('n');
  const names = firmNames('n');
  return `
    INSERT INTO companies (
      id, name, domain, website, firm_type, market, state_province, city, timezone, staff_band,
      account_status, owner_user_id, team_id, accounting_software, services_needed,
      estimated_revenue_minor, currency, last_contacted_at, created_at, updated_at
    )
    SELECT
      'cmp_l_' || n,
      CASE WHEN n % 400 = 0 THEN 'Acme ' ELSE '' END
        || ${names.a} || ' ' || ${names.b} || ' ' || ${pick(FIRM_SUFFIX, `n / ${SURNAMES}`)},
      ${companyDomain('n')},
      'https://' || ${companyDomain('n')},
      ${pick(FIRM_TYPE, 'n / 3')},
      ${t.market}, ${t.state}, ${t.city}, ${t.zone},
      ${pick(STAFF_BAND, 'n / 5')},
      CASE WHEN n % 97 = 0 THEN 'do_not_contact' WHEN n % 41 = 0 THEN 'former_client'
           WHEN n % 12 = 0 THEN 'client' ELSE 'prospect' END,
      ${t.owner}, ${t.team},
      ${pick(SOFTWARE, 'n / 7')}::jsonb,
      ${pick(SERVICES, 'n / 11')}::jsonb,
      (50 + (n * 13) % 1500)::bigint * 1000000,
      ${t.currency},
      CASE WHEN n % 3 = 0 THEN NULL ELSE ${ago('n', 600, 7919)} END,
      ${ago('n', 900, 104_729)} - INTERVAL '30 days',
      ${ago('n', 900, 15_485)}
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;`;
}

/** Contact `n` works at company `((n - 1) % companies) + 1`, so each firm has about three. */
function contactsSql(from: number, to: number, size: LargeSeedSize): string {
  const c = `((n - 1) % ${size.companies}) + 1`;
  const t = companyTraits(c);
  const first = pick(FIRST, 'n * 7');
  const last = surname(`n * 3 + n / ${SURNAMES}`);
  const email = `LOWER(${first} || '.' || ${last}) || '.' || n || '@' || ${companyDomain(c)}`;
  return `
    INSERT INTO contacts (
      id, company_id, first_name, last_name, full_name, title, job_function, seniority,
      primary_email, phone_e164, market, timezone, owner_user_id, team_id, do_not_contact,
      email_verification_status, lead_score, last_contacted_at, created_at, updated_at
    )
    SELECT
      'cnt_l_' || n, 'cmp_l_' || (${c}),
      ${first}, ${last}, ${first} || ' ' || ${last},
      ${pick(TITLE, 'n / 3')}, ${pick(JOB_FUNCTION, 'n / 3')}, ${pick(SENIORITY, 'n / 3')},
      ${email},
      -- Half have a phone: a different area code every 100 contacts, numbers 555-0100 to 555-0199.
      CASE WHEN n % 2 = 0
           THEN '+1' || (201 + ((n - 1) / 100) % 700) || '55501' || LPAD(((n - 1) % 100)::text, 2, '0')
           ELSE NULL END,
      ${t.market}, ${t.zone}, ${t.owner}, ${t.team},
      n % 53 = 0,
      CASE WHEN n % 19 = 0 THEN 'risky' WHEN n % 31 = 0 THEN 'invalid'
           WHEN n % 5 = 0 THEN 'unknown' ELSE 'valid' END,
      (n * 17) % 100,
      CASE WHEN n % 5 < 2 THEN NULL ELSE ${ago('n', 600, 7919)} END,
      ${ago('n', 900, 104_729)} - INTERVAL '30 days',
      ${ago('n', 900, 15_485)}
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;

    INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
    SELECT 'ce_l_' || n, 'cnt_l_' || n, ${email}, TRUE,
           CASE WHEN n % 19 = 0 THEN 'risky' WHEN n % 31 = 0 THEN 'invalid'
                WHEN n % 5 = 0 THEN 'unknown' ELSE 'valid' END
    FROM generate_series(${from}, ${to}) AS n
    WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.id = 'cnt_l_' || n)
    ON CONFLICT DO NOTHING;`;
}

/** Half the leads are already linked to a seeded contact and its company. */
function leadsSql(from: number, to: number, size: LargeSeedSize): string {
  const contact = `((n * 5 - 1) % ${size.contacts}) + 1`;
  const c = `((${contact} - 1) % ${size.companies}) + 1`;
  const t = companyTraits(c);
  const names = firmNames(c);
  const first = pick(FIRST, 'n * 13');
  const last = surname(`n * 7 + n / ${SURNAMES} + 11`);
  const status = pick(LEAD_STATUS, 'n / 3');
  return `
    INSERT INTO leads (
      id, first_name, last_name, full_name, email, firm_name, domain, website, title, market,
      state_province, staff_band, source, status, status_category, services_needed,
      software_stack, owner_user_id, team_id, company_id, contact_id, lead_score,
      last_contacted_at, created_at, updated_at
    )
    SELECT
      'lead_l_' || n, ${first}, ${last}, ${first} || ' ' || ${last},
      LOWER(${first} || '.' || ${last}) || '.lead' || n || '@' || ${companyDomain(c)},
      ${names.a} || ' ' || ${names.b} || ' ' || ${pick(FIRM_SUFFIX, `(${c}) / ${SURNAMES}`)},
      ${companyDomain(c)}, 'https://' || ${companyDomain(c)},
      ${pick(TITLE, 'n / 5')}, ${t.market}, ${t.state}, ${pick(STAFF_BAND, 'n / 7')},
      ${pick(LEAD_SOURCE, 'n / 2')}, ${status},
      CASE ${status} WHEN 'Qualified' THEN 'qualified' WHEN 'Disqualified' THEN 'closed' ELSE 'open' END,
      ${pick(SERVICES, 'n / 11')}::jsonb, ${pick(SOFTWARE, 'n / 7')}::jsonb,
      ${t.owner}, ${t.team},
      CASE WHEN n % 2 = 0 THEN 'cmp_l_' || (${c}) ELSE NULL END,
      CASE WHEN n % 2 = 0 THEN 'cnt_l_' || (${contact}) ELSE NULL END,
      (n * 23) % 100,
      CASE WHEN n % 4 = 0 THEN NULL ELSE ${ago('n', 300, 7919)} END,
      ${ago('n', 500, 104_729)} - INTERVAL '10 days',
      ${ago('n', 500, 15_485)}
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;`;
}

/**
 * The first 500 deals are open in the default pipeline (the Kanban budget in PRD 12.2); of
 * the rest, three in five are won and two in five lost, closed within the last two years.
 */
function dealsSql(from: number, to: number, size: LargeSeedSize): string {
  const open = Math.min(500, Math.ceil(size.deals / 5));
  const c = `((n * 7 - 1) % ${size.companies}) + 1`;
  const t = companyTraits(c);
  const names = firmNames(c);
  const isOpen = `(n <= ${open})`;
  const won = `(n > ${open} AND n % 5 < 3)`;
  const monthly = `(2000 + (n * 37) % 9000)::bigint * 100`;
  const closed = ago('n', 700, 7919);
  return `
    INSERT INTO deals (
      id, pipeline_id, stage_id, stage_name, stage_category, company_id, primary_contact_id,
      name, monthly_value_minor, annual_value_minor, currency, fte_count, engagement_model,
      services, probability, expected_close_date, trial_candidate_role, contract_start_date,
      lost_reason, won_at, lost_at, closed_at, owner_user_id, team_id, last_activity_at,
      created_at, updated_at
    )
    SELECT
      'deal_l_' || n, 'pipeline_new_business',
      CASE WHEN ${isOpen} THEN ${pick(OPEN_STAGE, 'n')} WHEN ${won} THEN 'stg_won' ELSE 'stg_lost' END,
      CASE WHEN ${isOpen} THEN ${pick(OPEN_STAGE_NAME, 'n')} WHEN ${won} THEN 'Won' ELSE 'Lost' END,
      CASE WHEN ${isOpen} THEN 'open' WHEN ${won} THEN 'won' ELSE 'lost' END,
      'cmp_l_' || (${c}), 'cnt_l_' || (${c}),
      ${names.a} || ' ' || ${names.b} || ': ' || (1 + n % 4) || ' FTE ' || ${pick(ENGAGEMENT, 'n / 3')},
      ${monthly}, ${monthly} * 12, ${t.currency}, (1 + n % 4)::numeric, ${pick(ENGAGEMENT, 'n / 3')},
      ${pick(SERVICES, 'n / 11')}::jsonb,
      CASE WHEN ${isOpen} THEN (${pick(OPEN_STAGE_PROBABILITY, 'n')})::int WHEN ${won} THEN 100 ELSE 0 END,
      TO_CHAR(NOW() + make_interval(days => (n % 90) - 20), 'YYYY-MM-DD'),
      CASE WHEN ${isOpen} AND n % 5 = 2 THEN 'Senior Tax Preparer' ELSE NULL END,
      CASE WHEN ${won} THEN TO_CHAR(${closed} + INTERVAL '14 days', 'YYYY-MM-DD') ELSE NULL END,
      CASE WHEN NOT ${isOpen} AND NOT ${won} THEN ${pick(LOST_REASON, 'n / 5')} ELSE NULL END,
      CASE WHEN ${won} THEN ${closed} ELSE NULL END,
      CASE WHEN NOT ${isOpen} AND NOT ${won} THEN ${closed} ELSE NULL END,
      CASE WHEN ${isOpen} THEN NULL ELSE ${closed} END,
      ${t.owner}, ${t.team},
      CASE WHEN ${isOpen} THEN ${ago('n', 40, 7919)} ELSE ${closed} END,
      ${closed} - INTERVAL '45 days',
      CASE WHEN ${isOpen} THEN ${ago('n', 40, 7919)} ELSE ${closed} END
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;`;
}

/** Tasks due from 30 days ago to 30 days ahead; one in three already done. */
function tasksSql(from: number, to: number, size: LargeSeedSize): string {
  const contact = `((n * 11 - 1) % ${size.contacts}) + 1`;
  const c = `((${contact} - 1) % ${size.companies}) + 1`;
  const t = companyTraits(c);
  const done = '(n % 3 = 0)';
  const due = `NOW() + make_interval(secs => ((n::bigint * 7919) % ${60 * 86_400}) - ${30 * 86_400})`;
  return `
    INSERT INTO tasks (
      id, title, task_type, priority, status, due_at, completed_at, completed_by_user_id,
      assignee_user_id, team_id, company_id, contact_id, created_by_user_id, created_at, updated_at
    )
    SELECT
      'tsk_l_' || n, ${pick(TASK_TITLE, 'n')}, ${pick(TASK_TYPE, 'n')}, ${pick(PRIORITY, 'n / 6')},
      CASE WHEN ${done} THEN 'completed' ELSE 'open' END,
      ${due},
      CASE WHEN ${done} THEN LEAST(NOW(), ${due}) ELSE NULL END,
      CASE WHEN ${done} THEN ${t.owner} ELSE NULL END,
      ${t.owner}, ${t.team}, 'cmp_l_' || (${c}), 'cnt_l_' || (${contact}), ${t.owner},
      ${due} - INTERVAL '5 days', ${due} - INTERVAL '5 days'
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;`;
}

/**
 * Timeline entries over the last two years: seven in ten on a contact (and its company), two
 * in ten on a company, one in ten on a lead.
 */
function activitiesSql(from: number, to: number, size: LargeSeedSize): string {
  const contact = `((n * 3 - 1) % ${size.contacts}) + 1`;
  const c = `((${contact} - 1) % ${size.companies}) + 1`;
  const lead = `((n - 1) % ${size.leads}) + 1`;
  const t = companyTraits(c);
  const kind = 'n % 10';
  return `
    INSERT INTO activities (
      id, entity_type, entity_id, company_id, contact_id, lead_id, activity_type, title, detail,
      actor_user_id, occurred_at, created_at
    )
    SELECT
      'act_l_' || n,
      CASE WHEN ${kind} < 7 THEN 'contact' WHEN ${kind} < 9 THEN 'company' ELSE 'lead' END,
      CASE WHEN ${kind} < 7 THEN 'cnt_l_' || (${contact})
           WHEN ${kind} < 9 THEN 'cmp_l_' || (${c})
           ELSE 'lead_l_' || (${lead}) END,
      CASE WHEN ${kind} < 9 THEN 'cmp_l_' || (${c}) ELSE NULL END,
      CASE WHEN ${kind} < 7 THEN 'cnt_l_' || (${contact}) ELSE NULL END,
      CASE WHEN ${kind} = 9 THEN 'lead_l_' || (${lead}) ELSE NULL END,
      ${pick(ACTIVITY_TYPE, 'n / 10')}, ${pick(ACTIVITY_TITLE, 'n / 10')},
      ${pick(ACTIVITY_DETAIL, 'n / 7')},
      ${t.owner},
      ${ago('n', 730, 104_729)}, ${ago('n', 730, 104_729)}
    FROM generate_series(${from}, ${to}) AS n
    ON CONFLICT DO NOTHING;`;
}

/** One contact in five and one company in seven carry a tag. */
function tagsSql(size: LargeSeedSize): string {
  return `
    INSERT INTO tags (id, name)
    SELECT 'tag_l_' || i, (${sqlArray(TAGS)})[i] FROM generate_series(1, ${TAGS.length}) AS i
    ON CONFLICT DO NOTHING;

    INSERT INTO entity_tags (entity_type, entity_id, tag_id)
    SELECT 'contact', 'cnt_l_' || n, t.id
    FROM generate_series(5, ${size.contacts}, 5) AS n
    JOIN tags t ON t.name = ${pick(TAGS, 'n / 5')}
    ON CONFLICT DO NOTHING;

    INSERT INTO entity_tags (entity_type, entity_id, tag_id)
    SELECT 'company', 'cmp_l_' || n, t.id
    FROM generate_series(7, ${size.companies}, 7) AS n
    JOIN tags t ON t.name = ${pick(TAGS, 'n / 7')}
    ON CONFLICT DO NOTHING;`;
}

/**
 * Loads the large data set. The small baseline (teams, roles, the seeded people, pipelines)
 * must already be there. Returns the row counts by table afterwards.
 */
export async function seedLarge(
  db: SeedTarget,
  size: LargeSeedSize = LARGE_SEED_SIZE,
  onProgress: (message: string) => void = () => undefined,
): Promise<Record<string, number>> {
  const owners = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM users
     WHERE id IN ('usr_mgr_1', 'usr_bdr_1', 'usr_bdr_2', 'usr_ae_1')`,
  );
  if ((owners.rows[0]?.n ?? 0) < 4) {
    throw new Error('Load the small seed first: the large seed gives its records to those people.');
  }

  const steps: [string, number, (from: number, to: number) => string][] = [
    ['companies', size.companies, companiesSql],
    ['contacts', size.contacts, (from, to) => contactsSql(from, to, size)],
    ['leads', size.leads, (from, to) => leadsSql(from, to, size)],
    ['deals', size.deals, (from, to) => dealsSql(from, to, size)],
    ['tasks', size.tasks, (from, to) => tasksSql(from, to, size)],
    ['activities', size.activities, (from, to) => activitiesSql(from, to, size)],
  ];
  for (const [table, total, build] of steps) {
    for (let from = 1; from <= total; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, total);
      await db.exec(build(from, to));
      onProgress(`${table}: ${to} of ${total}`);
    }
  }
  await db.exec(tagsSql(size));
  onProgress('tags added');
  // Leave the database as a normal day of use would: fresh statistics, and the search
  // indexes' pending lists merged in. Straight after a bulk load those lists are long, and
  // PostgreSQL avoids the trigram indexes until its background vacuum has merged them.
  await db.exec('VACUUM (ANALYZE);');

  const counts: Record<string, number> = {};
  for (const table of ['companies', 'contacts', 'leads', 'deals', 'tasks', 'activities']) {
    const res = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
    counts[table] = res.rows[0]?.n ?? 0;
  }
  return counts;
}
