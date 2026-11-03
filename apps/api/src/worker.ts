import { validateEnv } from './platform/config/index.js';
import { createLogger } from './platform/logger/index.js';

const env = validateEnv();
const logger = createLogger(env.LOG_LEVEL);

logger.info({ env: env.NODE_ENV, mailLive: env.MAIL_LIVE }, 'ADAS CRM worker process ready');
