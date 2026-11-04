import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { canUseDevLogin, DEV_SIGN_IN_USERS } from '@/lib/api-client.js';
import { api } from '@/lib/api.js';
import { errorMessage } from '@/features/shared/live-kit.js';

/** Messages for the ?error= codes the sign-in callback can return (PRD 6.6). */
const SIGN_IN_ERRORS: Record<string, string> = {
  sso_not_configured:
    'Microsoft sign-in isn’t set up yet. An admin needs to add the Entra app registration.',
  user_not_invited: 'Your Microsoft account hasn’t been invited to ADAS CRM. Ask an admin.',
  entra_account_mismatch:
    'This CRM user is linked to a different Microsoft account. Ask an admin to check it.',
  sso_failed: 'Microsoft sign-in didn’t complete. Try again.',
};

const CLOCKS = [
  { label: 'AHMEDABAD', zone: 'Asia/Kolkata' },
  { label: 'TORONTO', zone: 'America/Toronto' },
  { label: 'EDMONTON', zone: 'America/Edmonton' },
];

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function LoginScreen({
  microsoftSignIn,
  devSignIn,
  onSignedIn,
}: {
  microsoftSignIn: boolean;
  devSignIn: boolean;
  onSignedIn: () => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [devUserId, setDevUserId] = useState(DEV_SIGN_IN_USERS[0]?.id ?? '');
  const now = useNow();
  const errorCode = new URLSearchParams(window.location.search).get('error');
  const signInError = errorCode
    ? (SIGN_IN_ERRORS[errorCode] ?? SIGN_IN_ERRORS['sso_failed'])
    : null;

  const devLogin = useMutation({ mutationFn: api.devLogin, onSuccess: onSignedIn });

  return (
    <div
      className="min-h-screen w-full grid grid-cols-1 md:grid-cols-[minmax(320px,46%)_1fr] bg-bg"
      data-testid="login-screen"
    >
      <aside className="relative overflow-hidden bg-navy text-primary-foreground px-[24px] py-[28px] md:px-[48px] md:py-[48px] flex flex-col justify-between">
        <div className="band-tiles" aria-hidden="true">
          <i style={{ '--x': 0, '--y': 0 } as React.CSSProperties} />
          <i style={{ '--x': 1, '--y': 0 } as React.CSSProperties} />
          <i style={{ '--x': 0, '--y': 1 } as React.CSSProperties} />
          <i style={{ '--x': 2, '--y': 0 } as React.CSSProperties} />
          <i style={{ '--x': 1, '--y': 1 } as React.CSSProperties} />
        </div>

        <div className="relative z-10 flex items-center gap-[12px]">
          {!logoFailed ? (
            <img
              src="/assets/img/logo.avif"
              alt="ADAS Globus Pro"
              className="h-[36px] w-auto brightness-0 invert"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-[15px] font-[650] tracking-[-0.01em]">ADAS Globus Pro</span>
          )}
        </div>

        <div className="relative z-10 my-[24px] md:my-auto max-w-[420px]">
          <p className="text-eyebrow text-cyan mb-[12px]">INTERNAL WORKSPACE</p>
          <h1 className="text-[34px] leading-[40px] md:text-[44px] md:leading-[50px] font-light tracking-[-0.03em] m-0">
            ADAS <strong className="font-[650]">CRM</strong>
          </h1>
          <p className="mt-[14px] mb-0 text-[15px] leading-[22px] text-sidebar-foreground">
            One workspace for CPA firm relationships, 3-day free trials and follow-ups across the
            United States and Canada.
          </p>
        </div>

        <div className="relative z-10 hidden md:grid grid-cols-3 border border-navy-line rounded-[10px] overflow-hidden text-[12px]">
          {CLOCKS.map((clock, i) => (
            <div
              key={clock.zone}
              className={`p-[12px] ${i === 0 ? 'bg-navy-2' : 'bg-navy'} ${i < 2 ? 'border-r border-navy-line' : ''}`}
            >
              <div className="text-eyebrow text-sidebar-foreground">{clock.label}</div>
              <div
                className={`text-[16px] font-light tabular-nums mt-[2px] ${i === 0 ? 'text-cyan' : ''}`}
              >
                {new Intl.DateTimeFormat('en-US', {
                  timeZone: clock.zone,
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZoneName: 'short',
                })
                  .format(now)
                  .replace('AM', 'am')
                  .replace('PM', 'pm')}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex items-center justify-center p-[20px] md:p-[48px]">
        <div
          className="w-full max-w-[420px] bg-surface border border-line rounded-[14px] p-[28px] md:p-[36px]"
          style={{ boxShadow: 'var(--shadow-dialog)' }}
        >
          <div className="kicker mb-[8px]">Employee sign-in</div>
          <h2 className="text-title-lg text-ink m-0">Sign in to ADAS CRM</h2>
          <p className="text-body text-ink-2 mt-[6px] mb-[24px]">
            Use your <span className="font-semibold text-ink">@adasglobuspro.com</span> Microsoft
            365 account. Access is restricted to invited employees.
          </p>

          {signInError && (
            <p role="alert" className="mb-[16px] mt-0 text-[13.5px] text-danger">
              {signInError}
            </p>
          )}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!microsoftSignIn}
            onClick={() => window.location.assign('/api/v1/auth/sso/start')}
            data-testid="microsoft-signin-btn"
          >
            <ShieldCheck size={18} strokeWidth={1.6} aria-hidden="true" />
            <span>Sign in with Microsoft</span>
          </Button>
          {!microsoftSignIn && (
            <p className="mt-[8px] mb-0 text-[13px] text-ink-3">
              Not available yet: Microsoft sign-in needs the company’s Entra app registration.
            </p>
          )}

          {devSignIn && canUseDevLogin() && (
            <form
              className="mt-[20px] pt-[16px] border-t border-line grid gap-[8px]"
              onSubmit={(e) => {
                e.preventDefault();
                devLogin.mutate(devUserId);
              }}
            >
              <label htmlFor="dev-user-select" className="text-label text-ink-3">
                Development sign-in (this computer only)
              </label>
              <select
                id="dev-user-select"
                value={devUserId}
                onChange={(e) => setDevUserId(e.target.value)}
                className="h-[36px] w-full rounded-[8px] bg-surface border border-line-field px-[12px] text-[14px] text-ink"
              >
                {DEV_SIGN_IN_USERS.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} · {user.role}
                  </option>
                ))}
              </select>
              {devLogin.isError && (
                <p role="alert" className="m-0 text-[13px] text-danger">
                  {errorMessage(devLogin.error)}
                </p>
              )}
              <Button type="submit" variant="outline" disabled={devLogin.isPending}>
                {devLogin.isPending ? 'Signing in…' : 'Sign in as this user'}
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
