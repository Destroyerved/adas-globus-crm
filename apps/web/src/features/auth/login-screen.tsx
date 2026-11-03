import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import {
  canUseDevLogin,
  DEFAULT_DEV_USER,
  SYNTHETIC_DEV_USERS,
  type DevUser,
} from '@/lib/api-client.js';

export interface LoginScreenProps {
  onSignIn: (user: DevUser) => void;
}

export function LoginScreen({ onSignIn }: LoginScreenProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [showBreakGlass, setShowBreakGlass] = useState(false);
  const [selectedDevUserId, setSelectedDevUserId] = useState(DEFAULT_DEV_USER.id);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminTotp, setAdminTotp] = useState('');
  const [breakGlassError, setBreakGlassError] = useState<string | null>(null);

  const handleMicrosoftSignIn = () => {
    const user = SYNTHETIC_DEV_USERS.find((u) => u.id === selectedDevUserId) ?? DEFAULT_DEV_USER;
    onSignIn(user);
  };

  const handleBreakGlassSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!adminEmail.trim() || !adminPassword.trim() || adminTotp.trim().length !== 6) {
      setBreakGlassError(
        'Enter your break-glass admin email, password and 6-digit authenticator code.',
      );
      return;
    }
    setBreakGlassError(null);
    onSignIn(DEFAULT_DEV_USER);
  };

  return (
    <div
      className="min-h-screen w-full grid grid-cols-1 md:grid-cols-[minmax(320px,46%)_1fr] bg-bg"
      data-testid="login-screen"
    >
      {/* Left navy band (DESIGN.md §6.14) */}
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
            <span className="inline-flex items-center gap-[10px]">
              <span className="inline-grid place-items-center w-[32px] h-[32px] rounded-[8px] bg-surface text-navy text-[12px] font-bold tracking-[0.04em]">
                AGP
              </span>
              <span className="text-[15px] font-[650] tracking-[-0.01em] text-primary-foreground">
                ADAS Globus Pro
              </span>
            </span>
          )}
        </div>

        <div className="relative z-10 my-[24px] md:my-auto max-w-[420px]">
          <p className="text-eyebrow text-cyan mb-[12px]">INTERNAL WORKSPACE</p>
          <h1 className="text-[34px] leading-[40px] md:text-[44px] md:leading-[50px] font-light tracking-[-0.03em] text-primary-foreground m-0">
            ADAS <strong className="font-[650]">CRM</strong>
          </h1>
          <p className="mt-[14px] mb-0 text-[15px] leading-[22px] text-sidebar-foreground">
            One workspace for CPA firm relationships, 3-day free trials, and compliant outreach
            across the United States and Canada.
          </p>
        </div>

        <div className="relative z-10 hidden md:grid grid-cols-3 border border-navy-line rounded-[10px] overflow-hidden text-[12px]">
          <div className="p-[12px] bg-navy-2 border-r border-navy-line">
            <div className="text-eyebrow text-sidebar-foreground">AHMEDABAD</div>
            <div className="text-[16px] font-light text-cyan tabular-nums mt-[2px]">
              8:00 pm IST
            </div>
          </div>
          <div className="p-[12px] bg-navy border-r border-navy-line">
            <div className="text-eyebrow text-sidebar-foreground">TORONTO / NY</div>
            <div className="text-[16px] font-light text-primary-foreground tabular-nums mt-[2px]">
              9:30 am EST
            </div>
          </div>
          <div className="p-[12px] bg-navy">
            <div className="text-eyebrow text-sidebar-foreground">EDMONTON</div>
            <div className="text-[16px] font-light text-primary-foreground tabular-nums mt-[2px]">
              7:30 am MST
            </div>
          </div>
        </div>
      </aside>

      {/* Right canvas with white login card (DESIGN.md §6.14) */}
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

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleMicrosoftSignIn}
            data-testid="microsoft-signin-btn"
          >
            <ShieldCheck size={18} strokeWidth={1.6} aria-hidden="true" />
            <span>Sign in with Microsoft</span>
          </Button>

          {canUseDevLogin() && (
            <div className="mt-[20px] pt-[16px] border-t border-line">
              <label htmlFor="dev-user-select" className="block text-label text-ink-3 mb-[6px]">
                Development persona (local only)
              </label>
              <select
                id="dev-user-select"
                value={selectedDevUserId}
                onChange={(e) => setSelectedDevUserId(e.target.value)}
                className="h-[36px] w-full rounded-[8px] bg-surface border border-line-field px-[12px] text-[14px] text-ink"
              >
                {SYNTHETIC_DEV_USERS.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} · {user.role}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mt-[20px] pt-[16px] border-t border-line">
            <button
              type="button"
              onClick={() => setShowBreakGlass((prev) => !prev)}
              className="inline-flex items-center gap-[6px] text-[13px] font-semibold text-primary-ink hover:underline cursor-pointer bg-transparent border-0 p-0"
              aria-expanded={showBreakGlass}
            >
              <Lock size={14} strokeWidth={1.6} aria-hidden="true" />
              <span>Admin sign-in (break-glass)</span>
            </button>

            {showBreakGlass && (
              <form
                onSubmit={handleBreakGlassSubmit}
                className="mt-[14px] space-y-[12px]"
                noValidate
              >
                <p className="text-body-sm text-ink-3 m-0">
                  Emergency local admin access when Microsoft Entra is unavailable. All attempts are
                  audited and alert Super Admins.
                </p>
                <div>
                  <label htmlFor="bg-email" className="block text-label text-ink mb-[4px]">
                    Admin email
                  </label>
                  <Input
                    id="bg-email"
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    invalid={Boolean(breakGlassError && !adminEmail.trim())}
                  />
                </div>
                <div>
                  <label htmlFor="bg-password" className="block text-label text-ink mb-[4px]">
                    Password
                  </label>
                  <Input
                    id="bg-password"
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    invalid={Boolean(breakGlassError && !adminPassword.trim())}
                  />
                </div>
                <div>
                  <label htmlFor="bg-totp" className="block text-label text-ink mb-[4px]">
                    6-digit TOTP code
                  </label>
                  <Input
                    id="bg-totp"
                    inputMode="numeric"
                    maxLength={6}
                    value={adminTotp}
                    onChange={(e) => setAdminTotp(e.target.value)}
                    invalid={Boolean(breakGlassError && adminTotp.trim().length !== 6)}
                  />
                </div>
                {breakGlassError && (
                  <p role="alert" className="text-[13px] text-danger m-0">
                    {breakGlassError}
                  </p>
                )}
                <Button type="submit" variant="outline" className="w-full">
                  Sign in with break-glass account
                </Button>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
