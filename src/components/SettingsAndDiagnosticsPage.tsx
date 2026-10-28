import React, { useEffect, useState } from 'react';
import {
  ApiErrorCategory,
  DiagnosticEvent,
  ReviewRecord,
  StructuredApiError,
  SystemHealthStatus,
} from '../types/patchguard';
import { executeCodeReview, probeAiConnectivity } from '../lib/apiClient';
import {
  Download,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
} from 'lucide-react';

interface SettingsAndDiagnosticsPageProps {
  theme: 'dark' | 'light';
  onChangeTheme: (theme: 'dark' | 'light') => void;
  health: SystemHealthStatus | null;
  onRefreshHealth: () => Promise<void>;
  diagnostics: DiagnosticEvent[];
  onClearDiagnostics: () => void;
  reviews: ReviewRecord[];
  onClearAllReviews: () => void;
}

const FAILURE_SIMULATION_MODES: Array<{
  category: ApiErrorCategory;
  label: string;
  description: string;
}> = [
  {
    category: 'AI_SERVICE_UNAVAILABLE',
    label: 'AI Service High Demand (503)',
    description:
      'Verifies HTTP 503 UNAVAILABLE handling after bounded exponential backoff retries are exhausted.',
  },
  {
    category: 'AI_RATE_LIMIT',
    label: 'AI Provider Rate Limit (429)',
    description: 'Verifies HTTP 429 quota exhaustion diagnostic reporting and retry guidance.',
  },
  {
    category: 'AI_TIMEOUT',
    label: 'AI Provider Timeout (504)',
    description: 'Verifies upstream deadline exceeded handling and static-analyzer fallback advice.',
  },
  {
    category: 'MISSING_SERVER_CONFIG',
    label: 'Missing Server Configuration (503)',
    description: 'Verifies failure UX when AI-only mode is requested without server credentials.',
  },
  {
    category: 'INVALID_MODEL_RESPONSE',
    label: 'Invalid Model Response Schema (502)',
    description: 'Verifies rejection of malformed JSON output before rendering findings.',
  },
  {
    category: 'INVALID_REQUEST',
    label: 'Invalid Request Payload (400)',
    description: 'Verifies server-side validation rejection for empty or malformed submissions.',
  },
];

export const SettingsAndDiagnosticsPage: React.FC<SettingsAndDiagnosticsPageProps> = ({
  theme,
  onChangeTheme,
  health,
  onRefreshHealth,
  diagnostics,
  onClearDiagnostics,
  reviews,
  onClearAllReviews,
}) => {
  const [isProbingAi, setIsProbingAi] = useState<boolean>(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [simulatedErrorResult, setSimulatedErrorResult] = useState<StructuredApiError | null>(null);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [confirmClearReviews, setConfirmClearReviews] = useState<boolean>(false);
  const [expandedDiagnosticId, setExpandedDiagnosticId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmClearReviews) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmClearReviews(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmClearReviews]);

  const handleRunLiveAiProbe = async () => {
    setIsProbingAi(true);
    setProbeMessage(null);
    const res = await probeAiConnectivity();
    setProbeMessage(res.message);
    await onRefreshHealth();
    setIsProbingAi(false);
  };

  const handleSimulateFailure = async (category: ApiErrorCategory) => {
    setIsSimulating(true);
    setSimulatedErrorResult(null);
    const res = await executeCodeReview({
      title: `Diagnostic Fault Probe: ${category}`,
      objective: 'Verify failure state rendering and telemetry capture',
      focusAreas: ['security'],
      files: [
        {
          filename: 'probe.ts',
          language: 'typescript',
          content: 'export const x = 1;',
        },
      ],
      simulateFailureMode: category,
    });
    setIsSimulating(false);
    if (!res.ok) {
      setSimulatedErrorResult((res as { ok: false; error: StructuredApiError }).error);
    }
    await onRefreshHealth();
  };

  const handleExportReviewsJson = () => {
    const payload = JSON.stringify(reviews, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `patchguard-reviews-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-[1360px] mx-auto px-4 sm:px-6 py-6 space-y-8">
      {/* Page Header */}
      <div className="border-b border-[var(--pg-border-default)] pb-4 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            SYSTEM OBSERVABILITY, DIAGNOSTICS & WORKSPACE SETTINGS
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)] mt-1">
            Operational Health, Telemetry & Persistence Controls
          </h1>
        </div>
        <button
          type="button"
          onClick={onRefreshHealth}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh System Status</span>
        </button>
      </div>

      {/* Section 10: Verifiable System Health Matrix */}
      <section aria-label="Verifiable system health matrix" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--pg-text-primary)]">
            01 · Verifiable Subsystem Health (Configuration vs. Live Connectivity)
          </h2>
          <span className="font-mono text-xs text-[var(--pg-text-muted)]">
            Checked: {health ? new Date(health.checkedAt).toLocaleTimeString() : 'Pending'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] divide-y md:divide-y-0 md:divide-x divide-[var(--pg-border-default)] text-xs">
          {/* 1. Backend Reachability */}
          <div className="p-4 space-y-1.5">
            <div className="font-mono text-[11px] text-[var(--pg-text-muted)]">
              EXPRESS BACKEND (/api/health)
            </div>
            <div
              className={`font-mono text-sm font-semibold ${
                health?.backendReachable ? 'text-[var(--pg-success)]' : 'text-[var(--pg-danger)]'
              }`}
            >
              {health?.backendReachable
                ? `✓ Reachable (${health.backendLatencyMs}ms)`
                : '✕ Unreachable'}
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              Verified via live HTTP GET to /api/health on port 3000.
            </p>
          </div>

          {/* 2. AI Provider Configuration vs Connectivity */}
          <div className="p-4 space-y-2">
            <div className="font-mono text-[11px] text-[var(--pg-text-muted)]">
              AI PROVIDER ({health?.aiModelId || 'gemini-3.1-flash-lite'})
            </div>
            <div className="font-mono text-xs space-y-0.5">
              <div>
                Key Configured:{' '}
                <strong
                  className={
                    health?.aiProviderConfigured
                      ? 'text-[var(--pg-success)]'
                      : 'text-[var(--pg-warning)]'
                  }
                >
                  {health?.aiProviderConfigured ? 'YES (Server Env)' : 'NO'}
                </strong>
              </div>
              <div>
                Live Connectivity:{' '}
                <strong
                  className={
                    health?.aiConnectivityState === 'verified'
                      ? 'text-[var(--pg-success)]'
                      : health?.aiConnectivityState === 'failed'
                      ? 'text-[var(--pg-danger)]'
                      : 'text-[var(--pg-text-secondary)]'
                  }
                >
                  {health?.aiConnectivityState === 'verified'
                    ? '✓ VERIFIED'
                    : health?.aiConnectivityState === 'failed'
                    ? '✕ FAILED'
                    : '○ UNVERIFIED'}
                </strong>
              </div>
            </div>
            <button
              type="button"
              disabled={isProbingAi}
              onClick={handleRunLiveAiProbe}
              className="w-full py-1 px-2 font-mono text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
            >
              {isProbingAi ? 'Probing Model...' : 'Probe Live AI Connectivity'}
            </button>
          </div>

          {/* 3. Static Analysis Engine */}
          <div className="p-4 space-y-1.5">
            <div className="font-mono text-[11px] text-[var(--pg-text-muted)]">
              STATIC ANALYSIS ENGINE
            </div>
            <div className="font-mono text-sm font-semibold text-[var(--pg-info)]">
              ✓ {health?.staticEngineVersion || 'pg-static-ast-1.4.2'}
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              Deterministic structural rules active for TS, JS, Python, Java, and SQL.
            </p>
          </div>

          {/* 4. Persistence Adapter */}
          <div className="p-4 space-y-1.5">
            <div className="font-mono text-[11px] text-[var(--pg-text-muted)]">
              PERSISTENCE ADAPTER
            </div>
            <div
              className={`font-mono text-sm font-semibold ${
                health?.persistenceHealthy ? 'text-[var(--pg-success)]' : 'text-[var(--pg-warning)]'
              }`}
            >
              {health?.persistenceMode === 'browser-local-storage'
                ? '✓ Browser localStorage'
                : '△ Memory Fallback'}
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              {reviews.length} review record(s) stored in local browser ledger.
            </p>
          </div>
        </div>

        {(probeMessage || health?.aiConnectivityMessage) && (
          <div
            role="status"
            className={`px-4 py-2.5 border font-mono text-xs ${
              health?.aiConnectivityState === 'verified'
                ? 'bg-[var(--pg-success-subtle)] border-[var(--pg-border-default)] text-[var(--pg-success)]'
                : health?.aiConnectivityState === 'failed'
                ? 'bg-[var(--pg-warning-subtle)] border-[var(--pg-border-default)] text-[var(--pg-warning)]'
                : 'bg-[var(--pg-bg-workspace)] border-[var(--pg-border-default)] text-[var(--pg-text-secondary)]'
            }`}
          >
            <strong className="mr-1.5">
              {health?.aiConnectivityState === 'verified'
                ? '✓ AI Connectivity Verified:'
                : health?.aiConnectivityState === 'failed'
                ? '△ AI Connectivity Probe Warning:'
                : '○ AI Connectivity Status:'}
            </strong>
            <span className="text-[var(--pg-text-primary)]">
              {probeMessage || health?.aiConnectivityMessage}
            </span>
          </div>
        )}
      </section>

      {/* Two-Column Split: Theme & Storage Settings (5 cols) | Failure State Verification Harness (7 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 5 Columns: Visual Theme & Persistence Management */}
        <section className="lg:col-span-5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-5 space-y-6 text-xs">
          <div className="space-y-2">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)]">
              02 · VISUAL THEME & SURFACE HIERARCHY
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              Select between the default dark-first Deep Graphite workspace and the independently
              calibrated Daylight Editorial theme. Selection persists in browser storage.
            </p>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onChangeTheme('dark')}
                aria-pressed={theme === 'dark'}
                className={`p-3 border text-left font-mono transition-colors flex items-center justify-between cursor-pointer ${
                  theme === 'dark'
                    ? 'bg-[var(--pg-bg-elevated)] border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
                    : 'bg-[var(--pg-bg-workspace)] border-[var(--pg-border-default)] text-[var(--pg-text-secondary)]'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dark (Default)</span>
                </span>
                {theme === 'dark' && <span className="text-[var(--pg-accent-text)]">ACTIVE</span>}
              </button>

              <button
                type="button"
                onClick={() => onChangeTheme('light')}
                aria-pressed={theme === 'light'}
                className={`p-3 border text-left font-mono transition-colors flex items-center justify-between cursor-pointer ${
                  theme === 'light'
                    ? 'bg-[var(--pg-bg-elevated)] border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
                    : 'bg-[var(--pg-bg-workspace)] border-[var(--pg-border-default)] text-[var(--pg-text-secondary)]'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <Sun className="w-3.5 h-3.5" />
                  <span>Light Editorial</span>
                </span>
                {theme === 'light' && <span className="text-[var(--pg-accent-text)]">ACTIVE</span>}
              </button>
            </div>
          </div>

          <div className="border-t border-[var(--pg-border-subtle)] pt-5 space-y-3">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)]">
              03 · LOCAL PERSISTENCE LEDGER CONTROLS
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              Export your stored code reviews as a portable JSON bundle or purge local browser
              records.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={reviews.length === 0}
                onClick={handleExportReviewsJson}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] disabled:opacity-40 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Reviews JSON ({reviews.length})</span>
              </button>

              {!confirmClearReviews ? (
                <button
                  type="button"
                  disabled={reviews.length === 0}
                  onClick={() => setConfirmClearReviews(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-danger)] disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All Stored Reviews</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClearAllReviews();
                      setConfirmClearReviews(false);
                    }}
                    className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-danger)] text-white font-semibold cursor-pointer"
                  >
                    Confirm Purge
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearReviews(false)}
                    className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] cursor-pointer"
                  >
                    Cancel (Esc)
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right 7 Columns: Section 10.2 Deterministic Failure-State Verification Harness */}
        <section className="lg:col-span-7 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-5 space-y-4 text-xs">
          <div className="space-y-1">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)]">
              04 · FAILURE-STATE DIAGNOSTIC VERIFICATION HARNESS
            </div>
            <p className="text-[var(--pg-text-secondary)] leading-relaxed">
              Trigger real round-trip error responses from <code className="font-mono">/api/review</code>{' '}
              to inspect how PatchGuard normalizes failure categories, records diagnostic telemetry,
              and surfaces actionable remediation steps without exposing sensitive stack traces or
              credentials.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FAILURE_SIMULATION_MODES.map((mode) => (
              <button
                key={mode.category}
                type="button"
                disabled={isSimulating}
                onClick={() => handleSimulateFailure(mode.category)}
                className="p-3 text-left border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] hover:border-[var(--pg-border-strong)] transition-colors space-y-1 cursor-pointer"
              >
                <div className="font-mono font-semibold text-[var(--pg-text-primary)]">
                  {mode.label}
                </div>
                <div className="text-[11px] text-[var(--pg-text-secondary)]">
                  {mode.description}
                </div>
              </button>
            ))}
          </div>

          {simulatedErrorResult && (
            <div
              role="region"
              aria-label="Simulated failure diagnostic result"
              className="p-3.5 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] space-y-1.5 font-mono text-[11px]"
            >
              <div className="flex items-center justify-between text-[var(--pg-danger)] font-semibold">
                <span>VERIFIED FAILURE RESPONSE · {simulatedErrorResult.category}</span>
                <span>Req: {simulatedErrorResult.requestId}</span>
              </div>
              <div className="text-[var(--pg-text-primary)] font-sans text-xs font-semibold">
                {simulatedErrorResult.message}
              </div>
              <div className="text-[var(--pg-text-secondary)]">
                Technical Detail: {simulatedErrorResult.technicalDetail}
              </div>
              <div className="text-[var(--pg-info)]">
                Next Step: {simulatedErrorResult.remediationStep} (Retryable:{' '}
                {simulatedErrorResult.retryable ? 'Yes' : 'No'})
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Section 10.1 Diagnostics Details Table */}
      <section className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)]">
        <div className="px-4 py-3 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--pg-text-primary)]">
              05 · Sanitized Request & Analysis Diagnostics Ledger ({diagnostics.length})
            </h2>
            <p className="text-xs text-[var(--pg-text-secondary)]">
              Records request identifiers, analysis stages, durations, and normalized error
              categories. Click any request ID to expand untruncated diagnostic details.
            </p>
          </div>
          {diagnostics.length > 0 && (
            <button
              type="button"
              onClick={onClearDiagnostics}
              className="px-2.5 py-1 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
            >
              Clear Diagnostics Log
            </button>
          )}
        </div>

        {diagnostics.length === 0 ? (
          <div className="p-6 text-xs text-[var(--pg-text-muted)] font-mono">
            No API requests recorded in this session yet. Submit a review or run a health probe to
            populate diagnostic telemetry.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[11px] text-[var(--pg-text-secondary)]">
                  <th className="py-2 px-3">TIMESTAMP</th>
                  <th className="py-2 px-3">REQUEST ID</th>
                  <th className="py-2 px-3">REVIEW ID</th>
                  <th className="py-2 px-3">STAGE / ENDPOINT</th>
                  <th className="py-2 px-3">STATUS</th>
                  <th className="py-2 px-3 text-right">DURATION</th>
                  <th className="py-2 px-3">DIAGNOSTIC SUMMARY</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--pg-border-subtle)] text-[11px]">
                {diagnostics.map((d) => {
                  const isExpanded = expandedDiagnosticId === d.id;
                  return (
                    <React.Fragment key={d.id}>
                      <tr className="hover:bg-[var(--pg-bg-workspace)]">
                        <td className="py-2 px-3 text-[var(--pg-text-muted)] tabular-nums whitespace-nowrap">
                          {new Date(d.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() =>
                              setExpandedDiagnosticId(isExpanded ? null : d.id)
                            }
                            title="Click to expand full untruncated diagnostic payload"
                            className="text-[var(--pg-info)] hover:underline cursor-pointer"
                          >
                            {d.requestId}
                          </button>
                        </td>
                        <td className="py-2 px-3 text-[var(--pg-text-secondary)] whitespace-nowrap">
                          {d.reviewId || '—'}
                        </td>
                        <td className="py-2 px-3 text-[var(--pg-text-secondary)] whitespace-nowrap">
                          {d.stage} ({d.endpoint})
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">
                          <span
                            className={
                              d.status === 'succeeded'
                                ? 'text-[var(--pg-success)]'
                                : d.status === 'warning'
                                ? 'text-[var(--pg-warning)]'
                                : 'text-[var(--pg-danger)]'
                            }
                          >
                            {d.status.toUpperCase()} (HTTP {d.statusCode})
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-[var(--pg-text-primary)] whitespace-nowrap">
                          {d.durationMs}ms
                        </td>
                        <td
                          className="py-2 px-3 text-[var(--pg-text-secondary)] max-w-[400px] truncate cursor-pointer"
                          title={d.message}
                          onClick={() => setExpandedDiagnosticId(isExpanded ? null : d.id)}
                        >
                          {d.message}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)]">
                          <td colSpan={7} className="p-3 space-y-1">
                            <div>
                              Full Request ID: {d.requestId} · Timestamp:{' '}
                              {new Date(d.timestamp).toISOString()} · Stage: {d.stage} (
                              {d.endpoint})
                            </div>
                            {d.errorCategory && (
                              <div className="text-[var(--pg-warning)]">
                                Normalized Error Category: {d.errorCategory} (HTTP {d.statusCode})
                              </div>
                            )}
                            <div className="text-[var(--pg-text-primary)] break-words">
                              Message: {d.message}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
