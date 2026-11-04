/**
 * Synthetic development data (AGENTS.md section 5: never real personal data).
 * Every name, firm and address here is invented; emails use example.com/.ca domains.
 * Used by `pnpm db:seed` and by the test database. Never loaded by the running API.
 */

export const SEED_SQL: readonly string[] = [
  `
      INSERT INTO teams (id, name, market) VALUES
        ('team_us', 'U.S. CPA Growth Team', 'US'),
        ('team_ca', 'Canada Chartered Practice Team', 'CA')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO roles (id, name, description, is_system) VALUES
        ('role_admin', 'Admin', 'Full system administration and compliance control', TRUE),
        ('role_sales_mgr', 'Sales Manager', 'Manages team pipeline, sequences, and conversions', TRUE),
        ('role_bdr', 'BDR / SDR', 'Qualifies leads and runs outbound sequences', TRUE),
        ('role_ae', 'Account Executive', 'Manages deals, 3-day free trials, and closing', TRUE),
        ('role_mkt_mgr', 'Marketing Manager', 'Approves campaigns, manages segments and compliance', TRUE),
        ('role_analyst', 'Read-Only / Analyst', 'Read-only reporting and audit analyst', TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO users (id, email, name, role_id, team_id, market_focus, status, is_break_glass, password_hash, totp_secret, daily_send_cap) VALUES
        ('usr_admin_1', 'ved@adasglobuspro.example.com', 'Ved Shah', 'role_admin', 'team_us', 'US', 'active', TRUE, 'argon2id$v=19$m=65536,t=3,p=4$breakglass-admin', 'JBSWY3DPEHPK3PXP', 50),
        ('usr_mgr_1', 'arjun@adasglobuspro.example.com', 'Arjun Mehta', 'role_sales_mgr', 'team_us', 'US', 'active', FALSE, NULL, NULL, 50),
        ('usr_bdr_1', 'priya@adasglobuspro.example.com', 'Priya Nair', 'role_bdr', 'team_ca', 'CA', 'active', FALSE, NULL, NULL, 50),
        ('usr_bdr_2', 'kabir@adasglobuspro.example.com', 'Kabir Rao', 'role_bdr', 'team_us', 'US', 'active', FALSE, NULL, NULL, 50),
        ('usr_ae_1', 'rohan@adasglobuspro.example.com', 'Rohan Desai', 'role_ae', 'team_us', 'US', 'active', FALSE, NULL, NULL, 50),
        ('usr_mkt_1', 'ananya@adasglobuspro.example.com', 'Ananya Iyer', 'role_mkt_mgr', 'team_us', 'US', 'active', FALSE, NULL, NULL, 50),
        ('usr_ro_1', 'dev@adasglobuspro.example.com', 'Devika Joshi', 'role_analyst', 'team_us', 'US', 'active', FALSE, NULL, NULL, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO settings (key, value_json, updated_by_user_id) VALUES
        ('mail.live_enabled', 'false'::jsonb, 'usr_admin_1'),
        ('compliance.counsel_signed_off', 'false'::jsonb, 'usr_admin_1'),
        ('compliance.postal_address.US', '"ADAS Globus Pro · 30 N Gould St, Sheridan, WY 82801, USA"'::jsonb, 'usr_admin_1'),
        ('compliance.postal_address.CA', '"ADAS Globus Pro · 9622 42 Ave NW, Edmonton, AB T6E 5Y4, Canada"'::jsonb, 'usr_admin_1'),
        ('apollo.daily_credit_limit', '200'::jsonb, 'usr_admin_1'),
        ('sla.first_response_business_days', '1'::jsonb, 'usr_admin_1')
      ON CONFLICT (key) DO NOTHING;

      INSERT INTO fx_rates (id, from_currency, to_currency, rate_scaled, effective_date) VALUES
        ('fx_cad_usd_2026', 'CAD', 'USD', 740000, '2026-01-01'),
        ('fx_usd_cad_2026', 'USD', 'CAD', 1351351, '2026-01-01'),
        ('fx_usd_usd_2026', 'USD', 'USD', 1000000, '2026-01-01'),
        ('fx_cad_cad_2026', 'CAD', 'CAD', 1000000, '2026-01-01')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pipelines (id, name, is_default) VALUES
        ('pipeline_new_business', 'New Business', TRUE),
        ('pipeline_expansion', 'Client Expansion', FALSE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pipeline_stages (id, pipeline_id, name, category, probability, stage_order, required_fields) VALUES
        ('stg_new', 'pipeline_new_business', 'New Opportunity', 'open', 10, 1, '[]'::jsonb),
        ('stg_disc', 'pipeline_new_business', 'Discovery Scheduled', 'open', 25, 2, '[]'::jsonb),
        ('stg_trial', 'pipeline_new_business', 'Free Trial (3-Day)', 'open', 50, 3, '["trial_candidate_role"]'::jsonb),
        ('stg_prop', 'pipeline_new_business', 'Proposal Sent', 'open', 70, 4, '[]'::jsonb),
        ('stg_neg', 'pipeline_new_business', 'Negotiation / MSA', 'open', 85, 5, '[]'::jsonb),
        ('stg_won', 'pipeline_new_business', 'Won', 'won', 100, 6, '["contract_start_date"]'::jsonb),
        ('stg_lost', 'pipeline_new_business', 'Lost', 'lost', 0, 7, '["lost_reason"]'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `,
  `
      INSERT INTO companies (
        id, name, domain, website, firm_type, market, state_province, city, timezone,
        staff_band, account_status, owner_user_id, team_id, accounting_software, services_needed,
        estimated_revenue_minor, currency, version
      ) VALUES
        ('cmp_acme', 'Acme Tax & Advisory LLP', 'acmetax.example.com', 'https://acmetax.example.com', 'CPA firm', 'US', 'IL', 'Chicago', 'America/Chicago', '21–50', 'prospect', 'usr_mgr_1', 'team_us', '["UltraTax CS","QuickBooks","SafeSend","Suralink"]'::jsonb, '["Tax Preparation","Audit Support"]'::jsonb, 680000000, 'USD', 1),
        ('cmp_northstar', 'Northstar Chartered Accountants', 'northstarcpa.example.ca', 'https://northstarcpa.example.ca', 'CPA firm', 'CA', 'ON', 'Toronto', 'America/Toronto', '11–20', 'prospect', 'usr_bdr_1', 'team_ca', '["CaseWare","TaxCycle","Xero"]'::jsonb, '["Canadian T1/T2 Tax","Year-End Working Papers"]'::jsonb, 420000000, 'CAD', 1),
        ('cmp_ridgeway', 'Ridgeway CPA Group', 'ridgewaycpa.example.com', 'https://ridgewaycpa.example.com', 'CPA firm', 'US', 'TX', 'Austin', 'America/Chicago', '51–100', 'prospect', 'usr_ae_1', 'team_us', '["CCH Axcess","QuickBooks","Canopy"]'::jsonb, '["Audit Support","Bookkeeping"]'::jsonb, 1250000000, 'USD', 1),
        ('cmp_clearwater', 'Clearwater Accounting LLP', 'clearwaterllp.example.com', 'https://clearwaterllp.example.com', 'CPA firm', 'US', 'FL', 'Tampa', 'America/New_York', '11–20', 'client', 'usr_ae_1', 'team_us', '["Drake Tax","QuickBooks"]'::jsonb, '["Tax Preparation","Payroll"]'::jsonb, 390000000, 'USD', 1),
        ('cmp_laurentian', 'Laurentian Advisory CPA', 'laurentian-cpa.example.ca', 'https://laurentian-cpa.example.ca', 'CPA firm', 'CA', 'QC', 'Montreal', 'America/Toronto', '21–50', 'prospect', 'usr_bdr_1', 'team_ca', '["TaxCycle","QuickBooks"]'::jsonb, '["Bookkeeping","Canadian T1/T2 Tax"]'::jsonb, 510000000, 'CAD', 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO contacts (
        id, company_id, first_name, last_name, full_name, title, job_function, seniority,
        primary_email, phone_e164, market, timezone, owner_user_id, team_id,
        do_not_contact, email_verification_status, lead_score, version
      ) VALUES
        ('cnt_jane', 'cmp_acme', 'Jane', 'Patel', 'Jane Patel', 'Managing Partner', 'Partner / Principal', 'Managing Partner', 'jane.patel@acmetax.example.com', '+13125550148', 'US', 'America/Chicago', 'usr_mgr_1', 'team_us', FALSE, 'valid', 88, 1),
        ('cnt_marcus', 'cmp_northstar', 'Marcus', 'Vance', 'Marcus Vance', 'Tax Practice Leader', 'Tax Director', 'Director', 'm.vance@northstarcpa.example.ca', '+14165550192', 'CA', 'America/Toronto', 'usr_bdr_1', 'team_ca', FALSE, 'valid', 82, 1),
        ('cnt_elena', 'cmp_ridgeway', 'Elena', 'Rostova', 'Elena Rostova', 'Audit Director', 'Audit / Assurance', 'Director', 'elena@ridgewaycpa.example.com', '+15125550164', 'US', 'America/Chicago', 'usr_ae_1', 'team_us', FALSE, 'valid', 79, 1),
        ('cnt_david', 'cmp_clearwater', 'David', 'Chen', 'David Chen', 'Senior Partner', 'Partner / Principal', 'Partner', 'dchen@clearwaterllp.example.com', '+18135550133', 'US', 'America/New_York', 'usr_ae_1', 'team_us', FALSE, 'valid', 91, 1),
        ('cnt_sophie', 'cmp_laurentian', 'Sophie', 'Tremblay', 'Sophie Tremblay', 'Operations Partner', 'Operations / Firm Admin', 'Partner', 'stremblay@laurentian-cpa.example.ca', '+15145550171', 'CA', 'America/Toronto', 'usr_bdr_1', 'team_ca', FALSE, 'valid', 74, 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status) VALUES
        ('ce_1', 'cnt_jane', 'jane.patel@acmetax.example.com', TRUE, 'valid'),
        ('ce_2', 'cnt_marcus', 'm.vance@northstarcpa.example.ca', TRUE, 'valid'),
        ('ce_3', 'cnt_elena', 'elena@ridgewaycpa.example.com', TRUE, 'valid'),
        ('ce_4', 'cnt_david', 'dchen@clearwaterllp.example.com', TRUE, 'valid'),
        ('ce_5', 'cnt_sophie', 'stremblay@laurentian-cpa.example.ca', TRUE, 'valid')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO leads (
        id, first_name, last_name, full_name, email, phone_e164, firm_name, domain, website,
        title, market, state_province, staff_band, source, status, status_category,
        services_needed, software_stack, owner_user_id, team_id, company_id, contact_id, lead_score, version
      ) VALUES
        ('lead_jane', 'Jane', 'Patel', 'Jane Patel', 'jane.patel@acmetax.example.com', '+13125550148', 'Acme Tax & Advisory LLP', 'acmetax.example.com', 'https://acmetax.example.com', 'Managing Partner', 'US', 'IL', '21–50', 'Website: 3-day trial form', 'Qualified', 'qualified', '["Tax Preparation","Audit Support"]'::jsonb, '["UltraTax CS","QuickBooks"]'::jsonb, 'usr_mgr_1', 'team_us', 'cmp_acme', 'cnt_jane', 88, 1),
        ('lead_marcus', 'Marcus', 'Vance', 'Marcus Vance', 'm.vance@northstarcpa.example.ca', '+14165550192', 'Northstar Chartered Accountants', 'northstarcpa.example.ca', 'https://northstarcpa.example.ca', 'Tax Practice Leader', 'CA', 'ON', '11–20', 'Website: 3-day trial form', 'Engaged', 'open', '["Canadian T1/T2 Tax"]'::jsonb, '["CaseWare","TaxCycle"]'::jsonb, 'usr_bdr_1', 'team_ca', 'cmp_northstar', 'cnt_marcus', 82, 1),
        ('lead_elena', 'Elena', 'Rostova', 'Elena Rostova', 'elena@ridgewaycpa.example.com', '+15125550164', 'Ridgeway CPA Group', 'ridgewaycpa.example.com', 'https://ridgewaycpa.example.com', 'Audit Director', 'US', 'TX', '51–100', 'Apollo outbound', 'Contacted', 'open', '["Audit Support"]'::jsonb, '["CCH Axcess"]'::jsonb, 'usr_bdr_2', 'team_us', 'cmp_ridgeway', 'cnt_elena', 79, 1),
        ('lead_sophie', 'Sophie', 'Tremblay', 'Sophie Tremblay', 'stremblay@laurentian-cpa.example.ca', '+15145550171', 'Laurentian Advisory CPA', 'laurentian-cpa.example.ca', 'https://laurentian-cpa.example.ca', 'Operations Partner', 'CA', 'QC', '21–50', 'Partner referral', 'New', 'open', '["Bookkeeping"]'::jsonb, '["TaxCycle"]'::jsonb, 'usr_bdr_1', 'team_ca', 'cmp_laurentian', 'cnt_sophie', 74, 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO deals (
        id, pipeline_id, stage_id, stage_name, stage_category, company_id, primary_contact_id,
        name, monthly_value_minor, annual_value_minor, currency, fte_count, engagement_model,
        services, probability, expected_close_date, trial_candidate_role, contract_start_date,
        owner_user_id, team_id, version
      ) VALUES
        ('deal_acme_tax', 'pipeline_new_business', 'stg_trial', 'Free Trial (3-Day)', 'open', 'cmp_acme', 'cnt_jane', '2027 Tax Season Prep Pod (3 FTE)', 840000, 10080000, 'USD', 3.0, 'Trial-first', '["Tax Preparation","Review Ready Returns"]'::jsonb, 50, '2026-11-30', 'Senior US Tax Preparer (EA)', NULL, 'usr_mgr_1', 'team_us', 1),
        ('deal_northstar_ca', 'pipeline_new_business', 'stg_disc', 'Discovery Scheduled', 'open', 'cmp_northstar', 'cnt_marcus', 'T1/T2 Canadian Tax Pod (2 FTE)', 620000, 7440000, 'CAD', 2.0, 'Full-time', '["Canadian T1/T2 Tax"]'::jsonb, 25, '2026-12-10', NULL, NULL, 'usr_bdr_1', 'team_ca', 1),
        ('deal_ridgeway_audit', 'pipeline_new_business', 'stg_prop', 'Proposal Sent', 'open', 'cmp_ridgeway', 'cnt_elena', 'Audit Support Specialist Pod (2 FTE)', 560000, 6720000, 'USD', 2.0, 'Full-time', '["Audit Support"]'::jsonb, 70, '2026-11-25', NULL, NULL, 'usr_ae_1', 'team_us', 1),
        ('deal_clearwater_won', 'pipeline_new_business', 'stg_won', 'Won', 'won', 'cmp_clearwater', 'cnt_david', 'Year-Round Bookkeeping & Tax Pod (2 FTE)', 520000, 6240000, 'USD', 2.0, 'Full-time', '["Tax Preparation","Bookkeeping"]'::jsonb, 100, '2026-10-15', 'Senior Tax Senior', '2026-11-01', 'usr_ae_1', 'team_us', 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO tasks (
        id, title, task_type, priority, status, due_at, sla_deadline_at, sla_breached,
        assignee_user_id, team_id, lead_id, company_id, contact_id, deal_id, created_by_user_id
      ) VALUES
        ('tsk_sla_1', 'First response SLA: Jane Patel (Acme Tax 3-day trial inquiry)', 'sla_first_response', 'urgent', 'open', NOW() + INTERVAL '12 minutes', NOW() + INTERVAL '15 minutes', FALSE, 'usr_mgr_1', 'team_us', 'lead_jane', 'cmp_acme', 'cnt_jane', 'deal_acme_tax', 'usr_admin_1'),
        ('tsk_trial_d1', 'Day 1 Free Trial check-in: Acme Tax & Advisory LLP', 'trial_checkin', 'high', 'open', NOW() + INTERVAL '1 day', NULL, FALSE, 'usr_mgr_1', 'team_us', NULL, 'cmp_acme', 'cnt_jane', 'deal_acme_tax', 'usr_mgr_1'),
        ('tsk_ca_call', 'Discovery prep call with Marcus Vance (Northstar CA)', 'call', 'normal', 'open', NOW() + INTERVAL '2 days', NULL, FALSE, 'usr_bdr_1', 'team_ca', 'lead_marcus', 'cmp_northstar', 'cnt_marcus', 'deal_northstar_ca', 'usr_bdr_1')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO consent_records (
        id, email, contact_id, market, basis, status, source, proof_text, captured_at, expires_at
      ) VALUES
        ('cns_jane', 'jane.patel@acmetax.example.com', 'cnt_jane', 'US', 'express', 'active', 'Website 3-day trial form', 'Submitted trial request form on adasglobuspro.com', NOW() - INTERVAL '2 days', NULL),
        ('cns_marcus', 'm.vance@northstarcpa.example.ca', 'cnt_marcus', 'CA', 'implied_inquiry', 'active', 'Website 3-day trial form', 'CASL 6-month implied inquiry consent from website form', NOW() - INTERVAL '5 days', NOW() + INTERVAL '175 days'),
        ('cns_sophie', 'stremblay@laurentian-cpa.example.ca', 'cnt_sophie', 'CA', 'implied_published', 'active', 'CPA Quebec directory listing', 'Published business email without non-solicitation notice', NOW() - INTERVAL '10 days', NULL)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO templates (
        id, name, category, market, subject, body_text, variables, owner_user_id
      ) VALUES
        ('tpl_us_tax_pod', 'U.S. Tax Season 3-Day Free Trial Intro', 'sequence', 'US', '3-day risk-free UltraTax pod trial for {{company.name}}', 'Hi {{contact.first_name}}, we noticed {{company.name}} uses {{company.software}}. Would a 3-day no-cost trial of a dedicated Senior Tax Preparer help ahead of tax season?', '["contact.first_name","company.name","company.software"]'::jsonb, 'usr_mgr_1'),
        ('tpl_ca_casl_intro', 'Canada CASL Implied Inquiry Follow-Up', 'sequence', 'CA', 'Following up on {{company.name}} staffing inquiry', 'Hi {{contact.first_name}}, thank you for reaching out regarding T1/T2 tax support at {{company.name}}. Here is our 3-day trial overview.', '["contact.first_name","company.name"]'::jsonb, 'usr_bdr_1')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO sequences (
        id, name, market, status, daily_cap_per_mailbox, owner_user_id, team_id
      ) VALUES
        ('seq_us_cpa_trial', 'U.S. CPA 3-Day Free Trial Outbound', 'US', 'active', 50, 'usr_mgr_1', 'team_us'),
        ('seq_ca_cpa_inquiry', 'Canada CPA Inquiry Follow-Up (CASL Verified)', 'CA', 'active', 50, 'usr_bdr_1', 'team_ca')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO sequence_steps (
        id, sequence_id, step_order, delay_business_days, subject_template, body_template
      ) VALUES
        ('stp_us_1', 'seq_us_cpa_trial', 1, 0, '3-day risk-free tax pod trial for {{company.name}}', 'Hi {{contact.first_name}}, would {{company.name}} be open to a 3-day risk-free trial of an EA-qualified tax preparer?'),
        ('stp_us_2', 'seq_us_cpa_trial', 2, 3, 'Re: 3-day tax pod trial for {{company.name}}', 'Hi {{contact.first_name}}, sharing a sample workpaper checklist from our Chicago CPA firm pods.'),
        ('stp_ca_1', 'seq_ca_cpa_inquiry', 1, 0, 'T1/T2 CaseWare & TaxCycle pod for {{company.name}}', 'Hi {{contact.first_name}}, following up on your inquiry for {{company.name}}.')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO lists (
        id, name, list_type, market, filter_json, member_count, owner_user_id
      ) VALUES
        ('lst_us_ultratax', 'U.S. CPA Firms on UltraTax CS (21–100 Staff)', 'dynamic', 'US', '{"field":"company.market","op":"eq","value":"US"}'::jsonb, 3, 'usr_mkt_1'),
        ('lst_ca_express', 'Canada CASL Active Consent Contacts', 'dynamic', 'CA', '{"field":"company.market","op":"eq","value":"CA"}'::jsonb, 2, 'usr_mkt_1')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO campaigns (
        id, name, subject, body_html, market, status, list_id, approved_by_user_id, approved_at,
        sent_count, delivered_count, bounced_count, complained_count, unsubscribed_count,
        owner_user_id, team_id
      ) VALUES
        ('cmpg_us_q4_tax', '2027 Busy Season Readiness Briefing (U.S. CPA Firms)', 'How 40+ U.S. CPA firms staff UltraTax & CCH pods before Jan 15', '<p>Explore our 3-day risk-free CPA staffing trial.</p>', 'US', 'approved', 'lst_us_ultratax', 'usr_mkt_1', NOW() - INTERVAL '1 day', 120, 118, 1, 0, 1, 'usr_mkt_1', 'team_us')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO mailbox_connections (
        id, user_id, email, provider, status, last_synced_at, daily_send_cap, sent_today_count
      ) VALUES
        ('mbx_mgr_1', 'usr_mgr_1', 'arjun@adasglobuspro.example.com', 'microsoft_graph', 'connected', NOW() - INTERVAL '2 minutes', 50, 8),
        ('mbx_bdr_1', 'usr_bdr_1', 'priya@adasglobuspro.example.com', 'microsoft_graph', 'connected', NOW() - INTERVAL '4 minutes', 50, 5)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO email_threads (
        id, subject, contact_id, company_id, deal_id, owner_user_id, team_id, last_message_at, message_count, status
      ) VALUES
        ('thd_acme_1', 'Re: 3-day UltraTax CS trial candidate resumes', 'cnt_jane', 'cmp_acme', 'deal_acme_tax', 'usr_mgr_1', 'team_us', NOW() - INTERVAL '45 minutes', 2, 'replied')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO email_messages (
        id, thread_id, provider_message_id, direction, from_email, to_emails, subject, body_preview, body_text
      ) VALUES
        ('msg_acme_1', 'thd_acme_1', 'graph_msg_001', 'outbound', 'arjun@adasglobuspro.example.com', '["jane.patel@acmetax.example.com"]'::jsonb, '3-day UltraTax CS trial candidate resumes', 'Hi Jane, attached are two EA-qualified Senior Tax Preparer profiles...', 'Hi Jane, attached are two EA-qualified Senior Tax Preparer profiles ready to start your 3-day free trial on Monday.'),
        ('msg_acme_2', 'thd_acme_1', 'graph_msg_002', 'inbound', 'jane.patel@acmetax.example.com', '["arjun@adasglobuspro.example.com"]'::jsonb, 'Re: 3-day UltraTax CS trial candidate resumes', 'Thanks Arjun — let us start the 3-day trial with Candidate A next Tuesday.', 'Thanks Arjun — let us start the 3-day trial with Candidate A next Tuesday at 9am CT.')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO scoring_rules (
        id, name, category, field_path, operator, target_value, points, active
      ) VALUES
        ('scr_firm_size', 'CPA Firm 21–100 Staff ICP', 'fit', 'staffBand', 'in', '["21–50","51–100"]'::jsonb, 25, TRUE),
        ('scr_partner_title', 'Decision Maker (Partner / Director)', 'fit', 'title', 'contains', '"Partner"'::jsonb, 20, TRUE),
        ('scr_trial_source', 'Website 3-Day Free Trial Inquiry', 'engagement', 'source', 'contains', '"trial"'::jsonb, 35, TRUE),
        ('scr_tax_software', 'Tier-1 Tax Software (UltraTax / CCH / CaseWare)', 'fit', 'softwareStack', 'contains', '"UltraTax CS"'::jsonb, 15, TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO webhook_endpoints (
        id, name, target_url, secret_hmac, event_types, active, last_status_code
      ) VALUES
        ('wh_n8n_deal_won', 'n8n Deal Won Onboarding Workflow', 'http://localhost:5678/webhook/deal-won', 'whsec_synthetic_n8n_hmac_key', '["deal.won","lead.created","trial.started"]'::jsonb, TRUE, 200)
      ON CONFLICT (id) DO NOTHING;
    `,
];

export interface SeedTarget {
  exec(sql: string): Promise<void>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
}

/** Loads the synthetic baseline once; does nothing if users already exist. */
export async function seedSyntheticBaseline(db: SeedTarget): Promise<boolean> {
  const existing = await db.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users');
  if ((existing.rows[0]?.cnt ?? 0) > 0) return false;
  for (const sql of SEED_SQL) await db.exec(sql);
  return true;
}
