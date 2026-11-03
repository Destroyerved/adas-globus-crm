import { z } from 'zod';
import { CurrencySchema } from '@adas/shared';

const booleanFromString = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((val) => val === true || val === 'true');

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5174),
    APP_INTERNAL_HOST: z.string().min(1).default('crm.adasglobuspro.com'),
    APP_PUBLIC_HOST: z.string().min(1).default('go.adasglobuspro.com'),
    PUBLIC_WEB_URL: z.string().url().default('http://localhost:5174'),
    PUBLIC_API_URL: z.string().url().default('http://localhost:3000/api/v1'),

    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://adas_app:adas_dev_password@localhost:5432/adas_crm?schema=public'),
    DATABASE_ADMIN_URL: z
      .string()
      .min(1)
      .default('postgresql://adas_admin:adas_admin_password@localhost:5432/adas_crm?schema=public'),

    MAIL_LIVE: booleanFromString.default(false),
    MAILPIT_SMTP_HOST: z.string().min(1).default('localhost'),
    MAILPIT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    MAILPIT_HTTP_URL: z.string().url().default('http://localhost:8025'),

    SESSION_IDLE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(12),
    SESSION_ABSOLUTE_TIMEOUT_DAYS: z.coerce.number().int().positive().default(7),
    SESSION_SECRET_FILE: z.string().min(1).default('./secrets/session_secret.txt'),

    TOKEN_ENCRYPTION_KEY_FILE: z.string().min(1).default('./secrets/token_encryption_key.txt'),
    TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

    ENTRA_TENANT_ID: z.string().min(1).default('00000000-0000-0000-0000-000000000000'),
    ENTRA_CLIENT_ID: z.string().min(1).default('00000000-0000-0000-0000-000000000000'),
    ENTRA_REDIRECT_URI: z.string().url().default('http://localhost:3000/api/v1/auth/sso/callback'),

    CF_ACCESS_TEAM_DOMAIN: z.string().min(1).default('adasglobuspro.cloudflareaccess.com'),
    CF_ACCESS_AUD: z
      .string()
      .min(1)
      .default('0000000000000000000000000000000000000000000000000000000000000000'),
    CF_ACCESS_ENFORCE: booleanFromString.default(false),

    FILE_STORAGE_DRIVER: z.enum(['local']).default('local'),
    FILE_STORAGE_LOCAL_PATH: z.string().min(1).default('./data/files'),
    MAX_IMPORT_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),
    MAX_ATTACHMENT_UPLOAD_BYTES: z.coerce.number().int().positive().default(20_971_520),

    INQUIRY_CORS_ORIGINS: z
      .string()
      .min(1)
      .default('https://www.adasglobuspro.com,https://adasglobuspro.com,http://localhost:5173'),

    DEFAULT_REPORTING_CURRENCY: CurrencySchema.default('USD'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    // Safety guardrail: Never send real email outside production (AGENTS.md §5, PRD §8.7)
    if (env.MAIL_LIVE && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_LIVE'],
        message: 'MAIL_LIVE=true is strictly forbidden when NODE_ENV is not production.',
      });
    }
  });

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(rawEnv: Record<string, string | undefined> = process.env): AppEnv {
  return EnvSchema.parse(rawEnv);
}

/**
 * Dev login is allowed only outside production builds/environments (AGENTS.md §6).
 */
export function isDevLoginEnabled(env: Pick<AppEnv, 'NODE_ENV'>): boolean {
  return env.NODE_ENV !== 'production';
}
