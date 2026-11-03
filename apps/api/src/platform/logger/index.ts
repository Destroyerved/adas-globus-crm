import pino, { type Logger } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.email',
  '*.emailNormalized',
  '*.phone',
  '*.phoneRaw',
  '*.phoneE164',
  '*.body',
  '*.bodyHtml',
  '*.bodyText',
  '*.token',
  '*.password',
  '*.secret',
];

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  });
}
