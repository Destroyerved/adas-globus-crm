// Optional demo data so you can explore the CRM. Everything created here is tagged "demo".
// Run: npm run seed      Remove later: Contacts → filter tag "demo" → select all → Delete.
import { get, all, run, insert } from './db.js';
import { createCompany, createContact, createDeal, createActivity } from './models.js';
import { now, addMs, DAY } from './util.js';

const admin = get("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
if (!admin) {
  console.log('Open the CRM in your browser and create the admin account first, then run this again.');
  process.exit(1);
}
if (get("SELECT COUNT(*) AS n FROM contacts WHERE tags LIKE '%,demo,%'").n > 0) {
  console.log('Demo data already present. Nothing to do.');
  process.exit(0);
}

const companies = [
  ['Meridian Logistics', 'meridianlogistics.example', 'Logistics', 420, 'Mumbai', 'India'],
  ['Northwind Foods', 'northwindfoods.example', 'Food & Beverage', 1200, 'Dubai', 'United Arab Emirates'],
  ['Brightline Engineering', 'brightline.example', 'Engineering', 85, 'Pune', 'India'],
  ['Cobalt Health', 'cobalthealth.example', 'Healthcare', 640, 'London', 'United Kingdom'],
  ['Summit Retail Group', 'summitretail.example', 'Retail', 3100, 'Singapore', 'Singapore'],
  ['Lakeside Capital', 'lakesidecap.example', 'Financial Services', 60, 'New York', 'United States'],
];
const people = [
  ['Aarav', 'Mehta', 'Head of Operations', 0, 'qualified', 'Referral'],
  ['Sara', 'Khan', 'Procurement Manager', 1, 'contacted', 'Apollo'],
  ['Rohan', 'Iyer', 'CTO', 2, 'customer', 'Website'],
  ['Emily', 'Carter', 'VP Partnerships', 3, 'lead', 'LinkedIn'],
  ['Wei', 'Lim', 'Director of IT', 4, 'qualified', 'Event'],
  ['Daniel', 'Brooks', 'Managing Partner', 5, 'lead', 'Cold outreach'],
  ['Priya', 'Nair', 'Finance Controller', 0, 'contacted', 'Apollo'],
  ['Omar', 'Haddad', 'Supply Chain Lead', 1, 'lead', 'Website'],
];

const coIds = companies.map(([name, domain, industry, employees, city, country]) =>
  createCompany({ name, domain, website: `https://${domain}`, industry, employees, city, country, tags: 'demo' }, admin, { silent: true }).id);

const contactIds = people.map(([first, last, title, co, status, source]) =>
  createContact({
    first_name: first, last_name: last, title, company_id: coIds[co], status, source, tags: 'demo',
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${companies[co][1]}`, phone: '+91 98200 0000',
  }, admin, { silent: true }).id);

const stages = all('SELECT * FROM stages ORDER BY position');
const stage = (name) => stages.find((s) => s.name === name)?.id || stages[0].id;
const deals = [
  ['Meridian – warehouse automation', 48000, 'Proposal sent', 0, 0, 12],
  ['Northwind – distributor contract', 120000, 'Negotiation', 1, 1, 20],
  ['Brightline – annual support', 18000, 'Won', 2, 2, -5],
  ['Cobalt – pilot programme', 26000, 'Meeting booked', 3, 3, 30],
  ['Summit – regional rollout', 210000, 'Qualified', 4, 4, 45],
  ['Lakeside – advisory retainer', 9000, 'New lead', 5, 5, 60],
  ['Meridian – fleet analytics add-on', 15000, 'Won', 6, 0, -40],
  ['Northwind – ERP integration', 34000, 'Lost', 7, 1, -20],
];
for (const [title, value, st, ci, co, closeIn] of deals) {
  const d = createDeal({ title, value, stage_id: stage(st), contact_id: contactIds[ci], company_id: coIds[co], expected_close: addMs(closeIn * DAY).slice(0, 10), tags: 'demo' }, admin);
  if (closeIn < 0) run('UPDATE deals SET closed_at = ? WHERE id = ?', addMs(closeIn * DAY), d.id);
}

createActivity({ type: 'call', subject: 'Discovery call', body: 'Interested in automating two warehouses. Wants a proposal by Friday.', contact_id: contactIds[0] }, admin, { silent: true });
createActivity({ type: 'meeting', subject: 'On-site demo', body: 'Demoed the platform to the IT team. Next: security review.', contact_id: contactIds[4] }, admin, { silent: true });
createActivity({ type: 'note', subject: 'Budget approved for Q1', contact_id: contactIds[1] }, admin, { silent: true });
createActivity({ type: 'task', subject: 'Send revised proposal', contact_id: contactIds[0], due_at: addMs(-1 * DAY), priority: 'high' }, admin, { silent: true });
createActivity({ type: 'task', subject: 'Follow up on security questionnaire', contact_id: contactIds[4], due_at: addMs(2 * 3_600_000) }, admin, { silent: true });
createActivity({ type: 'task', subject: 'Book quarterly review', contact_id: contactIds[2], due_at: addMs(3 * DAY) }, admin, { silent: true });

// A little email history so the dashboard has engagement numbers
const subjects = ['Quick idea for Meridian Logistics', 'Re: distributor pricing', 'Proposal attached', 'Following up', 'Welcome aboard'];
contactIds.slice(0, 5).forEach((cid, i) => {
  const c = get('SELECT email FROM contacts WHERE id = ?', cid);
  const sentAt = addMs(-(i + 2) * DAY);
  insert('emails', {
    direction: 'out', status: 'sent', contact_id: cid, user_id: admin.id, from_addr: admin.email, to_addr: c.email, subject: subjects[i],
    body: '<p>Demo email</p>', text_body: 'Demo email', tracking_id: `demo-${cid}-${Date.now()}`, sent_at: sentAt, created_at: sentAt,
    opened_at: i < 4 ? addMs(-(i + 1) * DAY) : null, open_count: i < 4 ? 2 : 0, clicked_at: i < 2 ? addMs(-(i + 1) * DAY) : null, click_count: i < 2 ? 1 : 0,
    replied_at: i === 1 ? addMs(-1 * DAY) : null,
  });
});
run('UPDATE contacts SET last_contacted_at = ? WHERE tags LIKE ?', now(), '%,demo,%');

console.log(`Demo data created: ${companies.length} companies, ${people.length} contacts, ${deals.length} deals (all tagged "demo").`);
