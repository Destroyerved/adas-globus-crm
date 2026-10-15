import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import './db.js';
import { authRoutes, userRoutes } from './routes/auth.js';
import { crmRoutes } from './routes/crm.js';
import { mailRoutes } from './routes/mail.js';
import { integrationRoutes } from './routes/integrations.js';
import { trackingRoutes, publicApiRoutes } from './routes/public.js';
import { startScheduler } from './scheduler.js';
import { getSettings } from './settings.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; connect-src 'self'; form-action 'self' https: http:; base-uri 'self'",
  });
  next();
});

// Public endpoints first: they set their own CORS and body parsing.
app.use('/api/public', publicApiRoutes);
app.use(trackingRoutes);

app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, name: `${getSettings('company').name} CRM`, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api', crmRoutes);
app.use('/api', mailRoutes);
app.use('/api', integrationRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` }));

// Revalidate on every load (ETag) so updates reach users immediately.
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  else if (status >= 500) console.warn(`[upstream] ${req.method} ${req.originalUrl}: ${err.message}`);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server' : err.message, ...(err.details || {}) });
});

app.listen(config.port, config.host, () => {
  console.log(`\n  ${getSettings('company').name} CRM running at ${config.baseUrl}`);
  console.log(`  Listening on ${config.host}:${config.port}  ·  data in ${path.relative(ROOT, path.dirname(config.dbFile)) || '.'}\n`);
  if (process.env.DISABLE_SCHEDULER !== 'true') startScheduler();
});
