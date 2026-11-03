import { type Currency, type LeadSystemStatus, type Market, type StatusTone } from '@adas/shared';

export interface SyntheticLeadRow {
  id: string;
  contactName: string;
  contactTitle: string;
  email: string;
  companyId: string;
  companyName: string;
  market: Market;
  status: LeadSystemStatus;
  statusTone: StatusTone;
  source: string;
  ownerName: string;
  ownerInitials: string;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  overdueFollowUp?: boolean;
  firmSize: string;
  software: string[];
}

export interface SyntheticTimelineItem {
  id: string;
  dayGroup: string;
  type: 'call' | 'meeting' | 'email' | 'note' | 'status_change' | 'task' | 'system';
  isUserAction: boolean;
  actor: string;
  summary: string;
  timeLabel: string;
  body?: string;
  emailMeta?: {
    from: string;
    to: string;
    subject: string;
  };
}

export interface SyntheticCompanyProfile {
  id: string;
  name: string;
  domain: string;
  website: string;
  market: Market;
  country: string;
  region: string;
  city: string;
  localTimeLabel: string;
  firmType: string;
  sizeBand: string;
  software: string[];
  accountStatus: 'Prospect' | 'Active client' | 'Do not contact';
  accountStatusTone: StatusTone;
  ownerName: string;
  annualRevenueMinor: bigint;
  revenueCurrency: Currency;
  leadSource: string;
  marketingBasis: string;
  contacts: Array<{
    id: string;
    name: string;
    title: string;
    email: string;
    phone: string;
    isPrimary: boolean;
    verificationStatus: 'Valid email' | 'Risky email';
    verificationTone: StatusTone;
  }>;
  deals: Array<{
    id: string;
    name: string;
    stage: string;
    monthlyValueMinor: bigint;
    currency: Currency;
    fteCount: string;
    engagementModel: string;
  }>;
  nextTask: {
    title: string;
    dueLabel: string;
    assignee: string;
    priority: 'High' | 'Normal';
  };
  timeline: SyntheticTimelineItem[];
}

export interface SyntheticDealCard {
  id: string;
  stageId: string;
  companyName: string;
  dealName: string;
  market: Market;
  currency: Currency;
  monthlyValueMinor: bigint;
  termMonths: number;
  fteLabel: string;
  engagementModel: string;
  ownerName: string;
  ownerInitials: string;
  badgeText?: string;
  badgeTone?: StatusTone;
}

export interface SyntheticKanbanStage {
  id: string;
  name: string;
  probability: number;
  category: 'open' | 'won' | 'lost';
  requiredOnEntry: string[];
}

export const SYNTHETIC_LEADS_TOTAL = 12_480;

export const SYNTHETIC_LEADS: SyntheticLeadRow[] = [
  {
    id: 'lead_01',
    contactName: 'Jane Patel',
    contactTitle: 'Managing Partner',
    email: 'jane.patel@acmetax.example.com',
    companyId: 'comp_01',
    companyName: 'Acme Tax & Advisory LLP',
    market: 'US',
    status: 'Qualified',
    statusTone: 'success',
    source: 'Website: trial form',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
    lastContactedAt: '2026-11-04T12:15:00Z',
    nextFollowUpAt: '2026-11-05T15:00:00Z',
    firmSize: '21–50',
    software: ['UltraTax CS', 'QuickBooks', 'SafeSend'],
  },
  {
    id: 'lead_02',
    contactName: 'Marcus Vance',
    contactTitle: 'Tax Practice Leader',
    email: 'm.vance@northstarcpa.example.ca',
    companyId: 'comp_02',
    companyName: 'Northstar Chartered Accountants',
    market: 'CA',
    status: 'Engaged',
    statusTone: 'brand',
    source: 'Website: contact form',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
    lastContactedAt: '2026-11-04T09:40:00Z',
    nextFollowUpAt: '2026-11-04T19:30:00Z',
    firmSize: '51–200',
    software: ['CaseWare', 'Taxprep', 'Xero'],
  },
  {
    id: 'lead_03',
    contactName: 'Elena Rostova',
    contactTitle: 'Audit Director',
    email: 'elena@ridgewaycpa.example.com',
    companyId: 'comp_03',
    companyName: 'Ridgeway CPA Group',
    market: 'US',
    status: 'New',
    statusTone: 'info',
    source: 'Website: trial form',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
    lastContactedAt: null,
    nextFollowUpAt: '2026-11-04T14:00:00Z',
    overdueFollowUp: true,
    firmSize: '21–50',
    software: ['CCH Axcess', 'Suralink', 'Bill.com'],
  },
  {
    id: 'lead_04',
    contactName: 'David Chen',
    contactTitle: 'Senior Partner',
    email: 'dchen@clearwaterllp.example.com',
    companyId: 'comp_04',
    companyName: 'Clearwater Accounting LLP',
    market: 'US',
    status: 'Contacted',
    statusTone: 'neutral',
    source: 'Apollo',
    ownerName: 'Rohan Desai',
    ownerInitials: 'RD',
    lastContactedAt: '2026-11-03T16:20:00Z',
    nextFollowUpAt: '2026-11-06T15:30:00Z',
    firmSize: '6–20',
    software: ['Drake Tax', 'QuickBooks', 'Gusto'],
  },
  {
    id: 'lead_05',
    contactName: 'Sophie Tremblay',
    contactTitle: 'Operations Partner',
    email: 'stremblay@laurentian-cpa.example.ca',
    companyId: 'comp_05',
    companyName: 'Laurentian Advisory CPA',
    market: 'CA',
    status: 'Qualified',
    statusTone: 'success',
    source: 'Referral',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
    lastContactedAt: '2026-11-02T18:00:00Z',
    nextFollowUpAt: '2026-11-05T16:00:00Z',
    firmSize: '21–50',
    software: ['CaseWare', 'QuickBooks', 'Dext'],
  },
  {
    id: 'lead_06',
    contactName: 'Hannah Brooks',
    contactTitle: 'Founder & EA',
    email: 'hannah@brookstax.example.com',
    companyId: 'comp_06',
    companyName: 'Brooks Tax Practice',
    market: 'US',
    status: 'Researching',
    statusTone: 'neutral',
    source: 'Import',
    ownerName: 'Rohan Desai',
    ownerInitials: 'RD',
    lastContactedAt: null,
    nextFollowUpAt: '2026-11-07T14:00:00Z',
    firmSize: '1–5',
    software: ['ProSeries', 'QuickBooks'],
  },
  {
    id: 'lead_07',
    contactName: 'Liam O’Connor',
    contactTitle: 'Managing Director',
    email: 'loconnor@harbourfrontcpa.example.ca',
    companyId: 'comp_07',
    companyName: 'Harbourfront CPA Partners',
    market: 'CA',
    status: 'Engaged',
    statusTone: 'brand',
    source: 'Event',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
    lastContactedAt: '2026-11-03T20:10:00Z',
    nextFollowUpAt: '2026-11-05T14:30:00Z',
    firmSize: '51–200',
    software: ['NetSuite', 'CaseWare', 'ADP'],
  },
  {
    id: 'lead_08',
    contactName: 'Carlos Mendez',
    contactTitle: 'Client Accounting Lead',
    email: 'carlos.mendez@summitbooks.example.com',
    companyId: 'comp_08',
    companyName: 'Summit Bookkeeping Collective',
    market: 'US',
    status: 'Contacted',
    statusTone: 'neutral',
    source: 'LinkedIn (manual research)',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
    lastContactedAt: '2026-10-30T15:00:00Z',
    nextFollowUpAt: '2026-11-04T17:00:00Z',
    firmSize: '6–20',
    software: ['Xero', 'Bill.com', 'Dext'],
  },
];

export const SYNTHETIC_COMPANY_PROFILE: SyntheticCompanyProfile = {
  id: 'comp_01',
  name: 'Acme Tax & Advisory LLP',
  domain: 'acmetax.example.com',
  website: 'https://acmetax.example.com',
  market: 'US',
  country: 'United States',
  region: 'Illinois',
  city: 'Chicago',
  localTimeLabel: '9:30 am Chicago (9:00 pm IST)',
  firmType: 'CPA firm',
  sizeBand: '21–50',
  software: ['UltraTax CS', 'QuickBooks', 'SafeSend', 'Suralink'],
  accountStatus: 'Prospect',
  accountStatusTone: 'brand',
  ownerName: 'Arjun Mehta',
  annualRevenueMinor: 680_000_000n,
  revenueCurrency: 'USD',
  leadSource: 'Website: trial form',
  marketingBasis: 'Implied until 4 May 2027 (website inquiry)',
  contacts: [
    {
      id: 'ct_01',
      name: 'Jane Patel',
      title: 'Managing Partner · Decision maker',
      email: 'jane.patel@acmetax.example.com',
      phone: '+1 (312) 555-0142',
      isPrimary: true,
      verificationStatus: 'Valid email',
      verificationTone: 'success',
    },
    {
      id: 'ct_02',
      name: 'Grant Miller',
      title: 'Senior Tax Manager · Reviewer',
      email: 'grant.miller@acmetax.example.com',
      phone: '+1 (312) 555-0194',
      isPrimary: false,
      verificationStatus: 'Valid email',
      verificationTone: 'success',
    },
    {
      id: 'ct_03',
      name: 'Nadia Al-Mansoor',
      title: 'CAS Practice Lead · Influencer',
      email: 'nadia@acmetax.example.com',
      phone: '+1 (312) 555-0168',
      isPrimary: false,
      verificationStatus: 'Risky email',
      verificationTone: 'warning',
    },
  ],
  deals: [
    {
      id: 'deal_01',
      name: '2027 Tax Season Prep Pod (3 FTE)',
      stage: 'Free trial',
      monthlyValueMinor: 840_000n,
      currency: 'USD',
      fteCount: '3.0 FTE',
      engagementModel: 'Seasonal',
    },
    {
      id: 'deal_02',
      name: 'Monthly CAS Bookkeeping Support',
      stage: 'Discovery call',
      monthlyValueMinor: 280_000n,
      currency: 'USD',
      fteCount: '1.0 FTE',
      engagementModel: 'Full-time',
    },
  ],
  nextTask: {
    title: 'Review 3-day free trial workpapers with Jane Patel',
    dueLabel: 'Tomorrow, 9:30 am Chicago (9:00 pm IST)',
    assignee: 'Arjun Mehta',
    priority: 'High',
  },
  timeline: [
    {
      id: 'tl_01',
      dayGroup: 'TODAY',
      type: 'call',
      isUserAction: true,
      actor: 'Arjun Mehta',
      summary: 'logged a discovery call with Jane Patel (28 min)',
      timeLabel: '2 h ago',
      body: 'Walked through 1040 and 1120S workflow in UltraTax CS. Jane confirmed they want a 3-day free trial starting 5 Nov with two sample S-Corp workpapers and one multi-state partnership return. Security packet and SOC 2 summary shared during the call.',
    },
    {
      id: 'tl_02',
      dayGroup: 'TODAY',
      type: 'email',
      isUserAction: true,
      actor: 'Arjun Mehta',
      summary: 'sent an email — Free trial scope & Suralink portal checklist',
      timeLabel: '3 h ago',
      emailMeta: {
        from: 'arjun.mehta@adasglobuspro.com',
        to: 'jane.patel@acmetax.example.com',
        subject: 'Free trial scope & Suralink portal checklist — Acme Tax & Advisory',
      },
      body: 'Hi Jane,\n\nThank you for the time earlier today. As discussed, our senior tax reviewer in Ahmedabad will prepare the two test 1120S returns inside your Suralink workspace over the 3-day trial window.\n\nBest regards,\nArjun Mehta',
    },
    {
      id: 'tl_03',
      dayGroup: 'TODAY',
      type: 'status_change',
      isUserAction: false,
      actor: 'System',
      summary: 'moved deal "2027 Tax Season Prep Pod (3 FTE)" from Discovery call to Free trial',
      timeLabel: '4 h ago',
    },
    {
      id: 'tl_04',
      dayGroup: '3 NOV 2026',
      type: 'note',
      isUserAction: true,
      actor: 'Priya Nair',
      summary: 'pinned a note on staffing requirements',
      timeLabel: 'Yesterday',
      body: 'Firm prepares ~1,400 individual and 420 business returns between Feb 1 and Apr 15. Primary bottleneck is senior review turnaround. They use SafeSend Returns for client delivery and require strict U.S. tax workpaper indexing conventions.\nLine 5: Prefer reviewers with at least 4 seasons of UltraTax CS experience and familiarity with Illinois & Wisconsin state filings.',
    },
    {
      id: 'tl_05',
      dayGroup: '3 NOV 2026',
      type: 'system',
      isUserAction: false,
      actor: 'Website intake',
      summary: 'created lead from Free-trial form and started 1-business-day SLA clock',
      timeLabel: 'Yesterday',
    },
  ],
};

export const KANBAN_STAGES: SyntheticKanbanStage[] = [
  {
    id: 'stage_new',
    name: 'New opportunity',
    probability: 10,
    category: 'open',
    requiredOnEntry: ['Company', 'Primary contact', 'Owner'],
  },
  {
    id: 'stage_discovery',
    name: 'Discovery call',
    probability: 20,
    category: 'open',
    requiredOnEntry: ['Meeting date'],
  },
  {
    id: 'stage_trial',
    name: 'Free trial',
    probability: 40,
    category: 'open',
    requiredOnEntry: ['Trial start date', 'Trial end date', 'Trial scope'],
  },
  {
    id: 'stage_proposal',
    name: 'Proposal sent',
    probability: 60,
    category: 'open',
    requiredOnEntry: ['Proposal link or file', 'Monthly value'],
  },
  {
    id: 'stage_negotiation',
    name: 'Negotiation',
    probability: 80,
    category: 'open',
    requiredOnEntry: [],
  },
];

export const INITIAL_KANBAN_DEALS: SyntheticDealCard[] = [
  {
    id: 'deal_k1',
    stageId: 'stage_new',
    companyName: 'Ridgeway CPA Group',
    dealName: 'Audit Support Specialist (2 FTE)',
    market: 'US',
    currency: 'USD',
    monthlyValueMinor: 560_000n,
    termMonths: 12,
    fteLabel: '2.0 FTE',
    engagementModel: 'Full-time',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
  },
  {
    id: 'deal_k2',
    stageId: 'stage_new',
    companyName: 'Summit Bookkeeping Collective',
    dealName: 'AP/AR & Month-End Close Pod',
    market: 'US',
    currency: 'USD',
    monthlyValueMinor: 320_000n,
    termMonths: 12,
    fteLabel: '1.5 FTE',
    engagementModel: 'Part-time',
    ownerName: 'Rohan Desai',
    ownerInitials: 'RD',
  },
  {
    id: 'deal_k3',
    stageId: 'stage_discovery',
    companyName: 'Northstar Chartered Accountants',
    dealName: 'T1/T2 Tax Season Team (4 FTE)',
    market: 'CA',
    currency: 'CAD',
    monthlyValueMinor: 1_120_000n,
    termMonths: 6,
    fteLabel: '4.0 FTE',
    engagementModel: 'Seasonal',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
  },
  {
    id: 'deal_k4',
    stageId: 'stage_discovery',
    companyName: 'Acme Tax & Advisory LLP',
    dealName: 'Monthly CAS Bookkeeping Support',
    market: 'US',
    currency: 'USD',
    monthlyValueMinor: 280_000n,
    termMonths: 12,
    fteLabel: '1.0 FTE',
    engagementModel: 'Full-time',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
  },
  {
    id: 'deal_k5',
    stageId: 'stage_trial',
    companyName: 'Acme Tax & Advisory LLP',
    dealName: '2027 Tax Season Prep Pod (3 FTE)',
    market: 'US',
    currency: 'USD',
    monthlyValueMinor: 840_000n,
    termMonths: 6,
    fteLabel: '3.0 FTE',
    engagementModel: 'Seasonal',
    ownerName: 'Arjun Mehta',
    ownerInitials: 'AM',
    badgeText: 'Trial ends in 2 days',
    badgeTone: 'warning',
  },
  {
    id: 'deal_k6',
    stageId: 'stage_trial',
    companyName: 'Laurentian Advisory CPA',
    dealName: 'Dedicated Year-Round Senior Accountant',
    market: 'CA',
    currency: 'CAD',
    monthlyValueMinor: 420_000n,
    termMonths: 12,
    fteLabel: '1.0 FTE',
    engagementModel: 'Dedicated team',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
  },
  {
    id: 'deal_k7',
    stageId: 'stage_proposal',
    companyName: 'Harbourfront CPA Partners',
    dealName: 'Audit & Assurance Workpaper Team',
    market: 'CA',
    currency: 'CAD',
    monthlyValueMinor: 960_000n,
    termMonths: 12,
    fteLabel: '3.0 FTE',
    engagementModel: 'Dedicated team',
    ownerName: 'Priya Nair',
    ownerInitials: 'PN',
    badgeText: 'Idle 21 days',
    badgeTone: 'danger',
  },
  {
    id: 'deal_k8',
    stageId: 'stage_negotiation',
    companyName: 'Clearwater Accounting LLP',
    dealName: 'Full Back-Office Bookkeeping & Tax Pod',
    market: 'US',
    currency: 'USD',
    monthlyValueMinor: 750_000n,
    termMonths: 12,
    fteLabel: '2.5 FTE',
    engagementModel: 'Dedicated team',
    ownerName: 'Rohan Desai',
    ownerInitials: 'RD',
  },
];

export interface CommandPaletteItem {
  id: string;
  group: 'RECORDS' | 'ACTIONS' | 'NAVIGATION';
  label: string;
  meta: string;
  shortcut?: string;
  targetScreen?: 'leads' | 'company' | 'deals' | 'empty' | 'login';
}

export const COMMAND_PALETTE_ITEMS: CommandPaletteItem[] = [
  {
    id: 'cmd_rec_1',
    group: 'RECORDS',
    label: 'Acme Tax & Advisory LLP',
    meta: 'Company · US · Chicago · Arjun Mehta',
    targetScreen: 'company',
  },
  {
    id: 'cmd_rec_2',
    group: 'RECORDS',
    label: 'Jane Patel · Acme Tax & Advisory LLP',
    meta: 'Lead · Qualified · US',
    targetScreen: 'leads',
  },
  {
    id: 'cmd_rec_3',
    group: 'RECORDS',
    label: 'Northstar Chartered Accountants',
    meta: 'Company · CA · Toronto · Priya Nair',
    targetScreen: 'company',
  },
  {
    id: 'cmd_rec_4',
    group: 'RECORDS',
    label: '2027 Tax Season Prep Pod (3 FTE)',
    meta: 'Deal · Free trial · US$8.4k/mo',
    targetScreen: 'deals',
  },
  {
    id: 'cmd_act_1',
    group: 'ACTIONS',
    label: 'New lead',
    meta: 'Create a qualification record',
    shortcut: 'N',
    targetScreen: 'leads',
  },
  {
    id: 'cmd_act_2',
    group: 'ACTIONS',
    label: 'New deal',
    meta: 'Add opportunity to New business pipeline',
    targetScreen: 'deals',
  },
  {
    id: 'cmd_act_3',
    group: 'ACTIONS',
    label: 'Log call',
    meta: 'Record a discovery or follow-up call on timeline',
    shortcut: 'L C',
    targetScreen: 'company',
  },
  {
    id: 'cmd_nav_1',
    group: 'NAVIGATION',
    label: 'Go to Leads',
    meta: 'Records · 12,480 leads',
    shortcut: 'G L',
    targetScreen: 'leads',
  },
  {
    id: 'cmd_nav_2',
    group: 'NAVIGATION',
    label: 'Go to Companies (Acme Tax & Advisory LLP)',
    meta: 'Records · Company profile & timeline',
    shortcut: 'G O',
    targetScreen: 'company',
  },
  {
    id: 'cmd_nav_3',
    group: 'NAVIGATION',
    label: 'Go to Deals Kanban',
    meta: 'Records · New business pipeline',
    shortcut: 'G D',
    targetScreen: 'deals',
  },
  {
    id: 'cmd_nav_4',
    group: 'NAVIGATION',
    label: 'Go to Empty state view',
    meta: 'Design system · Empty state with glass-tile cluster',
    targetScreen: 'empty',
  },
  {
    id: 'cmd_nav_5',
    group: 'NAVIGATION',
    label: 'Go to Sign-in screen',
    meta: 'Authentication · Entra SSO & break-glass admin',
    targetScreen: 'login',
  },
];
