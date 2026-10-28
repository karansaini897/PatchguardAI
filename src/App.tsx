import React, { useCallback, useEffect, useState } from 'react';
import {
  ActiveScreen,
  AuthenticatedUser,
  DiagnosticEvent,
  EvaluationTestCase,
  FindingStatus,
  ProjectRecord,
  ReviewRecord,
  SourceRetentionMode,
  SystemHealthStatus,
} from './types/patchguard';
import { persistence } from './lib/persistence';
import { fetchSystemHealth } from './lib/apiClient';
import {
  createUserProject,
  deletePersistedReview,
  fetchPersistedReviews,
  isLiveSupabaseClientConfigured,
  restoreAuthSession,
  signInUser,
  signOutUser,
  supabase,
  updatePersistedFindingStatus,
} from './lib/supabaseClient';
import { ISOLATED_DEMO_REVIEW } from './lib/curatedData';
import { OverviewPage } from './components/OverviewPage';
import { NewReviewPage } from './components/NewReviewPage';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';
import { EvaluationLabPage } from './components/EvaluationLabPage';
import { SettingsAndDiagnosticsPage } from './components/SettingsAndDiagnosticsPage';
import { CommandPalette } from './components/CommandPalette';
import { AuthGatePanel } from './components/AuthGateModal';

const EXPLICIT_SIGNOUT_KEY = 'patchguard_explicit_signout_v1';

export default function App() {
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>('overview');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => persistence.getTheme());
  const [reviews, setReviews] = useState<ReviewRecord[]>(() => persistence.getReviews());
  const [activeReview, setActiveReview] = useState<ReviewRecord | null>(() => {
    const stored = persistence.getReviews();
    return stored.length > 0 ? stored[0] : null;
  });
  const [initialSelectedFindingId, setInitialSelectedFindingId] = useState<string | null>(null);
  const [evalCases, setEvalCases] = useState<EvaluationTestCase[]>(() =>
    persistence.getEvaluationCases()
  );
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>(() =>
    persistence.getDiagnostics()
  );
  const [health, setHealth] = useState<SystemHealthStatus | null>(null);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState<boolean>(false);

  // Supabase Auth & Project state
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [isReviewsLoading, setIsReviewsLoading] = useState<boolean>(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);

  const navigateToScreen = useCallback((screen: ActiveScreen) => {
    setActiveScreen(screen);
    setIsMobileNavOpen(false);
    setShowAuthModal(false);
  }, []);

  // Sync theme class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
    persistence.saveTheme(theme);
  }, [theme]);

  const refreshHealthAndDiagnostics = useCallback(async () => {
    const h = await fetchSystemHealth();
    setHealth(h);
    setDiagnostics(persistence.getDiagnostics());
  }, []);

  const syncReviewsForAuthenticatedUser = useCallback(
    async (user: AuthenticatedUser) => {
      setIsReviewsLoading(true);
      const res = await fetchPersistedReviews(user);
      setIsReviewsLoading(false);
      if (res.ok) {
        if (res.reviews.length > 0) {
          setReviews(res.reviews);
          res.reviews.forEach((r) => persistence.saveReview(r));
          setActiveReview((prev) => prev || res.reviews[0]);
        } else {
          // Keep any existing local reviews for this user or empty list
          const local = persistence.getReviews().filter(
            (r) => !r.ownerId || r.ownerId === user.id
          );
          setReviews(local);
        }
      } else if ((res as { ok: false; authExpired?: boolean }).authExpired) {
        setCurrentUser(null);
        setSessionExpiredMessage('Your session expired while loading reviews. Please sign in again.');
      }
    },
    []
  );

  // Restore session & subscribe to Supabase auth state changes
  useEffect(() => {
    let mounted = true;

    async function initAuth() {
      setIsAuthLoading(true);
      const restored = await restoreAuthSession();
      if (!mounted) return;

      if (restored.user) {
        setCurrentUser(restored.user);
        setProjects(restored.projects);
        if (restored.projects.length > 0) {
          setActiveProjectId(restored.projects[0].id);
        }
        await syncReviewsForAuthenticatedUser(restored.user);
        setIsAuthLoading(false);
        return;
      }

      if (restored.sessionExpired && restored.errorMessage) {
        setSessionExpiredMessage(restored.errorMessage);
      }

      // If running in local preview without external VITE_SUPABASE_URL and user hasn't explicitly signed out,
      // bootstrap the verified default developer session so live reviews and tests have a valid Bearer JWT.
      const explicitlySignedOut =
        typeof window !== 'undefined' &&
        window.localStorage?.getItem(EXPLICIT_SIGNOUT_KEY) === '1';

      if (!isLiveSupabaseClientConfigured && !explicitlySignedOut && !restored.sessionExpired) {
        const autoSignIn = await signInUser('engineer@patchguard.dev', 'PatchGuard!2026');
        if (mounted && autoSignIn.ok) {
          setCurrentUser(autoSignIn.user);
          setProjects(autoSignIn.projects);
          if (autoSignIn.projects.length > 0) {
            setActiveProjectId(autoSignIn.projects[0].id);
          }
          await syncReviewsForAuthenticatedUser(autoSignIn.user);
        }
      }

      if (mounted) {
        setIsAuthLoading(false);
      }
    }

    initAuth();

    if (supabase) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (!mounted) return;
        if (event === 'SIGNED_OUT' || !session?.user) {
          setCurrentUser(null);
          setProjects([]);
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          const user: AuthenticatedUser = {
            id: session.user.id,
            email: session.user.email || 'user@supabase.io',
            accessToken: session.access_token,
            expiresAt: session.expires_at ? session.expires_at * 1000 : undefined,
            authProvider: 'supabase-jwt',
          };
          setCurrentUser(user);
          setSessionExpiredMessage(null);
        }
      });

      return () => {
        mounted = false;
        subscription.unsubscribe();
      };
    }

    return () => {
      mounted = false;
    };
  }, [syncReviewsForAuthenticatedUser]);

  useEffect(() => {
    refreshHealthAndDiagnostics();
  }, [refreshHealthAndDiagnostics]);

  // Global Cmd/Ctrl + K shortcut for Command Palette and Escape for mobile nav drawer
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      } else if (e.key === 'Escape' && isMobileNavOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setIsMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isMobileNavOpen]);

  const handleAuthenticatedSuccess = async (
    user: AuthenticatedUser,
    userProjects: ProjectRecord[]
  ) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(EXPLICIT_SIGNOUT_KEY);
    }
    setCurrentUser(user);
    setProjects(userProjects);
    if (userProjects.length > 0) {
      setActiveProjectId(userProjects[0].id);
    }
    setSessionExpiredMessage(null);
    setShowAuthModal(false);
    await syncReviewsForAuthenticatedUser(user);
  };

  const handleSignOut = async () => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1');
    }
    await signOutUser();
    setCurrentUser(null);
    setProjects([]);
    setReviews([]);
    if (activeReview && !activeReview.isDemoRecord) {
      setActiveReview(null);
    }
  };

  const handleCreateProject = async (input: {
    name: string;
    repository: string;
    retentionMode: SourceRetentionMode;
  }): Promise<ProjectRecord | null> => {
    const res = await createUserProject(input, currentUser);
    if (res.ok) {
      setProjects((prev) => [res.project, ...prev]);
      setActiveProjectId(res.project.id);
      return res.project;
    }
    return null;
  };

  const handleReviewCompleted = (newReview: ReviewRecord) => {
    persistence.saveReview(newReview);
    setReviews((prev) => [newReview, ...prev.filter((r) => r.id !== newReview.id)]);
    setActiveReview(newReview);
    setInitialSelectedFindingId(newReview.findings[0]?.id || null);
    setDiagnostics(persistence.getDiagnostics());
    setPersistenceNotice(
      `Saved review ${newReview.id} (${newReview.findings.length} finding(s)) under project "${
        newReview.projectName || 'Core Engineering Repository'
      }".`
    );
    navigateToScreen('workspace');
  };

  const handleOpenReview = (review: ReviewRecord, findingId?: string) => {
    setActiveReview(review);
    setInitialSelectedFindingId(findingId || review.findings[0]?.id || null);
    navigateToScreen('workspace');
  };

  const handleLoadIsolatedDemo = () => {
    // Keep demonstration data isolated from stored review history unless explicitly inspected in workspace
    setActiveReview(ISOLATED_DEMO_REVIEW);
    setInitialSelectedFindingId(ISOLATED_DEMO_REVIEW.findings[0]?.id || null);
    navigateToScreen('workspace');
  };

  const handleUpdateFindingStatus = async (
    reviewId: string,
    findingId: string,
    nextStatus: FindingStatus
  ) => {
    if (activeReview && activeReview.id === reviewId && activeReview.isDemoRecord) {
      const now = new Date().toISOString();
      setActiveReview({
        ...activeReview,
        findings: activeReview.findings.map((f) =>
          f.id === findingId ? { ...f, status: nextStatus, updatedAt: now } : f
        ),
      });
      return;
    }

    // Optimistic local update
    const updatedLocal = persistence.updateFindingStatus(reviewId, findingId, nextStatus);
    if (updatedLocal) {
      setReviews((prev) => prev.map((r) => (r.id === reviewId ? updatedLocal : r)));
      if (activeReview?.id === reviewId) {
        setActiveReview(updatedLocal);
      }
    }

    // Persist to Supabase / RLS backend
    if (currentUser) {
      const persisted = await updatePersistedFindingStatus(
        reviewId,
        findingId,
        nextStatus,
        currentUser
      );
      if (persisted.ok && persisted.review) {
        persistence.saveReview(persisted.review);
        setReviews((prev) =>
          prev.map((r) => (r.id === reviewId ? persisted.review! : r))
        );
        if (activeReview?.id === reviewId) {
          setActiveReview(persisted.review);
        }
      }
    }
  };

  const handleDeleteReview = async (reviewId: string) => {
    const next = persistence.deleteReview(reviewId);
    setReviews((prev) => prev.filter((r) => r.id !== reviewId));
    if (activeReview?.id === reviewId) {
      setActiveReview(next[0] || null);
    }
    if (currentUser) {
      await deletePersistedReview(reviewId, currentUser);
    }
  };

  const handleClearAllReviews = async () => {
    const toDelete = [...reviews];
    persistence.clearAllReviews();
    setReviews([]);
    if (activeReview && !activeReview.isDemoRecord) {
      setActiveReview(null);
    }
    if (currentUser) {
      for (const r of toDelete) {
        await deletePersistedReview(r.id, currentUser);
      }
    }
  };

  const handleUpdateEvalCases = (nextCases: EvaluationTestCase[]) => {
    persistence.saveEvaluationCases(nextCases);
    setEvalCases(nextCases);
    setDiagnostics(persistence.getDiagnostics());
  };

  const handleResetEvalSuite = () => {
    const fresh = persistence.resetEvaluationCases();
    setEvalCases(fresh);
  };

  const navItems: Array<{
    id: ActiveScreen;
    label: string;
    shortLabel: string;
    description: string;
  }> = [
    {
      id: 'overview',
      label: 'Overview',
      shortLabel: 'Overview',
      description: 'System status, attention queue & recent review activity',
    },
    {
      id: 'workspace',
      label: 'Workspace',
      shortLabel: 'Workspace',
      description: 'Three-pane source code, findings & evidence investigation',
    },
    {
      id: 'history',
      label: 'History',
      shortLabel: 'History',
      description: 'Audit ledger of stored code review records',
    },
    {
      id: 'evaluation-lab',
      label: 'Evaluation Lab',
      shortLabel: 'Eval Lab',
      description: 'Precision, recall & location-validity benchmark suite',
    },
    {
      id: 'settings',
      label: 'Settings',
      shortLabel: 'Settings',
      description: 'Live Gemini probe, theme preferences & local storage controls',
    },
  ];

  const primaryMobileNavItems = navItems.slice(0, 3);
  const secondaryMobileNavItems = navItems.slice(3);
  const isSecondaryMobileRouteActive =
    activeScreen === 'evaluation-lab' || activeScreen === 'settings';
  const activeSecondaryLabel =
    activeScreen === 'evaluation-lab'
      ? 'Eval Lab'
      : activeScreen === 'settings'
      ? 'Settings'
      : 'More';

  const screenTitles: Record<ActiveScreen, string> = {
    overview: 'Overview',
    'new-review': 'New Code Review',
    workspace: 'Review Workspace',
    history: 'Review History',
    'evaluation-lab': 'Evaluation Lab',
    settings: 'Settings & Diagnostics',
  };

  // Protected routes require an active authenticated user session
  const isProtectedScreen = activeScreen === 'new-review' || activeScreen === 'history';
  const shouldRenderAuthGate =
    showAuthModal || (!isAuthLoading && !currentUser && isProtectedScreen);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--pg-bg-canvas)] text-[var(--pg-text-primary)] overflow-x-hidden">
      {/* Application Header: Single-row on >= 768px, Intentional Two-Tier on < 768px */}
      <header className="border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] shrink-0">
        <div className="h-12 md:h-[3.25rem] flex items-center justify-between gap-3 md:gap-8 px-3 sm:px-6">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              navigateToScreen('overview');
            }}
            className="text-sm sm:text-base font-bold tracking-tight text-[var(--pg-text-primary)] whitespace-nowrap shrink-0"
          >
            PatchGuard AI
          </a>

          {/* Zone 2 (Desktop >= 768px): 5 concise single-line text navigation links */}
          <nav
            aria-label="Primary workspace navigation"
            className="hidden md:flex items-center gap-5 py-1 text-xs font-medium text-[var(--pg-text-secondary)] min-w-0"
          >
            {navItems.map((item) => {
              const isCurrent = activeScreen === item.id && !showAuthModal;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigateToScreen(item.id);
                  }}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 underline-offset-8 ${
                    isCurrent
                      ? 'text-[var(--pg-text-primary)] underline decoration-[var(--pg-accent)] decoration-2 font-semibold'
                      : 'hover:text-[var(--pg-text-primary)] hover:underline'
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>

          {/* Zone 3: Primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => navigateToScreen('new-review')}
              className="px-3 sm:px-3.5 py-1.5 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              New Review
            </button>
          </div>
        </div>

        {/* Mobile / Narrow Primary Navigation (< 768px) */}
        <nav
          aria-label="Mobile workspace navigation"
          className="md:hidden border-t border-[var(--pg-border-subtle)] bg-[var(--pg-bg-workspace)] text-xs font-medium"
        >
          {/* Compact 4-column bar on < 640px (320px & 390px) */}
          <div className="grid grid-cols-4 sm:hidden">
            {primaryMobileNavItems.map((item) => {
              const isCurrent = activeScreen === item.id && !showAuthModal;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigateToScreen(item.id);
                  }}
                  className={`py-2.5 px-1.5 text-center whitespace-nowrap border-b-2 transition-colors ${
                    isCurrent
                      ? 'border-[var(--pg-accent)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] font-semibold'
                      : 'border-transparent text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
                  }`}
                >
                  {item.shortLabel}
                </a>
              );
            })}

            <button
              type="button"
              aria-expanded={isMobileNavOpen}
              aria-controls="pg-mobile-nav-drawer"
              aria-label={`More navigation destinations (${activeSecondaryLabel})`}
              onClick={() => setIsMobileNavOpen((prev) => !prev)}
              className={`py-2.5 px-1.5 text-center whitespace-nowrap border-b-2 transition-colors inline-flex items-center justify-center gap-1 cursor-pointer ${
                isSecondaryMobileRouteActive || isMobileNavOpen
                  ? 'border-[var(--pg-accent)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] font-semibold'
                  : 'border-transparent text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
              }`}
            >
              <span>{activeSecondaryLabel}</span>
              <span aria-hidden="true" className="text-[10px] leading-none">
                {isMobileNavOpen ? '▴' : '▾'}
              </span>
            </button>
          </div>

          {/* Expandable Accessible Destination Drawer for < 640px */}
          {isMobileNavOpen && (
            <div
              id="pg-mobile-nav-drawer"
              role="region"
              aria-label="Additional workspace destinations"
              className="sm:hidden border-t border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-2.5 space-y-1.5"
            >
              <div className="px-2 py-0.5 font-mono text-[10px] text-[var(--pg-text-muted)] uppercase flex items-center justify-between">
                <span>All Workspace Destinations</span>
                <span>Esc to close</span>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {secondaryMobileNavItems.map((item) => {
                  const isCurrent = activeScreen === item.id && !showAuthModal;
                  return (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      aria-current={isCurrent ? 'page' : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        navigateToScreen(item.id);
                      }}
                      className={`px-3 py-2 border text-left transition-colors flex items-center justify-between gap-2 ${
                        isCurrent
                          ? 'border-[var(--pg-accent)] bg-[var(--pg-bg-elevated)] text-[var(--pg-text-primary)] font-semibold'
                          : 'border-[var(--pg-border-subtle)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold">{item.label}</div>
                        <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
                          {item.description}
                        </div>
                      </div>
                      <span className="font-mono text-xs text-[var(--pg-accent-text)] shrink-0">
                        {isCurrent ? 'Active' : 'Open →'}
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {/* 5-column comfortable bar on 640px-767px (sm) */}
          <div className="hidden sm:grid sm:grid-cols-5">
            {navItems.map((item) => {
              const isCurrent = activeScreen === item.id && !showAuthModal;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigateToScreen(item.id);
                  }}
                  className={`py-2 px-2 text-center whitespace-nowrap border-b-2 transition-colors ${
                    isCurrent
                      ? 'border-[var(--pg-accent)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] font-semibold'
                      : 'border-transparent text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
                  }`}
                >
                  {item.shortLabel}
                </a>
              );
            })}
          </div>
        </nav>
      </header>

      {/* Secondary Contextual Workspace Utility Bar (Below Header) */}
      <div className="border-b border-[var(--pg-border-subtle)] bg-[var(--pg-bg-workspace)] px-3 sm:px-6 py-1.5 flex items-center justify-between gap-2 text-[11px] font-mono text-[var(--pg-text-muted)] shrink-0">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <span className="text-[var(--pg-text-secondary)] font-medium whitespace-nowrap shrink-0">
            {showAuthModal ? 'Authentication' : screenTitles[activeScreen]}
          </span>
          {activeReview && !showAuthModal && (
            <>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <button
                type="button"
                onClick={() => navigateToScreen('workspace')}
                title={`Open active review in Workspace: ${activeReview.title} (${activeReview.id})`}
                className="text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] truncate min-w-0 cursor-pointer text-left"
              >
                Active:{' '}
                {activeReview.isDemoRecord &&
                !activeReview.title.toUpperCase().startsWith('[DEMO]')
                  ? '[Demo] '
                  : ''}
                {activeReview.title}
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3.5 shrink-0">
          {/* Authenticated User & Sign In / Sign Out Controls */}
          {isAuthLoading ? (
            <span className="text-[var(--pg-text-muted)] whitespace-nowrap">Auth⋯</span>
          ) : currentUser ? (
            <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span
                className="hidden lg:inline text-[var(--pg-success)]"
                title={`Signed in as ${currentUser.email} (${currentUser.authProvider})`}
              >
                ● {currentUser.email}
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                title={`Sign out of ${currentUser.email}`}
                className="text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] transition-colors cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAuthModal(true)}
              className="text-[var(--pg-accent-text)] font-semibold hover:underline whitespace-nowrap cursor-pointer"
            >
              Sign In
            </button>
          )}

          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setIsCommandPaletteOpen(true)}
            aria-label="Open Command Palette (Shortcut Command+K or Control+K)"
            className="hover:text-[var(--pg-text-primary)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span className="sm:hidden">⌘K</span>
            <span className="hidden sm:inline">Command Palette (⌘K)</span>
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            aria-label={`Switch visual theme, currently ${theme === 'dark' ? 'Dark Graphite' : 'Light Editorial'}`}
            className="hover:text-[var(--pg-text-primary)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span className="sm:hidden">{theme === 'dark' ? 'Dark' : 'Light'}</span>
            <span className="hidden sm:inline">
              Theme: {theme === 'dark' ? 'Dark Graphite' : 'Light Editorial'}
            </span>
          </button>
        </div>
      </div>

      {/* Persistence / Sync Status Toast Banner */}
      {persistenceNotice && (
        <div
          role="status"
          className="border-b border-[var(--pg-border-subtle)] bg-[var(--pg-bg-surface)] px-3 sm:px-6 py-1.5 flex items-center justify-between gap-2 text-xs font-mono text-[var(--pg-success)]"
        >
          <span className="truncate">✓ {persistenceNotice}</span>
          <button
            type="button"
            onClick={() => setPersistenceNotice(null)}
            className="text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)] cursor-pointer shrink-0"
          >
            Dismiss ×
          </button>
        </div>
      )}

      {/* Main Application Viewport */}
      <main className="flex-1 flex flex-col min-h-0">
        {isAuthLoading && isProtectedScreen ? (
          <div className="max-w-xl mx-auto px-4 py-12 font-mono text-xs text-[var(--pg-text-secondary)]">
            Restoring authenticated Supabase session and RLS project context...
          </div>
        ) : shouldRenderAuthGate ? (
          <AuthGatePanel
            onAuthenticated={handleAuthenticatedSuccess}
            sessionExpiredMessage={sessionExpiredMessage}
            contextTitle={
              activeScreen === 'new-review'
                ? 'Sign In Required to Execute & Persist Code Reviews'
                : activeScreen === 'history'
                ? 'Sign In Required to View Protected Review History'
                : 'Sign In or Create a PatchGuard AI Account'
            }
            onInspectDemoWithoutAuth={handleLoadIsolatedDemo}
          />
        ) : (
          <>
            {activeScreen === 'overview' && (
              <OverviewPage
                reviews={reviews}
                health={health}
                onStartNewReview={() => setActiveScreen('new-review')}
                onOpenReview={handleOpenReview}
                onLoadIsolatedDemo={handleLoadIsolatedDemo}
                onOpenEvaluationLab={() => setActiveScreen('evaluation-lab')}
                onOpenDiagnostics={() => setActiveScreen('settings')}
                onOpenHistory={() => setActiveScreen('history')}
              />
            )}

            {activeScreen === 'new-review' && (
              <NewReviewPage
                onReviewCompleted={handleReviewCompleted}
                projects={projects}
                activeProjectId={activeProjectId}
                onSelectProject={setActiveProjectId}
                onCreateProject={handleCreateProject}
              />
            )}

            {activeScreen === 'workspace' && (
              <ReviewWorkspace
                review={activeReview}
                initialSelectedFindingId={initialSelectedFindingId}
                onUpdateFindingStatus={handleUpdateFindingStatus}
                onStartNewReview={() => setActiveScreen('new-review')}
                onLoadIsolatedDemo={handleLoadIsolatedDemo}
              />
            )}

            {activeScreen === 'history' && (
              <ReviewHistoryPage
                reviews={reviews}
                projects={projects}
                isLocalStorageAvailable={
                  !isReviewsLoading && persistence.isLocalStorageAvailable()
                }
                onOpenReview={(rev) => handleOpenReview(rev)}
                onDeleteReview={handleDeleteReview}
                onStartNewReview={() => setActiveScreen('new-review')}
              />
            )}

            {activeScreen === 'evaluation-lab' && (
              <EvaluationLabPage
                testCases={evalCases}
                onUpdateTestCases={handleUpdateEvalCases}
                onResetSuite={handleResetEvalSuite}
              />
            )}

            {activeScreen === 'settings' && (
              <SettingsAndDiagnosticsPage
                theme={theme}
                onChangeTheme={setTheme}
                health={health}
                onRefreshHealth={refreshHealthAndDiagnostics}
                diagnostics={diagnostics}
                onClearDiagnostics={() => {
                  persistence.clearDiagnostics();
                  setDiagnostics([]);
                }}
                reviews={reviews}
                onClearAllReviews={handleClearAllReviews}
              />
            )}
          </>
        )}
      </main>

      {/* Command Palette Modal */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNavigate={(screen) => navigateToScreen(screen)}
        onLoadIsolatedDemo={handleLoadIsolatedDemo}
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />
    </div>
  );
}
