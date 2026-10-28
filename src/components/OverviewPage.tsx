import React, { useMemo } from 'react';
import {
  ReviewFinding,
  ReviewRecord,
  SystemHealthStatus,
} from '../types/patchguard';
import { compareSeverity } from '../lib/staticAnalyzer';
import {
  FindingStatusLabel,
  ReviewStatusLabel,
  SeverityLabel,
} from './SeverityIndicator';
import {
  ArrowRight,
  Code2,
  FileSearch,
  FlaskConical,
  History,
  Plus,
  ShieldAlert,
  Terminal,
} from 'lucide-react';

interface OverviewPageProps {
  reviews: ReviewRecord[];
  health: SystemHealthStatus | null;
  onStartNewReview: () => void;
  onOpenReview: (review: ReviewRecord, findingId?: string) => void;
  onLoadIsolatedDemo: () => void;
  onOpenEvaluationLab: () => void;
  onOpenDiagnostics: () => void;
  onOpenHistory?: () => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  reviews,
  health,
  onStartNewReview,
  onOpenReview,
  onLoadIsolatedDemo,
  onOpenEvaluationLab,
  onOpenDiagnostics,
  onOpenHistory,
}) => {
  // Compute real activity metrics strictly from stored records
  const activityMetrics = useMemo(() => {
    const completedCount = reviews.filter(
      (r) =>
        r.status === 'completed' ||
        r.status === 'completed_static_only' ||
        r.status === 'completed_with_warnings'
    ).length;

    let unreviewedFindingsCount = 0;
    let reviewsRequiringAttention = 0;

    for (const r of reviews) {
      const unrev = r.findings.filter(
        (f) => f.status === 'unreviewed' || f.status === 'reopened'
      );
      unreviewedFindingsCount += unrev.length;
      if (
        unrev.some((f) => f.severity === 'critical' || f.severity === 'high') ||
        r.status === 'completed_with_warnings' ||
        r.status === 'failed'
      ) {
        reviewsRequiringAttention++;
      }
    }

    return {
      totalReviews: reviews.length,
      completedCount,
      reviewsRequiringAttention,
      unreviewedFindingsCount,
    };
  }, [reviews]);

  // Attention Queue: Unresolved Critical/High/Medium findings prioritized by severity
  const attentionQueue = useMemo(() => {
    const items: Array<{ review: ReviewRecord; finding: ReviewFinding }> = [];
    for (const r of reviews) {
      for (const f of r.findings) {
        if (f.status === 'unreviewed' || f.status === 'reopened') {
          items.push({ review: r, finding: f });
        }
      }
    }
    return items
      .sort((a, b) => compareSeverity(a.finding.severity, b.finding.severity))
      .slice(0, 8);
  }, [reviews]);

  const aiStatusDisplay = useMemo(() => {
    if (!health) {
      return {
        label: 'Checking...',
        colorClass: 'text-[var(--pg-text-muted)]',
      };
    }
    if (health.aiConnectivityState === 'verified') {
      return {
        label: 'Live Connectivity Verified',
        colorClass: 'text-[var(--pg-success)]',
      };
    }
    if (health.aiConnectivityState === 'failed') {
      return {
        label: 'Live Probe Failed (Static Fallback Active)',
        colorClass: 'text-[var(--pg-warning)]',
      };
    }
    if (health.aiProviderConfigured) {
      return {
        label: 'Key Configured (Connectivity Unprobed)',
        colorClass: 'text-[var(--pg-text-primary)]',
      };
    }
    return {
      label: 'Not Configured (Static Mode Active)',
      colorClass: 'text-[var(--pg-warning)]',
    };
  }, [health]);

  return (
    <div className="max-w-[1360px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
      {/* 6.1 Opening Composition */}
      <section className="border-b border-[var(--pg-border-default)] pb-6 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div className="space-y-2 max-w-3xl">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-[var(--pg-text-secondary)]">
            <span>PatchGuard AI Workspace</span>
            <span aria-hidden="true">·</span>
            <span>Defect Investigation & Evidence Verification</span>
          </div>
          <h1
            className="text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--pg-text-primary)]"
            style={{ textWrap: 'balance' }}
          >
            Understand the change. Find the risk. Review with evidence.
          </h1>
          <p className="text-sm text-[var(--pg-text-secondary)] leading-relaxed max-w-2xl">
            An engineering workspace for investigating code changes, validating automated findings
            against verbatim source lines, and distinguishing deterministic static rules from model
            hypotheses.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onStartNewReview}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Code Review</span>
          </button>
          <button
            type="button"
            onClick={onLoadIsolatedDemo}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Code2 className="w-4 h-4 text-[var(--pg-info)]" />
            <span>Inspect Demo Review (PR #418)</span>
          </button>
        </div>
      </section>

      {/* Verifiable System & Persistence Status Strip */}
      <section
        aria-label="Verifiable system configuration state"
        className="px-4 py-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs font-mono"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[var(--pg-text-secondary)]">
          <span>
            API Server:{' '}
            <strong
              className={
                !health
                  ? 'text-[var(--pg-text-muted)]'
                  : health.backendReachable
                  ? 'text-[var(--pg-success)]'
                  : 'text-[var(--pg-danger)]'
              }
            >
              {health
                ? health.backendReachable
                  ? `✓ Online (${health.backendLatencyMs}ms)`
                  : '✕ Unreachable'
                : '⋯ Checking'}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Static Analyzer:{' '}
            <strong className="text-[var(--pg-info)]">
              ✓ Ready ({health?.staticEngineVersion || 'pg-static-ast-1.4.2'})
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Gemini AI ({health?.aiModelId || 'gemini-3.1-flash-lite'}):{' '}
            <strong className={aiStatusDisplay.colorClass}>{aiStatusDisplay.label}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Storage:{' '}
            <strong className="text-[var(--pg-text-primary)]">
              {health?.persistenceMode === 'browser-local-storage'
                ? 'Browser Local Storage'
                : 'Session Memory Fallback'}
            </strong>
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenDiagnostics}
          className="text-[var(--pg-info)] hover:underline whitespace-nowrap shrink-0 self-start md:self-auto cursor-pointer"
        >
          System Diagnostics & Probe →
        </button>
      </section>

      {/* Isolated Demonstration Record Callout (Always clearly distinguished from stored user reviews) */}
      <section
        aria-label="Demonstration review overview"
        className="px-4 py-3 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-mono">
            <span className="text-[var(--pg-info)] font-semibold">[DEMONSTRATION RECORD]</span>
            <span className="text-[var(--pg-text-primary)] font-semibold">
              PR #418: Settle multi-tenant merchant payouts & batch reconciliation
            </span>
            <span className="text-[var(--pg-text-muted)]">·</span>
            <span className="text-[var(--pg-text-secondary)] tabular-nums">
              8 Static Findings · 2 Files · 12ms
            </span>
          </div>
          <p className="text-[var(--pg-text-secondary)] leading-relaxed">
            Pre-computed static analysis demonstration for exploring the three-pane workspace,
            source-line highlighting, and CWE-89 SQL injection evidence. Kept strictly isolated from
            your local review ledger and metrics below.
          </p>
        </div>

        <button
          type="button"
          onClick={onLoadIsolatedDemo}
          className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] whitespace-nowrap shrink-0 self-start sm:self-center cursor-pointer"
        >
          Open Demo in Workspace →
        </button>
      </section>

      {/* 6.5 First-Use Experience vs 6.2 Stored Review Activity */}
      {reviews.length === 0 ? (
        <section
          aria-label="First-use onboarding workspace"
          className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-5 sm:p-8 space-y-6"
        >
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6 border-b border-[var(--pg-border-subtle)] pb-6">
            <div className="space-y-2 max-w-2xl">
              <div className="font-mono text-xs text-[var(--pg-accent-text)]">
                01 · Local Review Ledger Empty · Ready for First Submission
              </div>
              <h2 className="text-lg font-semibold text-[var(--pg-text-primary)]">
                No user code reviews stored in this browser yet
              </h2>
              <p className="text-sm text-[var(--pg-text-secondary)] leading-relaxed">
                PatchGuard AI does not populate your workspace with fabricated historical metrics or
                synthetic repositories. Submit a code change or pull-request snippet to run live
                analysis, or open the isolated demonstration record above to inspect how source-line
                evidence and invalid model citations are handled.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={onStartNewReview}
                className="px-4 py-2 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Submit Source Code for Review
              </button>
              <button
                type="button"
                onClick={onOpenEvaluationLab}
                className="px-4 py-2 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Evaluation Lab
              </button>
            </div>
          </div>

          {/* 3-Step Technical Workflow Guide */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs">
            <div className="space-y-1.5">
              <div className="font-mono text-[var(--pg-text-muted)]">01. Input & Objective</div>
              <h3 className="font-semibold text-sm text-[var(--pg-text-primary)]">
                Configure source files and investigation focus
              </h3>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                Paste a pull-request file or load one of the curated TypeScript, Python, or Java
                change sets. Specify concrete investigation objectives such as tenant isolation,
                async race conditions, or loop bounds.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="font-mono text-[var(--pg-text-muted)]">
                02. Dual-Engine Verification
              </div>
              <h3 className="font-semibold text-sm text-[var(--pg-text-primary)]">
                Corroborate static rules with Gemini semantic analysis
              </h3>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                The backend executes deterministic AST/pattern analysis alongside{' '}
                <code className="font-mono text-[11px]">
                  {health?.aiModelId || 'gemini-3.1-flash-lite'}
                </code>
                , upgrading overlapping detections to Corroborated status and quarantining
                out-of-bounds line numbers.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="font-mono text-[var(--pg-text-muted)]">
                03. Evidence & Benchmarking
              </div>
              <h3 className="font-semibold text-sm text-[var(--pg-text-primary)]">
                Triage findings and measure precision/recall
              </h3>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                Inspect verbatim code snippets in the three-panel workspace, record review decisions
                in browser-local storage, or measure true/false positive rates in the Evaluation Lab.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* 6.2 Derived Review Activity Strip */}
          <section
            aria-label="Stored review activity summary"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] divide-y sm:divide-y-0 sm:divide-x divide-[var(--pg-border-default)]"
          >
            <div className="p-4 space-y-1">
              <div className="font-mono text-xs text-[var(--pg-text-muted)]">
                Stored Reviews Completed
              </div>
              <div className="font-mono text-2xl font-semibold text-[var(--pg-text-primary)] tabular-nums">
                {activityMetrics.completedCount}
              </div>
              <div className="text-xs text-[var(--pg-text-secondary)]">
                Across {activityMetrics.totalReviews} recorded session(s) in local storage
              </div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-xs text-[var(--pg-text-muted)]">
                Reviews Requiring Attention
              </div>
              <div className="font-mono text-2xl font-semibold text-[var(--pg-warning)] tabular-nums">
                {activityMetrics.reviewsRequiringAttention}
              </div>
              <div className="text-xs text-[var(--pg-text-secondary)]">
                With unreviewed Critical/High findings or stage warnings
              </div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-xs text-[var(--pg-text-muted)]">
                Unreviewed Findings
              </div>
              <div className="font-mono text-2xl font-semibold text-[var(--pg-accent-text)] tabular-nums">
                {activityMetrics.unreviewedFindingsCount}
              </div>
              <div className="text-xs text-[var(--pg-text-secondary)]">
                Findings currently marked Unreviewed or Reopened
              </div>
            </div>

            <div className="p-4 space-y-1">
              <div className="font-mono text-xs text-[var(--pg-text-muted)]">
                Persistence Scope
              </div>
              <div className="font-mono text-sm font-semibold text-[var(--pg-text-primary)] pt-1">
                Browser Local Ledger
              </div>
              <div className="text-xs text-[var(--pg-text-secondary)]">
                Stored locally on this device; exportable as JSON in Settings
              </div>
            </div>
          </section>

          {/* Two-Column Split: 6.4 Attention Queue & 6.3 Review Timeline */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* 6.4 Attention Queue (7 columns) */}
            <section
              aria-label="Unresolved findings attention queue"
              className="lg:col-span-7 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] min-w-0"
            >
              <div className="px-4 py-3 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--pg-text-primary)]">
                    Attention Queue · Unresolved Findings
                  </h2>
                  <p className="text-xs text-[var(--pg-text-secondary)]">
                    Prioritized by severity across your stored code reviews. Select an entry to jump
                    directly to its source evidence.
                  </p>
                </div>
                <span className="font-mono text-xs text-[var(--pg-text-muted)] tabular-nums shrink-0">
                  {attentionQueue.length} item(s)
                </span>
              </div>

              {attentionQueue.length === 0 ? (
                <div className="p-6 text-xs space-y-1.5">
                  <div className="font-mono font-semibold text-[var(--pg-success)]">
                    ✓ No Unreviewed Findings in Queue
                  </div>
                  <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                    All findings in your stored reviews have been marked as Reviewed or Dismissed.
                    Note that zero pending findings does not guarantee absence of software defects.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--pg-border-subtle)]">
                  {attentionQueue.map(({ review, finding }) => (
                    <button
                      key={`${review.id}-${finding.id}`}
                      type="button"
                      onClick={() => onOpenReview(review, finding.id)}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--pg-bg-workspace)] transition-colors flex items-start justify-between gap-4 cursor-pointer"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                          <SeverityLabel severity={finding.severity} compact />
                          <span className="text-[var(--pg-text-muted)]">·</span>
                          <span className="text-[var(--pg-text-secondary)]">
                            {finding.category}
                          </span>
                          <span className="text-[var(--pg-text-muted)]">·</span>
                          {finding.location.isValidLocation ? (
                            <span className="text-[var(--pg-info)] tabular-nums">
                              {finding.location.filename}:L{finding.location.startLine}
                            </span>
                          ) : (
                            <span className="text-[var(--pg-warning)]">
                              {finding.location.filename} · Quarantined Location
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-semibold text-[var(--pg-text-primary)] truncate">
                          {finding.title}
                        </div>
                        <div className="text-[11px] font-mono text-[var(--pg-text-muted)] truncate">
                          Review: {review.title} ({review.id})
                        </div>
                      </div>

                      <span className="font-mono text-xs text-[var(--pg-accent-text)] shrink-0 self-center">
                        Investigate →
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* 6.3 Chronological Review Timeline (5 columns) */}
            <section
              aria-label="Recent review timeline"
              className="lg:col-span-5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] min-w-0"
            >
              <div className="px-4 py-3 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--pg-text-primary)]">
                    Recent Review Activity
                  </h2>
                  <p className="text-xs text-[var(--pg-text-secondary)]">
                    Chronological log of stored code reviews.
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-xs shrink-0">
                  <span className="text-[var(--pg-text-muted)] tabular-nums">
                    {reviews.length} total
                  </span>
                  {onOpenHistory && (
                    <button
                      type="button"
                      onClick={onOpenHistory}
                      className="text-[var(--pg-info)] hover:underline cursor-pointer"
                    >
                      History →
                    </button>
                  )}
                </div>
              </div>

              <div className="divide-y divide-[var(--pg-border-subtle)]">
                {reviews.slice(0, 6).map((rev) => (
                  <div
                    key={rev.id}
                    className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--pg-bg-workspace)] transition-colors"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--pg-text-muted)] tabular-nums">
                        <span>{rev.id}</span>
                        <span>·</span>
                        <span>
                          {new Date(rev.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                        <span>·</span>
                        <span>{rev.durationMs}ms</span>
                      </div>
                      <div className="text-xs font-semibold text-[var(--pg-text-primary)] truncate">
                        {rev.title}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                        <ReviewStatusLabel status={rev.status} />
                        <span className="text-[var(--pg-text-muted)]">·</span>
                        <span className="text-[var(--pg-text-secondary)] tabular-nums">
                          {rev.findings.length} finding(s)
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onOpenReview(rev)}
                      className="px-2.5 py-1 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] shrink-0 cursor-pointer"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
};

