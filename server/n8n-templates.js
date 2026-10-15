// Catalogue of the n8n workflow templates in public/n8n/.
// trigger: 'crm'      → n8n Webhook fed by CRM events (the installer registers the CRM webhook for you)
//          'external' → n8n Webhook you point other tools at (forms, lead ads…)
//          'schedule' → runs on a timer
// fields: values asked for at install time; each key matches an assignment in the workflow's "CRM config" node.
export const N8N_TEMPLATES = [
  {
    slug: '01-new-lead-alert',
    title: 'New lead → Slack alert',
    description: 'Posts every new contact and website-form lead to a Slack channel.',
    trigger: 'crm',
    events: ['contact.created', 'form.submitted'],
    webhookPath: 'crm-new-lead',
    fields: [{ key: 'slack_webhook_url', label: 'Slack incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…', required: true }],
  },
  {
    slug: '02-website-form-to-crm',
    title: 'Any form → contact + sequence',
    description: 'A public n8n endpoint for Typeform, Webflow, Elementor or lead ads. Upserts the contact, tags it and enrolls it in a sequence.',
    trigger: 'external',
    webhookPath: 'lead-intake',
    fields: [
      { key: 'sequence_id', label: 'Enroll new leads in sequence', type: 'sequence' },
      { key: 'tags', label: 'Tags', placeholder: 'website,n8n' },
      { key: 'source', label: 'Source label', placeholder: 'Website form' },
    ],
  },
  {
    slug: '03-deal-won-handoff',
    title: 'Deal won → onboarding handoff',
    description: 'Creates an onboarding task, emails the customer a welcome note and posts the win to Slack.',
    trigger: 'crm',
    events: ['deal.won'],
    webhookPath: 'crm-deal-won',
    fields: [{ key: 'slack_webhook_url', label: 'Slack incoming webhook URL (optional)', placeholder: 'https://hooks.slack.com/services/…' }],
  },
  {
    slug: '04-reply-follow-up-task',
    title: 'Email reply → follow-up task',
    description: 'When a contact replies, creates an urgent task for their owner and moves new leads to qualified.',
    trigger: 'crm',
    events: ['email.replied'],
    webhookPath: 'crm-email-replied',
    fields: [],
  },
  {
    slug: '05-daily-task-digest',
    title: 'Daily task digest',
    description: 'Every weekday at 08:30, emails a list of overdue and due-today tasks.',
    trigger: 'schedule',
    fields: [{ key: 'digest_to', label: 'Send the digest to', type: 'email', default: 'me', required: true }],
  },
  {
    slug: '06-apollo-weekly-prospecting',
    title: 'Weekly Apollo prospecting',
    description: 'Every Monday, searches Apollo for your ideal customer profile and imports new people, tagged for review.',
    trigger: 'schedule',
    fields: [
      { key: 'titles', label: 'Job titles (separate with ;)', placeholder: 'CEO;Founder;Head of Procurement', required: true },
      { key: 'locations', label: 'Locations (separate with ;)', placeholder: 'India;United Arab Emirates' },
      { key: 'employee_ranges', label: 'Company sizes (separate with ;)', placeholder: '11,50;51,200' },
      { key: 'tags', label: 'Tags for imported people', placeholder: 'apollo,weekly-review' },
      { key: 'reveal_emails', label: 'Reveal emails (uses Apollo credits)', type: 'boolean', default: 'true' },
    ],
  },
  {
    slug: '07-task-due-reminder',
    title: 'Task due → Telegram reminder',
    description: 'Sends a Telegram message when a task becomes due.',
    trigger: 'crm',
    events: ['task.due'],
    webhookPath: 'crm-task-due',
    fields: [
      { key: 'telegram_bot_token', label: 'Telegram bot token (from @BotFather)', required: true },
      { key: 'telegram_chat_id', label: 'Telegram chat ID', required: true },
    ],
  },
];

export const templateBySlug = (slug) => N8N_TEMPLATES.find((t) => t.slug === slug);
