import React, { useState } from 'react';
import type { AuthenticatedUser, ProjectRecord } from '../types/patchguard';
import {
  isLiveSupabaseClientConfigured,
  resetUserPassword,
  signInUser,
  signUpUser,
} from '../lib/supabaseClient';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';

interface AuthGatePanelProps {
  onAuthenticated: (user: AuthenticatedUser, projects: ProjectRecord[]) => void;
  sessionExpiredMessage?: string | null;
  contextTitle?: string;
  contextDescription?: string;
  onInspectDemoWithoutAuth?: () => void;
}

export const AuthGatePanel: React.FC<AuthGatePanelProps> = ({
  onAuthenticated,
  sessionExpiredMessage,
  contextTitle = 'Authenticated Engineer Session Required',
  contextDescription = 'Sign in or create an account to execute code reviews, manage repository projects, and persist verified findings under Row Level Security (RLS).',
  onInspectDemoWithoutAuth,
}) => {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState<string>('engineer@patchguard.dev');
  const [password, setPassword] = useState<string>('PatchGuard!2026');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setAuthError(null);
    setAuthNotice(null);

    if (!email.trim()) {
      setAuthError('Enter your email address.');
      return;
    }

    if (mode === 'reset') {
      setIsLoading(true);
      const resetRes = await resetUserPassword(email);
      setIsLoading(false);
      if (!resetRes.ok) {
        setAuthError((resetRes as { ok: false; error: string }).error);
        return;
      }
      setAuthNotice(resetRes.message);
      return;
    }

    if (password.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);
    const result =
      mode === 'signin'
        ? await signInUser(email, password)
        : await signUpUser(email, password);
    setIsLoading(false);

    if (!result.ok) {
      setAuthError((result as { ok: false; error: string }).error);
      return;
    }

    onAuthenticated(result.user, result.projects);
  };

  const handleQuickDeveloperSignIn = async () => {
    if (isLoading) return;
    setAuthError(null);
    setAuthNotice(null);
    setIsLoading(true);
    const result = await signInUser('engineer@patchguard.dev', 'PatchGuard!2026');
    setIsLoading(false);
    if (!result.ok) {
      setAuthError((result as { ok: false; error: string }).error);
      return;
    }
    onAuthenticated(result.user, result.projects);
  };

  return (
    <div className="max-w-xl w-full mx-auto px-4 py-8 sm:py-12">
      <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-5 sm:p-6 space-y-5">
        <div className="border-b border-[var(--pg-border-default)] pb-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--pg-text-muted)]">
            <span className="inline-flex items-center gap-1.5 text-[var(--pg-accent-text)] font-semibold">
              <Lock className="w-3.5 h-3.5" />
              <span>SUPABASE AUTH & RLS TENANT ISOLATION</span>
            </span>
            <span>
              {isLiveSupabaseClientConfigured
                ? 'Live Supabase Auth'
                : 'Local RLS Auth Mirror'}
            </span>
          </div>
          <h1 className="text-lg font-semibold text-[var(--pg-text-primary)]">
            {contextTitle}
          </h1>
          <p className="text-xs text-[var(--pg-text-secondary)] leading-relaxed">
            {contextDescription}
          </p>
        </div>

        {/* Expired Session Banner */}
        {sessionExpiredMessage && (
          <div
            role="alert"
            className="p-3 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] flex items-start gap-2.5 text-xs"
          >
            <AlertTriangle className="w-4 h-4 text-[var(--pg-warning)] shrink-0 mt-0.5" />
            <div>
              <div className="font-mono font-semibold text-[var(--pg-warning)]">
                SESSION EXPIRED OR INVALID
              </div>
              <div className="text-[var(--pg-text-secondary)]">{sessionExpiredMessage}</div>
            </div>
          </div>
        )}

        {/* Authentication Notice Banner */}
        {authNotice && (
          <div
            role="status"
            className="p-3 bg-[var(--pg-success-subtle)] border border-[var(--pg-border-default)] flex items-start gap-2.5 text-xs"
          >
            <CheckCircle2 className="w-4 h-4 text-[var(--pg-success)] shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-mono font-semibold text-[var(--pg-success)]">
                PASSWORD RECOVERY REQUESTED
              </div>
              <div className="text-[var(--pg-text-primary)]">{authNotice}</div>
            </div>
          </div>
        )}

        {/* Authentication Error Banner */}
        {authError && (
          <div
            role="alert"
            className="p-3 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] flex items-start gap-2.5 text-xs"
          >
            <AlertTriangle className="w-4 h-4 text-[var(--pg-danger)] shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-mono font-semibold text-[var(--pg-danger)]">
                AUTHENTICATION ERROR
              </div>
              <div className="text-[var(--pg-text-primary)]">{authError}</div>
            </div>
          </div>
        )}

        {/* Mode Switcher */}
        <div
          role="tablist"
          aria-label="Authentication mode"
          className="grid grid-cols-3 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] font-mono text-xs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            onClick={() => {
              setMode('signin');
              setAuthError(null);
              setAuthNotice(null);
            }}
            className={`py-2 px-2 text-center transition-colors cursor-pointer ${
              mode === 'signin'
                ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] font-semibold border-b-2 border-[var(--pg-accent)]'
                : 'text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            onClick={() => {
              setMode('signup');
              setAuthError(null);
              setAuthNotice(null);
              if (email === 'engineer@patchguard.dev') {
                setEmail('');
                setPassword('');
              }
            }}
            className={`py-2 px-2 text-center transition-colors cursor-pointer ${
              mode === 'signup'
                ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] font-semibold border-b-2 border-[var(--pg-accent)]'
                : 'text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
            }`}
          >
            Create Account
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'reset'}
            onClick={() => {
              setMode('reset');
              setAuthError(null);
              setAuthNotice(null);
            }}
            className={`py-2 px-2 text-center transition-colors cursor-pointer ${
              mode === 'reset'
                ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] font-semibold border-b-2 border-[var(--pg-accent)]'
                : 'text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
            }`}
          >
            Reset Password
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label
              htmlFor="pg-auth-email"
              className="block font-mono text-[11px] text-[var(--pg-text-secondary)] mb-1"
            >
              Engineer Email Address
            </label>
            <input
              id="pg-auth-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="engineer@company.com"
              className="w-full px-3 py-2 font-mono text-xs bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:border-[var(--pg-accent)] focus:outline-none"
            />
          </div>

          {mode !== 'reset' && (
            <div>
              <label
                htmlFor="pg-auth-password"
                className="block font-mono text-[11px] text-[var(--pg-text-secondary)] mb-1"
              >
                Password (minimum 8 characters)
              </label>
              <input
                id="pg-auth-password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full px-3 py-2 font-mono text-xs bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:border-[var(--pg-accent)] focus:outline-none"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>
                  {mode === 'signin'
                    ? 'Verifying Credentials...'
                    : mode === 'signup'
                    ? 'Provisioning Account...'
                    : 'Requesting Password Recovery...'}
                </span>
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4" />
                <span>
                  {mode === 'signin'
                    ? 'Sign In & Restore Projects'
                    : mode === 'signup'
                    ? 'Create Account & Initialize Project'
                    : 'Send Password Reset Link'}
                </span>
              </>
            )}
          </button>
        </form>

        {/* Honest Environment Configuration Disclosure & Quick Local Auth */}
        <div className="pt-3 border-t border-[var(--pg-border-subtle)] space-y-3 text-[11px]">
          <div className="p-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-1.5 font-mono">
            <div className="flex items-center gap-1.5 text-[var(--pg-info)] font-semibold">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>
                {isLiveSupabaseClientConfigured
                  ? 'Connected to Live Supabase Project (VITE_SUPABASE_URL configured)'
                  : 'Local RLS-Enforced Postgres Mirror Active (VITE_SUPABASE_URL not set)'}
              </span>
            </div>
            <p className="font-sans text-[var(--pg-text-secondary)] leading-relaxed">
              {isLiveSupabaseClientConfigured
                ? 'Credentials are verified directly against your Supabase Auth instance. Review records and findings are protected by PostgreSQL Row Level Security (auth.uid() = owner_id).'
                : 'External VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set in this preview environment. The backend server is enforcing Bearer JWT authentication, project ownership checks, and RLS tenant isolation locally.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {!isLiveSupabaseClientConfigured && (
              <button
                type="button"
                disabled={isLoading}
                onClick={handleQuickDeveloperSignIn}
                className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
              >
                Use Default Verified Session (engineer@patchguard.dev)
              </button>
            )}

            {onInspectDemoWithoutAuth && (
              <button
                type="button"
                onClick={onInspectDemoWithoutAuth}
                className="px-3 py-1.5 font-mono text-xs text-[var(--pg-info)] hover:underline cursor-pointer"
              >
                Inspect Read-Only Demo (PR #418) →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
