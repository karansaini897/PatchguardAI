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

  // Global Cmd/Ctrl + K shortcut for Command Palette
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleReviewCompleted = (newReview: ReviewRecord) => {
    persistence.saveReview(newReview);
    const updatedList = persistence.getReviews();
    setReviews(updatedList);
    setActiveReview(newReview);
    setInitialSelectedFindingId(newReview.findings[0]?.id || null);
    setDiagnostics(persistence.getDiagnostics());
    setActiveScreen('workspace');
  };

  const handleOpenReview = (review: ReviewRecord, findingId?: string) => {
    setActiveReview(review);
    setInitialSelectedFindingId(findingId || review.findings[0]?.id || null);
    setActiveScreen('workspace');
  };

  const handleLoadIsolatedDemo = () => {
    // Keep demonstration data isolated from stored review history unless explicitly inspected in workspace
    setActiveReview(ISOLATED_DEMO_REVIEW);
    setInitialSelectedFindingId(ISOLATED_DEMO_REVIEW.findings[0]?.id || null);
    setActiveScreen('workspace');
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

  const navItems: Array<{ id: ActiveScreen; label: string; shortLabel: string }> = [
    { id: 'overview', label: 'Overview', shortLabel: 'Overview' },
    { id: 'workspace', label: 'Workspace', shortLabel: 'Workspace' },
    { id: 'history', label: 'History', shortLabel: 'History' },
    { id: 'evaluation-lab', label: 'Evaluation Lab', shortLabel: 'Eval Lab' },
    { id: 'settings', label: 'Settings', shortLabel: 'Settings' },
  ];

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
              setActiveScreen('overview');
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
                    setActiveScreen(item.id);
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

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setActiveScreen('new-review')}
              className="px-3 sm:px-3.5 py-1.5 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              New Review
            </button>
          </div>
        </div>

        {/* Mobile Compact Navigation Bar (< 768px): Full-width 5-destination grid without clipping */}
        <nav
          aria-label="Mobile workspace navigation"
          className="md:hidden grid grid-cols-5 border-t border-[var(--pg-border-subtle)] bg-[var(--pg-bg-workspace)] text-[10.5px] sm:text-xs font-medium"
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
                  setActiveScreen(item.id);
                }}
                className={`py-2 px-0.5 text-center whitespace-nowrap border-b-2 transition-colors ${
                  isCurrent
                    ? 'border-[var(--pg-accent)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] font-semibold'
                    : 'border-transparent text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
                }`}
              >
                {item.shortLabel}
              </a>
            );
          })}
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
                onClick={() => setActiveScreen('workspace')}
                title={`Open active review in Workspace: ${activeReview.title}`}
                className="text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] truncate min-w-0 cursor-pointer text-left"
              >
                Active: {activeReview.isDemoRecord ? '[Demo] ' : ''}
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
