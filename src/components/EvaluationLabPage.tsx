import React, { useMemo, useState } from 'react';
import {
  EvaluationCaseResult,
  EvaluationTestCase,
} from '../types/patchguard';
import { executeCodeReview } from '../lib/apiClient';
import {
  computePrecisionRecall,
  matchFindingsToExpectedDefects,
} from '../lib/evaluationMath';
import { ReviewStatusLabel, SeverityLabel } from './SeverityIndicator';
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';

interface EvaluationLabPageProps {
  testCases: EvaluationTestCase[];
  onUpdateTestCases: (nextCases: EvaluationTestCase[]) => void;
  onResetSuite: () => void;
}

export const EvaluationLabPage: React.FC<EvaluationLabPageProps> = ({
  testCases,
  onUpdateTestCases,
  onResetSuite,
}) => {
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>('all');
  const [selectedCaseId, setSelectedCaseId] = useState<string>(testCases[0]?.id || '');
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null);
  const [isRunningSuite, setIsRunningSuite] = useState<boolean>(false);
  const [evalEngineMode, setEvalEngineMode] = useState<'hybrid' | 'static-only'>('hybrid');

  const suites = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; executed: number }>();
    for (const tc of testCases) {
      const existing = map.get(tc.suiteId) || {
        id: tc.suiteId,
        name: tc.suiteName,
        count: 0,
        executed: 0,
      };
      existing.count++;
      if (tc.lastRunResult) existing.executed++;
      map.set(tc.suiteId, existing);
    }
    return Array.from(map.values());
  }, [testCases]);

  const visibleCases = useMemo(() => {
    if (selectedSuiteId === 'all') return testCases;
    return testCases.filter((tc) => tc.suiteId === selectedSuiteId);
  }, [testCases, selectedSuiteId]);

  const selectedCase = useMemo(
    () => testCases.find((tc) => tc.id === selectedCaseId) || visibleCases[0] || null,
    [testCases, selectedCaseId, visibleCases]
  );

  // Aggregate metrics strictly from genuinely executed test cases
  const aggregateMetrics = useMemo(() => {
    const executedCases = testCases.filter((tc) => Boolean(tc.lastRunResult));
    if (executedCases.length === 0) {
      return null;
    }

    let totalTp = 0;
    let totalFp = 0;
    let totalFn = 0;
    let totalLatency = 0;

    for (const tc of executedCases) {
      const res = tc.lastRunResult!;
      totalTp += res.truePositives;
      totalFp += res.falsePositives;
      totalFn += res.falseNegatives;
      totalLatency += res.durationMs;
    }

    const { precision, recall, f1Score } = computePrecisionRecall(totalTp, totalFp, totalFn);
    return {
      executedCount: executedCases.length,
      totalCases: testCases.length,
      totalTp,
      totalFp,
      totalFn,
      precision,
      recall,
      f1Score,
      avgLatencyMs: Math.round(totalLatency / executedCases.length),
    };
  }, [testCases]);

  const runSingleTestCase = async (tc: EvaluationTestCase): Promise<EvaluationCaseResult> => {
    const start = performance.now();
    const res = await executeCodeReview({
      title: `[EVAL] ${tc.id}: ${tc.title}`,
      objective: `Evaluation benchmark test case: ${tc.description}`,
      focusAreas: [tc.category],
      files: [
        {
          id: `eval-file-${tc.id}`,
          filename: tc.filename,
          language: tc.language,
          content: tc.sourceCode,
          changeStatus: 'snippet',
        },
      ],
      analysisMode: evalEngineMode,
    });

    const durationMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const errDetail = (res as { ok: false; error: any }).error;
      return {
        executedAt: new Date().toISOString(),
        durationMs,
        status: 'failed',
        detectedFindings: [],
        matchedPairs: [],
        unmatchedExpectedIds: tc.expectedDefects.map((d) => d.id),
        falsePositiveFindingIds: [],
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: tc.expectedDefects.length,
        precision: null,
        recall: tc.expectedDefects.length > 0 ? 0 : null,
        f1Score: null,
        requestId: errDetail.requestId,
        analysisSourcesUsed: [],
        errorDetails: errDetail,
      };
    }

    const review = res.review;
    const matchStats = matchFindingsToExpectedDefects(
      review.findings,
      tc.expectedDefects
    );

    return {
      executedAt: new Date().toISOString(),
      durationMs: review.durationMs || durationMs,
      status: review.status,
      detectedFindings: review.findings,
      matchedPairs: matchStats.matchedPairs,
      unmatchedExpectedIds: matchStats.unmatchedExpectedIds,
      falsePositiveFindingIds: matchStats.falsePositiveFindingIds,
      truePositives: matchStats.truePositives,
      falsePositives: matchStats.falsePositives,
      falseNegatives: matchStats.falseNegatives,
      precision: matchStats.precision,
      recall: matchStats.recall,
      f1Score: matchStats.f1Score,
      requestId: review.requestId,
      analysisSourcesUsed: review.stages
        .filter((s) => s.status === 'succeeded' || s.status === 'warning')
        .map((s) => s.engine),
    };
  };

  const handleExecuteCase = async (tc: EvaluationTestCase) => {
    if (runningCaseId || isRunningSuite) return;
    setRunningCaseId(tc.id);
    const result = await runSingleTestCase(tc);
    const updated = testCases.map((item) =>
      item.id === tc.id ? { ...item, lastRunResult: result } : item
    );
    onUpdateTestCases(updated);
    setRunningCaseId(null);
  };

  const handleExecuteSuite = async () => {
    if (runningCaseId || isRunningSuite) return;
    setIsRunningSuite(true);
    let currentList = [...testCases];

    for (const tc of visibleCases) {
      setRunningCaseId(tc.id);
      setSelectedCaseId(tc.id);
      const result = await runSingleTestCase(tc);
      currentList = currentList.map((item) =>
        item.id === tc.id ? { ...item, lastRunResult: result } : item
      );
      onUpdateTestCases(currentList);
    }

    setRunningCaseId(null);
    setIsRunningSuite(false);
  };

  const formatRatio = (val: number | null, zeroDenomReason: string) => {
    if (val === null) return `N/A (${zeroDenomReason})`;
    return `${(val * 100).toFixed(1)}% (${val.toFixed(2)})`;
  };

  return (
    <div className="max-w-[1400px] w-full mx-auto px-3 sm:px-6 py-6 space-y-6 overflow-x-hidden">
      {/* Header & Suite Execution Controls */}
      <div className="border-b border-[var(--pg-border-default)] pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            EVALUATION LAB · EMPIRICAL DEFECT DETECTION & FALSE-POSITIVE VERIFICATION
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)]">
            Curated Ground-Truth Benchmark Environment
          </h1>
          <p className="text-xs text-[var(--pg-text-secondary)] max-w-2xl">
            Measures actual detection Precision and Recall against ground-truth defect annotations.
            No metrics are fabricated prior to test execution; performance on this curated suite
            verifies pipeline regressions rather than proving universal reliability.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 max-w-full min-w-0">
          <select
            aria-label="Evaluation engine mode"
            value={evalEngineMode}
            onChange={(e) => setEvalEngineMode(e.target.value as 'hybrid' | 'static-only')}
            className="max-w-full min-w-0 px-3 py-2 text-xs font-mono bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] truncate"
          >
            <option value="hybrid">Engine: Hybrid (Static + Gemini 3.1 Flash Lite)</option>
            <option value="static-only">Engine: Deterministic Static Analyzer Only</option>
          </select>

          <button
            type="button"
            disabled={isRunningSuite || Boolean(runningCaseId)}
            onClick={handleExecuteSuite}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] disabled:opacity-50 transition-colors cursor-pointer"
          >
            {isRunningSuite ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Executing Suite...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Execute {selectedSuiteId === 'all' ? 'All 5 Cases' : 'Visible Suite'}</span>
              </>
            )}
          </button>

          {aggregateMetrics && (
            <button
              type="button"
              onClick={onResetSuite}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Clear Measured Runs</span>
            </button>
          )}
        </div>
      </div>

      {/* Measured Aggregate Metrics vs Honest Unexecuted Empty State */}
      {!aggregateMetrics ? (
        <div className="p-5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
          <div className="space-y-1">
            <div className="font-mono font-semibold text-[var(--pg-accent-text)]">
              NO EVALUATION RUNS EXECUTED IN CURRENT LEDGER
            </div>
            <p className="text-[var(--pg-text-secondary)] max-w-3xl leading-relaxed">
              PatchGuard withholds precision, recall, and latency metrics until test cases have been
              genuinely executed against the backend analysis pipeline. Click{' '}
              <strong>Execute All 5 Cases</strong> or run an individual test case below to compute
              empirical benchmark scores.
            </p>
          </div>
          <div className="font-mono text-[11px] px-2.5 py-1 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-muted)] shrink-0">
            ○ 0 / {testCases.length} cases executed
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] divide-y sm:divide-y-0 sm:divide-x divide-[var(--pg-border-default)] text-xs">
          <div className="p-4 space-y-1 min-w-0">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-muted)]">
              EXECUTED TEST CASES
            </div>
            <div className="font-mono text-xl font-semibold text-[var(--pg-text-primary)] tabular-nums">
              {aggregateMetrics.executedCount} / {aggregateMetrics.totalCases}
            </div>
            <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
              TP: {aggregateMetrics.totalTp} · FP: {aggregateMetrics.totalFp} · FN:{' '}
              {aggregateMetrics.totalFn}
            </div>
            <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
              Benchmarks genuinely run against the live review pipeline.
            </div>
          </div>

          <div className="p-4 space-y-1 min-w-0">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-muted)]">
              MEASURED PRECISION
            </div>
            <div className="font-mono text-xl font-semibold text-[var(--pg-success)] tabular-nums">
              {formatRatio(aggregateMetrics.precision, 'TP+FP=0')}
            </div>
            <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
              TP / (TP + FP) = {aggregateMetrics.totalTp} / (
              {aggregateMetrics.totalTp + aggregateMetrics.totalFp})
            </div>
            <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
              Share of reported findings that match a real ground-truth defect.
            </div>
          </div>

          <div className="p-4 space-y-1 min-w-0">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-muted)]">
              MEASURED RECALL
            </div>
            <div className="font-mono text-xl font-semibold text-[var(--pg-info)] tabular-nums">
              {formatRatio(aggregateMetrics.recall, 'TP+FN=0')}
            </div>
            <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
              TP / (TP + FN) = {aggregateMetrics.totalTp} / (
              {aggregateMetrics.totalTp + aggregateMetrics.totalFn})
            </div>
            <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
              Share of known ground-truth defects successfully detected.
            </div>
          </div>

          <div className="p-4 space-y-1 min-w-0">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-muted)]">
              HARMONIC F1 SCORE
            </div>
            <div className="font-mono text-xl font-semibold text-[var(--pg-text-primary)] tabular-nums">
              {aggregateMetrics.f1Score !== null ? aggregateMetrics.f1Score.toFixed(3) : 'N/A'}
            </div>
            <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
              2 · (P · R) / (P + R)
            </div>
            <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
              Balanced accuracy combining false-positive and false-negative rates.
            </div>
          </div>

          <div className="p-4 space-y-1 min-w-0">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-muted)]">
              MEAN REVIEW LATENCY
            </div>
            <div className="font-mono text-xl font-semibold text-[var(--pg-text-primary)] tabular-nums">
              {aggregateMetrics.avgLatencyMs}ms
            </div>
            <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
              {aggregateMetrics.executedCount} live request(s)
            </div>
            <div className="text-[11px] text-[var(--pg-text-secondary)] leading-snug">
              Average end-to-end execution duration per benchmark case.
            </div>
          </div>
        </div>
      )}

      {/* 9.1 Three-Zone Evaluation Layout: Suite Nav (3) | Central Results Table (5) | Case Detail Inspector (4) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Zone (3 cols): Test-Suite Navigation & Metric Definitions */}
        <div className="lg:col-span-3 space-y-4 min-w-0">
          <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)]">
            <div className="px-3.5 py-2.5 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)]">
              TEST SUITES ({suites.length})
            </div>
            <div className="divide-y divide-[var(--pg-border-subtle)] text-xs font-mono">
              <button
                type="button"
                onClick={() => setSelectedSuiteId('all')}
                className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between cursor-pointer ${
                  selectedSuiteId === 'all'
                    ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] font-semibold border-l-[3px] border-l-[var(--pg-accent)]'
                    : 'text-[var(--pg-text-secondary)] hover:bg-[var(--pg-bg-workspace)] border-l-[3px] border-l-transparent'
                }`}
              >
                <span>All Curated Suites</span>
                <span className="tabular-nums">{testCases.length}</span>
              </button>
              {suites.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedSuiteId(s.id)}
                  className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer ${
                    selectedSuiteId === s.id
                      ? 'bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] font-semibold border-l-[3px] border-l-[var(--pg-accent)]'
                      : 'text-[var(--pg-text-secondary)] hover:bg-[var(--pg-bg-workspace)] border-l-[3px] border-l-transparent'
                  }`}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="tabular-nums text-[11px] shrink-0">
                    {s.executed}/{s.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* 9.3 Formal Metric Definitions & Matching Protocol */}
          <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-4 space-y-3 text-xs">
            <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)]">
              METRIC DEFINITIONS & MATCHING CONTRACT
            </div>
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
                Precision = TP / (TP + FP)
              </div>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                Proportion of reported findings that match a ground-truth defect. When TP + FP = 0,
                Precision is reported as N/A rather than 100%.
              </p>
            </div>
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
                Recall = TP / (TP + FN)
              </div>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                Proportion of expected ground-truth defects successfully detected. On negative
                control cases (0 expected defects), Recall is N/A.
              </p>
            </div>
            <div className="space-y-1 border-t border-[var(--pg-border-subtle)] pt-2">
              <div className="font-mono text-[11px] text-[var(--pg-info)]">
                Line-Overlap Matching Rule
              </div>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                A detected finding counts as a True Positive (TP) if its verified source line range
                overlaps within ±3 lines of the expected defect and matches the expected category or
                minimum severity.
              </p>
            </div>
          </div>
        </div>

        {/* Center Zone (5 cols): Test Cases & Measured Results Table */}
        <div className="lg:col-span-5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] min-w-0">
          <div className="px-4 py-2.5 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between font-mono text-[11px] text-[var(--pg-text-secondary)]">
            <span>CURATED TEST CASES ({visibleCases.length})</span>
            <span>STATUS / TP·FP·FN</span>
          </div>

          <div className="divide-y divide-[var(--pg-border-subtle)]">
            {visibleCases.map((tc) => {
              const isSelected = selectedCase?.id === tc.id;
              const run = tc.lastRunResult;
              const isRunning = runningCaseId === tc.id;
              const matchedAllExpectations =
                run &&
                run.status !== 'failed' &&
                run.falseNegatives === 0 &&
                run.falsePositives === 0;

              return (
                <div
                  key={tc.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedCaseId(tc.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedCaseId(tc.id);
                    }
                  }}
                  className={`p-3.5 transition-colors cursor-pointer border-l-[3px] ${
                    isSelected
                      ? 'bg-[var(--pg-bg-elevated)] border-l-[var(--pg-accent)] ring-1 ring-inset ring-[var(--pg-border-strong)]'
                      : 'bg-[var(--pg-bg-surface)] border-l-transparent hover:bg-[var(--pg-bg-workspace)]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1 font-mono text-[11px]">
                    <span className="text-[var(--pg-info)]">
                      {tc.id} · {tc.language.toUpperCase()} · {tc.category}
                    </span>
                    {isRunning ? (
                      <span className="px-1.5 py-0.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-accent-text)] font-semibold">
                        ⋯ RUNNING
                      </span>
                    ) : !run ? (
                      <span className="px-1.5 py-0.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] text-[var(--pg-text-muted)]">
                        ○ UNEXECUTED — NOT RUN
                      </span>
                    ) : run.status === 'failed' ? (
                      <span className="px-1.5 py-0.5 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] text-[var(--pg-danger)] font-semibold">
                        ✕ EXECUTION FAILED
                      </span>
                    ) : matchedAllExpectations ? (
                      <span className="px-1.5 py-0.5 bg-[var(--pg-success-subtle)] border border-[var(--pg-border-default)] text-[var(--pg-success)] font-semibold">
                        ✓ PASS · MATCHED EXPECTATIONS
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] text-[var(--pg-warning)] font-semibold">
                        △ DISCREPANCY (FP:{run.falsePositives} / FN:{run.falseNegatives})
                      </span>
                    )}
                  </div>

                  <div className="text-[13px] font-semibold text-[var(--pg-text-primary)] mb-1 break-words leading-snug">
                    {tc.title}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono text-[var(--pg-text-secondary)]">
                    <span className="tabular-nums">
                      Expected Defects: {tc.expectedDefects.length}
                      {run &&
                        ` · Detected: ${run.detectedFindings.length} (TP:${run.truePositives} FP:${run.falsePositives} FN:${run.falseNegatives})`}
                    </span>

                    <button
                      type="button"
                      disabled={isRunning || isRunningSuite}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCaseId(tc.id);
                        handleExecuteCase(tc);
                      }}
                      className="px-2.5 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      {isRunning ? 'Running...' : run ? 'Re-Run Case' : 'Run Case'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Zone (4 cols): 9.2 Selected Test-Case Detail Inspector */}
        <div className="lg:col-span-4 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] min-w-0">
          <div className="px-4 py-2.5 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between font-mono text-[11px] text-[var(--pg-text-secondary)]">
            <span>TEST-CASE INSPECTOR</span>
            <span>{selectedCase?.id}</span>
          </div>

          {!selectedCase ? (
            <div className="p-6 text-xs text-[var(--pg-text-muted)]">
              Select a test case to inspect its source code, ground-truth expected defects, and
              measured evaluation outcome.
            </div>
          ) : (
            <div className="p-4 space-y-4 text-xs">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[var(--pg-text-muted)] break-all">
                  {selectedCase.suiteName} · {selectedCase.filename}
                </div>
                <h2 className="text-sm font-semibold text-[var(--pg-text-primary)] mt-0.5 break-words">
                  {selectedCase.title}
                </h2>
                <p className="text-[var(--pg-text-secondary)] mt-1 leading-relaxed break-words">
                  {selectedCase.description}
                </p>
              </div>

              {/* Expected vs. Actual Comparison Summary Grid (when executed) */}
              {selectedCase.lastRunResult && (
                <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] p-3 space-y-2">
                  <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)] flex items-center justify-between gap-2">
                    <span>EXPECTED VS. ACTUAL COMPARISON</span>
                    <span className="text-[var(--pg-text-muted)] tabular-nums">
                      {selectedCase.lastRunResult.durationMs}ms
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5 text-center font-mono text-[11px]">
                    <div className="p-1.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-subtle)]">
                      <div className="text-[10px] text-[var(--pg-text-muted)]">EXPECTED</div>
                      <div className="text-sm font-semibold text-[var(--pg-text-primary)] tabular-nums">
                        {selectedCase.expectedDefects.length}
                      </div>
                    </div>
                    <div className="p-1.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-subtle)]">
                      <div className="text-[10px] text-[var(--pg-text-muted)]">DETECTED</div>
                      <div className="text-sm font-semibold text-[var(--pg-text-primary)] tabular-nums">
                        {selectedCase.lastRunResult.detectedFindings.length}
                      </div>
                    </div>
                    <div className="p-1.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-subtle)]">
                      <div className="text-[10px] text-[var(--pg-success)]">TP</div>
                      <div className="text-sm font-semibold text-[var(--pg-success)] tabular-nums">
                        {selectedCase.lastRunResult.truePositives}
                      </div>
                    </div>
                    <div className="p-1.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-subtle)]">
                      <div className="text-[10px] text-[var(--pg-warning)]">FP</div>
                      <div className="text-sm font-semibold text-[var(--pg-warning)] tabular-nums">
                        {selectedCase.lastRunResult.falsePositives}
                      </div>
                    </div>
                    <div className="p-1.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-subtle)]">
                      <div className="text-[10px] text-[var(--pg-danger)]">FN</div>
                      <div className="text-sm font-semibold text-[var(--pg-danger)] tabular-nums">
                        {selectedCase.lastRunResult.falseNegatives}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Source Code Preview */}
              <div className="space-y-1">
                <div className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                  BENCHMARK SOURCE SNIPPET ({selectedCase.language.toUpperCase()})
                </div>
                <pre className="p-2.5 bg-[var(--pg-bg-code)] border border-[var(--pg-border-default)] font-mono text-[11px] text-[var(--pg-text-primary)] overflow-x-auto leading-relaxed">
                  {selectedCase.sourceCode
                    .split('\n')
                    .map((line, idx) => `${String(idx + 1).padStart(2, ' ')} | ${line}`)
                    .join('\n')}
                </pre>
              </div>

              {/* Expected Ground-Truth Defects */}
              <div className="space-y-2">
                <div className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                  GROUND-TRUTH EXPECTED DEFECTS ({selectedCase.expectedDefects.length})
                </div>
                {selectedCase.expectedDefects.length === 0 ? (
                  <div className="p-2.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] font-mono text-[11px] text-[var(--pg-info)]">
                    Zero expected defects (Clean Baseline Control). Any reported finding on this
                    snippet is scored as a False Positive (FP).
                  </div>
                ) : (
                  selectedCase.expectedDefects.map((exp) => {
                    const matchedPair = selectedCase.lastRunResult?.matchedPairs.find(
                      (m) => m.expectedDefectId === exp.id
                    );
                    return (
                      <div
                        key={exp.id}
                        className="p-2.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                          <SeverityLabel severity={exp.minSeverity} compact />
                          <span>
                            L{exp.startLine}–L{exp.endLine} · {exp.category}
                          </span>
                        </div>
                        <div className="font-semibold text-[var(--pg-text-primary)] break-words">
                          {exp.title}
                        </div>
                        <div className="text-[var(--pg-text-secondary)] break-words">
                          {exp.rationale}
                        </div>
                        {selectedCase.lastRunResult && (
                          <div className="pt-1 font-mono text-[11px]">
                            {matchedPair ? (
                              <span className="text-[var(--pg-success)] font-semibold">
                                ✓ Detected (Matched finding {matchedPair.findingId}, ΔL=
                                {matchedPair.lineDelta})
                              </span>
                            ) : (
                              <span className="text-[var(--pg-danger)] font-semibold">
                                ✕ Missed (False Negative)
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Actual Measured Execution Result */}
              <div className="space-y-2 border-t border-[var(--pg-border-subtle)] pt-3">
                <div className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                  ACTUAL EXECUTION RESULT
                </div>
                {!selectedCase.lastRunResult ? (
                  <div className="p-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-2">
                    <div className="font-mono text-[11px] text-[var(--pg-text-muted)]">
                      Status: ○ Unexecuted (Not Run)
                    </div>
                    <p className="text-[var(--pg-text-secondary)]">
                      Run this test case to measure actual findings, precision, recall, and latency.
                    </p>
                    <button
                      type="button"
                      disabled={Boolean(runningCaseId) || isRunningSuite}
                      onClick={() => handleExecuteCase(selectedCase)}
                      className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] font-semibold cursor-pointer"
                    >
                      Execute {selectedCase.id} Now
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="p-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-2 font-mono text-[11px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <ReviewStatusLabel status={selectedCase.lastRunResult.status} />
                        <span className="text-[var(--pg-text-muted)] tabular-nums">
                          {selectedCase.lastRunResult.durationMs}ms · Req:{' '}
                          {selectedCase.lastRunResult.requestId}
                        </span>
                      </div>
                      <div className="text-[var(--pg-text-secondary)]">
                        Precision:{' '}
                        {formatRatio(selectedCase.lastRunResult.precision, '0 detections')} ·
                        Recall: {formatRatio(selectedCase.lastRunResult.recall, '0 expected')}
                      </div>
                      <div className="text-[var(--pg-text-muted)]">
                        Engines:{' '}
                        {selectedCase.lastRunResult.analysisSourcesUsed.join(', ') || 'None'}
                      </div>
                    </div>

                    {selectedCase.lastRunResult.errorDetails && (
                      <div className="p-3 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] font-mono text-[11px] space-y-1.5">
                        <div className="font-semibold text-[var(--pg-danger)] break-words">
                          ✕ [{selectedCase.lastRunResult.errorDetails.category}]{' '}
                          {selectedCase.lastRunResult.errorDetails.message}
                        </div>
                        {selectedCase.lastRunResult.errorDetails.technicalDetail && (
                          <div className="text-[var(--pg-text-secondary)] break-words">
                            Technical Detail:{' '}
                            {selectedCase.lastRunResult.errorDetails.technicalDetail}
                          </div>
                        )}
                        <div className="text-[var(--pg-text-primary)] break-words">
                          Remediation: {selectedCase.lastRunResult.errorDetails.remediationStep}
                        </div>
                      </div>
                    )}

                    {/* Actual Detected Findings Breakdown (TP vs FP) */}
                    <div className="space-y-1.5">
                      <div className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                        DETECTED FINDINGS IN RUN (
                        {selectedCase.lastRunResult.detectedFindings.length})
                      </div>
                      {selectedCase.lastRunResult.detectedFindings.length === 0 ? (
                        <div className="p-2.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] font-mono text-[11px] text-[var(--pg-text-muted)]">
                          0 findings reported by the analysis pipeline for this benchmark case.
                        </div>
                      ) : (
                        selectedCase.lastRunResult.detectedFindings.map((f) => {
                          const isFp =
                            selectedCase.lastRunResult?.falsePositiveFindingIds.includes(f.id);
                          return (
                            <div
                              key={f.id}
                              className="p-2.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-1 font-mono text-[11px]"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <SeverityLabel severity={f.severity} compact />
                                {isFp ? (
                                  <span className="text-[var(--pg-warning)] font-semibold">
                                    △ False Positive (FP)
                                  </span>
                                ) : (
                                  <span className="text-[var(--pg-success)] font-semibold">
                                    ✓ True Positive (TP)
                                  </span>
                                )}
                              </div>
                              <div className="font-sans font-semibold text-[var(--pg-text-primary)] break-words">
                                {f.title}
                              </div>
                              <div className="text-[var(--pg-text-muted)] tabular-nums">
                                L{f.location.startLine}–L{f.location.endLine} ·{' '}
                                {f.staticCorroboration?.ruleId || f.analysisSource}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
