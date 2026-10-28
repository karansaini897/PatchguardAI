import React, { useCallback, useEffect, useState } from 'react';
import {
  ActiveScreen,
  DiagnosticEvent,
  EvaluationTestCase,
  FindingStatus,
  ReviewRecord,
  SystemHealthStatus,
} from './types/patchguard';
import { persistence } from './lib/persistence';
import { fetchSystemHealth } from './lib/apiClient';
import { ISOLATED_DEMO_REVIEW } from './lib/curatedData';
import { OverviewPage } from './components/OverviewPage';
import { NewReviewPage } from './components/NewReviewPage';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';
import { EvaluationLabPage } from './components/EvaluationLabPage';
import { SettingsAndDiagnosticsPage } from './components/SettingsAndDiagnosticsPage';
import { CommandPalette } from './components/CommandPalette';

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

  const navigateToScreen = useCallback((screen: ActiveScreen) => {
    setActiveScreen(screen);
    setIsMobileNavOpen(false);
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

  const handleReviewCompleted = (newReview: ReviewRecord) => {
    persistence.saveReview(newReview);
    const updatedList = persistence.getReviews();
    setReviews(updatedList);
    setActiveReview(newReview);
    setInitialSelectedFindingId(newReview.findings[0]?.id || null);
    setDiagnostics(persistence.getDiagnostics());
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

  const handleUpdateFindingStatus = (
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

    const updated = persistence.updateFindingStatus(reviewId, findingId, nextStatus);
    if (updated) {
      setReviews(persistence.getReviews());
      if (activeReview?.id === reviewId) {
        setActiveReview(updated);
      }
    }
  };

  const handleDeleteReview = (reviewId: string) => {
    const next = persistence.deleteReview(reviewId);
    setReviews(next);
    if (activeReview?.id === reviewId) {
      setActiveReview(next[0] || null);
    }
  };

  const handleClearAllReviews = () => {
    persistence.clearAllReviews();
    setReviews([]);
    if (activeReview && !activeReview.isDemoRecord) {
      setActiveReview(null);
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
              const isCurrent = activeScreen === item.id;
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

        {/* Mobile / Narrow Primary Navigation (< 768px):
            At < 640px (320px/390px): 3 primary tabs + accessible "More" disclosure at comfortable 12px (text-xs).
            At 640px-767px (sm): 5 comfortable tabs at 12px (text-xs). */}
        <nav
          aria-label="Mobile workspace navigation"
          className="md:hidden border-t border-[var(--pg-border-subtle)] bg-[var(--pg-bg-workspace)] text-xs font-medium"
        >
          {/* Compact 4-column bar on < 640px (320px & 390px) */}
          <div className="grid grid-cols-4 sm:hidden">
            {primaryMobileNavItems.map((item) => {
              const isCurrent = activeScreen === item.id;
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
                  const isCurrent = activeScreen === item.id;
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
              const isCurrent = activeScreen === item.id;
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
            {screenTitles[activeScreen]}
          </span>
          {activeReview && (
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

        <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
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

      {/* Main Application Viewport */}
      <main className="flex-1 flex flex-col min-h-0">
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
          <NewReviewPage onReviewCompleted={handleReviewCompleted} />
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
            isLocalStorageAvailable={persistence.isLocalStorageAvailable()}
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
      </main>

      {/* Command Palette Modal */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNavigate={(screen) => setActiveScreen(screen)}
        onLoadIsolatedDemo={handleLoadIsolatedDemo}
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />
    </div>
  );
}
