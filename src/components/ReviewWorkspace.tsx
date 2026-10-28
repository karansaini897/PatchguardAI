import React, { useEffect, useMemo, useState } from 'react';
import {
  AnalysisSourceType,
  FindingCategory,
  FindingStatus,
  ReviewFinding,
  ReviewRecord,
  SeverityLevel,
} from '../types/patchguard';
import {
  computeSeverityDistribution,
  filterFindings,
  FindingFilterCriteria,
} from '../lib/evaluationMath';
import {
  resolveTargetSourceFile,
  verifyFindingLocationIntegrity,
} from '../lib/staticAnalyzer';
import { persistence } from '../lib/persistence';
import { SourceViewer } from './SourceViewer';
import {
  AnalysisSourceLabel,
  FindingStatusLabel,
  ReviewStatusLabel,
  SEVERITY_META,
  SeverityLabel,
} from './SeverityIndicator';
import {
  AlertTriangle,
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  Filter,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react';

interface ReviewWorkspaceProps {
  review: ReviewRecord | null;
  initialSelectedFindingId?: string | null;
  onUpdateFindingStatus: (reviewId: string, findingId: string, status: FindingStatus) => void;
  onStartNewReview: () => void;
  onLoadIsolatedDemo: () => void;
}

export const ReviewWorkspace: React.FC<ReviewWorkspaceProps> = ({
  review,
  initialSelectedFindingId,
  onUpdateFindingStatus,
  onStartNewReview,
  onLoadIsolatedDemo,
}) => {
  const [activeFileId, setActiveFileId] = useState<string>('');
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'source' | 'findings' | 'details'>('findings');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showStagesPanel, setShowStagesPanel] = useState<boolean>(false);

  // Resizable panel proportions (persisted in localStorage)
  const initialLayout = useMemo(() => persistence.getWorkspaceLayout(), []);
  const [sourceWidthPct, setSourceWidthPct] = useState<number>(initialLayout.sourceWidthPercent);
  const [findingsWidthPct, setFindingsWidthPct] = useState<number>(
    initialLayout.findingsWidthPercent
  );

  // Filter state
  const [filters, setFilters] = useState<FindingFilterCriteria>({
    severity: 'all',
    category: 'all',
    filename: 'all',
    status: 'all',
    source: 'all',
    searchQuery: '',
  });

  // Re-verify all findings against the loaded source files and their content hashes
  const verifiedFindings: ReviewFinding[] = useMemo(() => {
    if (!review) return [];
    return review.findings.map((f) => ({
      ...f,
      location: verifyFindingLocationIntegrity(f, review.files),
    }));
  }, [review]);

  useEffect(() => {
    if (!review) return;
    if (review.files.length > 0) {
      setActiveFileId(review.files[0].id);
    }
    if (initialSelectedFindingId) {
      const target = verifiedFindings.find((f) => f.id === initialSelectedFindingId);
      if (target) {
        setSelectedFindingId(target.id);
        const matchingFile = resolveTargetSourceFile(
          review.files,
          target.location.fileId,
          target.location.filename
        );
        if (matchingFile) setActiveFileId(matchingFile.id);
        return;
      }
    }
    if (verifiedFindings.length > 0) {
      setSelectedFindingId(verifiedFindings[0].id);
      const firstFile = resolveTargetSourceFile(
        review.files,
        verifiedFindings[0].location.fileId,
        verifiedFindings[0].location.filename
      );
      if (firstFile) setActiveFileId(firstFile.id);
    } else {
      setSelectedFindingId(null);
    }
  }, [review?.id, initialSelectedFindingId, verifiedFindings]);

  const filteredFindings = useMemo(() => {
    return filterFindings(verifiedFindings, filters);
  }, [verifiedFindings, filters]);

  const selectedFinding: ReviewFinding | null = useMemo(() => {
    if (!selectedFindingId) return null;
    return verifiedFindings.find((f) => f.id === selectedFindingId) || null;
  }, [verifiedFindings, selectedFindingId]);

  const distribution = useMemo(
    () => computeSeverityDistribution(verifiedFindings),
    [verifiedFindings]
  );

  const hasActiveFilters =
    filters.severity !== 'all' ||
    filters.category !== 'all' ||
    filters.filename !== 'all' ||
    filters.status !== 'all' ||
    filters.source !== 'all' ||
    filters.searchQuery.trim() !== '';

  const clearFilters = () => {
    setFilters({
      severity: 'all',
      category: 'all',
      filename: 'all',
      status: 'all',
      source: 'all',
      searchQuery: '',
    });
  };

  const handleSelectFinding = (finding: ReviewFinding) => {
    setSelectedFindingId(finding.id);
    if (review) {
      const targetFile = resolveTargetSourceFile(
        review.files,
        finding.location.fileId,
        finding.location.filename
      );
      if (targetFile) {
        setActiveFileId(targetFile.id);
      }
    }
    setMobileTab('details');
  };

  const handleCopyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Fallback
    }
  };

  const adjustPanelLayout = (preset: 'balanced' | 'code-focus' | 'investigation-focus') => {
    const next =
      preset === 'code-focus'
        ? { sourceWidthPercent: 52, findingsWidthPercent: 24 }
        : preset === 'investigation-focus'
        ? { sourceWidthPercent: 34, findingsWidthPercent: 31 }
        : { sourceWidthPercent: 44, findingsWidthPercent: 28 };
    setSourceWidthPct(next.sourceWidthPercent);
    setFindingsWidthPct(next.findingsWidthPercent);
    persistence.saveWorkspaceLayout(next);
  };

  if (!review) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-8 space-y-4">
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            REVIEW WORKSPACE · NO ACTIVE RECORD
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)]">
            No code review is currently loaded in the investigation workspace
          </h1>
          <p className="text-sm text-[var(--pg-text-secondary)] max-w-2xl leading-relaxed">
            Submit source code or a pull-request change set in New Review to execute deterministic
            static analysis and Gemini code reasoning, or load the isolated demonstration review to
            inspect the three-panel investigation workspace.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onStartNewReview}
              className="px-4 py-2 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Start New Code Review
            </button>
            <button
              type="button"
              onClick={onLoadIsolatedDemo}
              className="px-4 py-2 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Inspect Isolated Demo Review (PR #418)
            </button>
          </div>
        </div>
      </div>
    );
  }

  const detailsWidthPct = Math.max(24, 100 - sourceWidthPct - findingsWidthPct);

  const startResizeDrag = (
    divider: 'source-findings' | 'findings-details',
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    const initialSource = sourceWidthPct;
    const initialFindings = findingsWidthPct;
    const viewportWidth = window.innerWidth || 1440;

    const onMouseMove = (moveEvt: MouseEvent) => {
      const deltaPct = ((moveEvt.clientX - startX) / viewportWidth) * 100;
      if (divider === 'source-findings') {
        const nextSource = Math.max(26, Math.min(58, Math.round(initialSource + deltaPct)));
        const nextFindings = Math.max(
          22,
          Math.min(45, initialFindings - (nextSource - initialSource))
        );
        setSourceWidthPct(nextSource);
        setFindingsWidthPct(nextFindings);
        persistence.saveWorkspaceLayout({
          sourceWidthPercent: nextSource,
          findingsWidthPercent: nextFindings,
        });
      } else {
        const nextFindings = Math.max(22, Math.min(45, Math.round(initialFindings + deltaPct)));
        setFindingsWidthPct(nextFindings);
        persistence.saveWorkspaceLayout({
          sourceWidthPercent: initialSource,
          findingsWidthPercent: nextFindings,
        });
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-5.25rem)] overflow-hidden bg-[var(--pg-bg-canvas)]">
      {/* Review Summary & Analysis Transparency Header Bar */}
      <div className="border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] px-4 py-2.5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Left: Review Title, ID & Status */}
          <div className="flex items-center gap-3 min-w-0">
            <ReviewStatusLabel status={review.status} />
            <span className="text-[var(--pg-border-strong)]" aria-hidden="true">
              ·
            </span>
            <h1
              className="text-sm font-semibold text-[var(--pg-text-primary)] truncate max-w-[440px]"
              title={review.title}
            >
              {review.title}
            </h1>
            <span className="text-[var(--pg-border-strong)]" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-xs text-[var(--pg-text-muted)] tabular-nums shrink-0">
              ID: {review.id}
            </span>
            {review.isDemoRecord && (
              <span className="font-mono text-[11px] text-[var(--pg-warning)] shrink-0">
                · ISOLATED DEMO RECORD
              </span>
            )}
          </div>

          {/* Right: Summary Telemetry, Proportional Severity Bar & Stage Inspector Toggle */}
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-[var(--pg-text-secondary)]">
            <div className="flex items-center gap-2 tabular-nums">
              <span>{review.findings.length} findings</span>
              <span aria-hidden="true">·</span>
              <span>{review.files.length} file(s)</span>
              <span aria-hidden="true">·</span>
              <span>{review.durationMs}ms</span>
              <span aria-hidden="true">·</span>
              <span
                className="text-[11px] text-[var(--pg-text-muted)] truncate max-w-[260px]"
                title={`Active Engine(s): ${review.modelUsed}`}
              >
                Engine: {review.modelUsed}
              </span>
            </div>

            {/* Proportional Horizontal Severity Distribution Bar */}
            {distribution.total > 0 && (
              <div
                className="flex items-center gap-2"
                title={`Critical: ${distribution.critical}, High: ${distribution.high}, Medium: ${distribution.medium}, Low: ${distribution.low}, Info: ${distribution.info}`}
              >
                <div className="w-28 h-2 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] flex overflow-hidden">
                  {(['critical', 'high', 'medium', 'low', 'info'] as SeverityLevel[]).map((sev) => {
                    const count = distribution[sev];
                    if (count === 0) return null;
                    const pct = (count / distribution.total) * 100;
                    return (
                      <div
                        key={sev}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: SEVERITY_META[sev].barColor,
                        }}
                        className="h-full"
                      />
                    );
                  })}
                </div>
                <span className="text-[11px] text-[var(--pg-text-muted)] tabular-nums">
                  {distribution.critical}C / {distribution.high}H / {distribution.medium}M /{' '}
                  {distribution.low}L
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowStagesPanel((prev) => !prev)}
              aria-expanded={showStagesPanel}
              className="px-2.5 py-1 text-[11px] font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Analysis Stages ({review.stages.length})
            </button>

            {/* Desktop Panel Layout Presets */}
            <div
              className="hidden xl:flex items-center gap-1 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] p-0.5"
              role="group"
              aria-label="Workspace column width presets"
            >
              <button
                type="button"
                onClick={() => adjustPanelLayout('code-focus')}
                className={`px-2 py-0.5 text-[10px] font-mono cursor-pointer ${
                  sourceWidthPct >= 50
                    ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-accent-text)]'
                    : 'text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)]'
                }`}
              >
                52/24/24
              </button>
              <button
                type="button"
                onClick={() => adjustPanelLayout('balanced')}
                className={`px-2 py-0.5 text-[10px] font-mono cursor-pointer ${
                  sourceWidthPct === 44
                    ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-accent-text)]'
                    : 'text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)]'
                }`}
              >
                44/28/28
              </button>
              <button
                type="button"
                onClick={() => adjustPanelLayout('investigation-focus')}
                className={`px-2 py-0.5 text-[10px] font-mono cursor-pointer ${
                  sourceWidthPct <= 36
                    ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-accent-text)]'
                    : 'text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)]'
                }`}
              >
                34/31/35
              </button>
            </div>
          </div>
        </div>

        {/* Warning or Partial Completion Banner */}
        {review.warningMessage && (
          <div className="mt-2 px-3 py-1.5 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--pg-text-primary)]">
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--pg-warning)] shrink-0" />
              <span>{review.warningMessage}</span>
            </div>
            <span className="font-mono text-[11px] text-[var(--pg-text-secondary)] shrink-0">
              Req: {review.requestId}
            </span>
          </div>
        )}

        {/* Expandable Analysis Stages & Engines Drawer */}
        {showStagesPanel && (
          <div className="mt-2 pt-2 border-t border-[var(--pg-border-subtle)] grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            {review.stages.map((stg) => (
              <div
                key={stg.stageId}
                className="px-3 py-2 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] flex items-start justify-between gap-4"
              >
                <div>
                  <div className="font-mono font-semibold text-[var(--pg-text-primary)]">
                    {stg.name} · <span className="text-[var(--pg-info)]">{stg.engine}</span>
                  </div>
                  <div className="text-[var(--pg-text-secondary)] mt-0.5">
                    Objective: {review.objective}
                  </div>
                  {stg.errorMessage && (
                    <div className="text-[var(--pg-warning)] font-mono text-[11px] mt-1">
                      Note: {stg.errorMessage}
                    </div>
                  )}
                </div>
                <div className="text-right font-mono tabular-nums shrink-0">
                  <div
                    className={
                      stg.status === 'succeeded'
                        ? 'text-[var(--pg-success)]'
                        : stg.status === 'warning'
                        ? 'text-[var(--pg-warning)]'
                        : stg.status === 'failed'
                        ? 'text-[var(--pg-danger)]'
                        : 'text-[var(--pg-text-muted)]'
                    }
                  >
                    {stg.status.toUpperCase()}
                    {stg.httpStatus ? ` (HTTP ${stg.httpStatus})` : ''}
                  </div>
                  <div className="text-[var(--pg-text-muted)]">
                    {stg.durationMs}ms · {stg.findingsProduced} finding(s)
                    {typeof stg.attempts === 'number' && stg.attempts > 0
                      ? ` · ${stg.attempts} attempt(s)${
                          stg.retriedCount ? ` (${stg.retriedCount} retry)` : ''
                        }`
                      : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Responsive Mobile/Tablet Mode Switcher (< 1024px) */}
      <div className="flex lg:hidden border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] px-3 overflow-x-auto">
        <button
          type="button"
          onClick={() => setMobileTab('source')}
          className={`px-3 py-2 text-xs font-mono border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            mobileTab === 'source'
              ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
              : 'border-transparent text-[var(--pg-text-secondary)]'
          }`}
        >
          A. Source ({review.files.length})
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('findings')}
          className={`px-3 py-2 text-xs font-mono border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            mobileTab === 'findings'
              ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
              : 'border-transparent text-[var(--pg-text-secondary)]'
          }`}
        >
          B. Findings ({filteredFindings.length}/{review.findings.length})
        </button>
        <button
          type="button"
          onClick={() => setMobileTab('details')}
          className={`px-3 py-2 text-xs font-mono border-b-2 transition-colors whitespace-nowrap shrink-0 ${
            mobileTab === 'details'
              ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
              : 'border-transparent text-[var(--pg-text-secondary)]'
          }`}
        >
          C. Evidence Details
        </button>
      </div>

      {/* Three-Panel Investigation Workspace */}
      <div
        className="flex-1 flex overflow-hidden"
        style={
          {
            '--pg-col-source': `${sourceWidthPct}%`,
            '--pg-col-findings': `${findingsWidthPct}%`,
            '--pg-col-details': `${detailsWidthPct}%`,
          } as React.CSSProperties
        }
      >
        {/* PANEL A: SOURCE AND CHANGE CONTEXT */}
        <section
          aria-label="Source code and change context"
          className={`${
            mobileTab === 'source' ? 'flex w-full' : 'hidden'
          } lg:flex lg:w-[var(--pg-col-source)] flex-col h-full min-w-[280px] overflow-hidden`}
        >
          <SourceViewer
            files={review.files}
            activeFileId={activeFileId}
            onSelectFile={setActiveFileId}
            findings={verifiedFindings}
            selectedFinding={selectedFinding}
            onSelectFinding={handleSelectFinding}
          />
        </section>

        {/* Resizable Drag Divider 1 (Source <-> Findings) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize source and findings columns"
          onMouseDown={(e) => startResizeDrag('source-findings', e)}
          className="hidden lg:block w-1 bg-[var(--pg-border-subtle)] hover:bg-[var(--pg-accent)] cursor-col-resize transition-colors shrink-0"
        />

        {/* PANEL B: FINDINGS LIST & INVESTIGATION FILTERS */}
        <section
          aria-label="Findings investigation list"
          className={`${
            mobileTab === 'findings' ? 'flex w-full' : 'hidden'
          } lg:flex lg:w-[var(--pg-col-findings)] flex-col h-full min-w-[280px] border-r border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] overflow-hidden`}
        >
          {/* Region Header */}
          <div className="px-3 py-2 border-b border-[var(--pg-border-default)] flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold tracking-wider text-[var(--pg-text-secondary)]">
              B · FINDINGS & FILTERS
            </span>
            <span className="font-mono text-[11px] text-[var(--pg-text-muted)] tabular-nums">
              Showing {filteredFindings.length} of {review.findings.length}
            </span>
          </div>

          {/* Compact Investigation Filter Controls */}
          <div className="p-2.5 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--pg-text-muted)] absolute left-2.5 top-2" />
              <input
                type="search"
                aria-label="Search findings by title, rule ID, or explanation"
                placeholder="Filter by title, rule ID, or keyword..."
                value={filters.searchQuery}
                onChange={(e) => setFilters((f) => ({ ...f, searchQuery: e.target.value }))}
                className="w-full pl-8 pr-2.5 py-1 text-xs bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] placeholder:text-[var(--pg-text-muted)] focus:outline-none focus:border-[var(--pg-accent)]"
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono">
              <select
                aria-label="Filter by severity"
                value={filters.severity}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    severity: e.target.value as SeverityLevel | 'all',
                  }))
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
              >
                <option value="all">Severity: All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="info">Info</option>
              </select>

              <select
                aria-label="Filter by category"
                value={filters.category}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    category: e.target.value as FindingCategory | 'all',
                  }))
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
              >
                <option value="all">Category: All</option>
                <option value="security">security</option>
                <option value="concurrency">concurrency</option>
                <option value="boundary">boundary</option>
                <option value="error-handling">error-handling</option>
                <option value="performance">performance</option>
                <option value="correctness">correctness</option>
                <option value="data-integrity">data-integrity</option>
                <option value="maintainability">maintainability</option>
              </select>

              <select
                aria-label="Filter by review status"
                value={filters.status}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    status: e.target.value as FindingStatus | 'all',
                  }))
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
              >
                <option value="all">Status: All</option>
                <option value="unreviewed">Unreviewed</option>
                <option value="reviewed">Reviewed</option>
                <option value="reopened">Reopened</option>
                <option value="dismissed">Dismissed</option>
              </select>

              <select
                aria-label="Filter by analysis source"
                value={filters.source}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    source: e.target.value as AnalysisSourceType | 'all',
                  }))
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
              >
                <option value="all">Source: All Engines</option>
                <option value="corroborated">Corroborated (Static+AI)</option>
                <option value="static-pattern">Static Analyzer</option>
                <option value="ai-gemini">AI Reasoning Only</option>
              </select>

              {review.files.length > 1 && (
                <select
                  aria-label="Filter by source file"
                  value={filters.filename}
                  onChange={(e) => setFilters((f) => ({ ...f, filename: e.target.value }))}
                  className="col-span-2 px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
                >
                  <option value="all">File: All ({review.files.length} files)</option>
                  {review.files.map((fl) => (
                    <option key={fl.id} value={fl.filename}>
                      {fl.filename}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {hasActiveFilters && (
              <div className="flex items-center justify-between pt-1 text-[11px] font-mono">
                <span className="text-[var(--pg-accent-text)]">Active filters applied</span>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="underline text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
                >
                  Clear all filters
                </button>
              </div>
            )}
          </div>

          {/* Findings List */}
          <div className="flex-1 overflow-y-auto divide-y divide-[var(--pg-border-subtle)]">
            {review.findings.length === 0 ? (
              <div className="p-6 space-y-2 text-xs">
                <div className="font-mono font-semibold text-[var(--pg-success)]">
                  0 AUTOMATED FINDINGS DETECTED
                </div>
                <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                  Neither the deterministic static analyzer nor the semantic AI pass reported any
                  findings for the submitted source. Note: absence of automated findings is not a
                  formal proof of software safety.
                </p>
              </div>
            ) : filteredFindings.length === 0 ? (
              <div className="p-6 space-y-3 text-xs">
                <div className="font-mono font-semibold text-[var(--pg-warning)]">
                  ALL {review.findings.length} FINDINGS FILTERED OUT
                </div>
                <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                  This review contains {review.findings.length} finding(s), but none match the
                  active investigation filter criteria.
                </p>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
                >
                  Reset Investigation Filters
                </button>
              </div>
            ) : (
              filteredFindings.map((finding) => {
                const isSelected = selectedFinding?.id === finding.id;
                return (
                  <button
                    key={finding.id}
                    type="button"
                    onClick={() => handleSelectFinding(finding)}
                    className={`w-full text-left p-3 transition-colors block focus-visible:outline-2 focus-visible:outline-[var(--pg-accent)] cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--pg-bg-elevated)]'
                        : 'bg-[var(--pg-bg-workspace)] hover:bg-[var(--pg-bg-surface)]'
                    }`}
                  >
                    {/* Top metadata line: Severity · Category · Location */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-1.5 text-xs font-mono">
                        <SeverityLabel severity={finding.severity} compact />
                        <span className="text-[var(--pg-text-muted)]" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-[var(--pg-text-secondary)]">{finding.category}</span>
                        {finding.staticCorroboration && (
                          <>
                            <span className="text-[var(--pg-text-muted)]" aria-hidden="true">
                              ·
                            </span>
                            <span className="text-[var(--pg-info)]">
                              {finding.staticCorroboration.ruleId}
                            </span>
                          </>
                        )}
                      </div>
                      <span className="font-mono text-[11px] text-[var(--pg-text-muted)] tabular-nums shrink-0">
                        {finding.location.isValidLocation
                          ? `L${finding.location.startLine}${
                              finding.location.endLine !== finding.location.startLine
                                ? `–${finding.location.endLine}`
                                : ''
                            }`
                          : finding.location.startLine > 0
                          ? `L${finding.location.startLine} (Quarantined)`
                          : 'Quarantined'}
                      </span>
                    </div>

                    {/* Specific Finding Title */}
                    <div className="text-xs font-semibold text-[var(--pg-text-primary)] leading-snug mb-1">
                      {finding.title}
                    </div>

                    {/* Concise Explanation Preview */}
                    <p className="text-xs text-[var(--pg-text-secondary)] line-clamp-2 leading-relaxed mb-2">
                      {finding.explanation}
                    </p>

                    {/* Bottom line: File · Source · Status · Confidence */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[var(--pg-text-muted)]">
                      <span className="truncate max-w-[140px]" title={finding.location.filename}>
                        {finding.location.filename}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={
                            finding.analysisSource === 'corroborated'
                              ? 'text-[var(--pg-success)]'
                              : finding.analysisSource === 'static-pattern'
                              ? 'text-[var(--pg-info)]'
                              : 'text-[var(--pg-text-secondary)]'
                          }
                        >
                          {finding.analysisSource === 'corroborated'
                            ? 'Static+AI'
                            : finding.analysisSource === 'static-pattern'
                            ? 'Static'
                            : 'AI'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Conf:{finding.confidence.toUpperCase()}</span>
                        <span aria-hidden="true">·</span>
                        <FindingStatusLabel status={finding.status} />
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Resizable Drag Divider 2 (Findings <-> Details) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize findings and details columns"
          onMouseDown={(e) => startResizeDrag('findings-details', e)}
          className="hidden lg:block w-1 bg-[var(--pg-border-subtle)] hover:bg-[var(--pg-accent)] cursor-col-resize transition-colors shrink-0"
        />

        {/* PANEL C: SELECTED FINDING DETAILS AND EVIDENCE */}
        <section
          aria-label="Selected finding details and evidence"
          className={`${
            mobileTab === 'details' ? 'flex w-full' : 'hidden'
          } lg:flex lg:w-[var(--pg-col-details)] flex-col h-full min-w-[300px] bg-[var(--pg-bg-surface)] overflow-hidden`}
        >
          <div className="px-4 py-2 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold tracking-wider text-[var(--pg-text-secondary)]">
              C · SELECTED FINDING DETAILS & EVIDENCE
            </span>
            {selectedFinding && (
              <span className="font-mono text-[11px] text-[var(--pg-text-muted)]">
                {selectedFinding.id}
              </span>
            )}
          </div>

          {!selectedFinding ? (
            <div className="p-6 text-xs text-[var(--pg-text-muted)]">
              Select a finding from Panel B or click a line marker in Panel A to inspect its source
              evidence, technical explanation, and remediation.
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
              {/* 1 & 2. Finding Summary + Severity, Category & Review Status */}
              <div className="space-y-2 pb-3 border-b border-[var(--pg-border-subtle)]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SeverityLabel severity={selectedFinding.severity} />
                    <span className="text-[var(--pg-text-muted)]" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-xs text-[var(--pg-text-secondary)] uppercase">
                      {selectedFinding.category}
                    </span>
                  </div>
                  <FindingStatusLabel status={selectedFinding.status} />
                </div>

                <h2 className="text-sm font-semibold text-[var(--pg-text-primary)] leading-snug">
                  {selectedFinding.title}
                </h2>

                {/* 9. Meaningful Finding Actions */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {selectedFinding.status !== 'reviewed' && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateFindingStatus(review.id, selectedFinding.id, 'reviewed')
                      }
                      className="px-2.5 py-1 font-mono text-[11px] bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] font-semibold hover:bg-[var(--pg-accent-hover)] transition-colors cursor-pointer"
                    >
                      Mark as Reviewed
                    </button>
                  )}
                  {(selectedFinding.status === 'reviewed' ||
                    selectedFinding.status === 'dismissed') && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateFindingStatus(review.id, selectedFinding.id, 'reopened')
                      }
                      className="px-2.5 py-1 font-mono text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
                    >
                      Reopen Finding
                    </button>
                  )}
                  {selectedFinding.status !== 'dismissed' && (
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateFindingStatus(review.id, selectedFinding.id, 'dismissed')
                      }
                      className="px-2.5 py-1 font-mono text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
                    >
                      Dismiss Finding
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        'details',
                        `[${selectedFinding.severity.toUpperCase()}] ${selectedFinding.title}\nLocation: ${selectedFinding.location.filename}:L${selectedFinding.location.startLine}-${selectedFinding.location.endLine}\nExplanation: ${selectedFinding.explanation}\nRemediation: ${selectedFinding.suggestedRemediation}`
                      )
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    {copiedKey === 'details' ? (
                      <>
                        <Check className="w-3 h-3 text-[var(--pg-success)]" />
                        <span>Copied Details</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Details</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* 3 & 4. Source Location & Direct Source Evidence */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--pg-text-secondary)] whitespace-nowrap">
                    01 · Source Evidence (Verbatim Extract)
                  </span>
                  {selectedFinding.location.isValidLocation ? (
                    <button
                      type="button"
                      onClick={() => {
                        const targetFile = resolveTargetSourceFile(
                          review.files,
                          selectedFinding.location.fileId,
                          selectedFinding.location.filename
                        );
                        if (targetFile) setActiveFileId(targetFile.id);
                        setMobileTab('source');
                      }}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--pg-info)] hover:underline whitespace-nowrap cursor-pointer"
                    >
                      <span>
                        {selectedFinding.location.filename}:L{selectedFinding.location.startLine}
                        {selectedFinding.location.endLine !== selectedFinding.location.startLine
                          ? `–L${selectedFinding.location.endLine}`
                          : ''}
                      </span>
                      <CornerDownRight className="w-3 h-3" />
                    </button>
                  ) : (
                    <span className="font-mono text-[11px] text-[var(--pg-warning)] whitespace-nowrap">
                      Location Quarantined (
                      {selectedFinding.location.locationReason || 'unverified'})
                    </span>
                  )}
                </div>

                {selectedFinding.location.isValidLocation ? (
                  <pre className="p-3 bg-[var(--pg-bg-code)] border border-[var(--pg-border-default)] font-mono text-[11.5px] text-[var(--pg-text-primary)] overflow-x-auto leading-relaxed">
                    <code>{selectedFinding.location.rawSnippet}</code>
                  </pre>
                ) : (
                  <div className="p-3 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] text-[var(--pg-text-secondary)] leading-relaxed">
                    <div className="font-mono font-semibold text-[var(--pg-warning)] mb-1">
                      Unverified Line Citation Quarantined
                    </div>
                    {selectedFinding.location.validationNote}
                  </div>
                )}
              </div>

              {/* 8. Confidence, Uncertainty & Corroboration Provenance */}
              <div className="p-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] space-y-1.5">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-[var(--pg-text-secondary)]">PROVENANCE & CONFIDENCE</span>
                  <AnalysisSourceLabel source={selectedFinding.analysisSource} />
                </div>
                <div className="font-mono text-[11px] text-[var(--pg-text-primary)]">
                  Confidence Level: <span className="uppercase">{selectedFinding.confidence}</span>
                  {selectedFinding.staticCorroboration && (
                    <span>
                      {' '}
                      · Rule: {selectedFinding.staticCorroboration.ruleId} (
                      {selectedFinding.staticCorroboration.engineName})
                    </span>
                  )}
                </div>
                {selectedFinding.uncertaintyNote && (
                  <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                    {selectedFinding.uncertaintyNote}
                  </p>
                )}
              </div>

              {/* 5. Explanation ("Why this may be a problem") */}
              <div className="space-y-1.5">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--pg-text-secondary)]">
                  02 · Why This May Be a Problem (Analysis Reasoning)
                </h3>
                <p className="text-[var(--pg-text-primary)] leading-relaxed">
                  {selectedFinding.explanation}
                </p>
              </div>

              {/* 6. Potential Impact */}
              <div className="space-y-1.5">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--pg-text-secondary)]">
                  03 · Potential Operational & Security Impact
                </h3>
                <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                  {selectedFinding.potentialImpact}
                </p>
              </div>

              {/* 7. Suggested Remediation */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--pg-text-secondary)]">
                    04 · Suggested Remediation
                  </h3>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        'remediation',
                        selectedFinding.remediationCode || selectedFinding.suggestedRemediation
                      )
                    }
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--pg-accent-text)] hover:underline cursor-pointer"
                  >
                    {copiedKey === 'remediation' ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Copied Remediation</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy Suggested Fix</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[var(--pg-text-primary)] leading-relaxed">
                  {selectedFinding.suggestedRemediation}
                </p>
                {selectedFinding.remediationCode && (
                  <pre className="p-3 bg-[var(--pg-bg-code)] border border-[var(--pg-border-default)] font-mono text-[11.5px] text-[var(--pg-success)] overflow-x-auto leading-relaxed">
                    <code>{selectedFinding.remediationCode}</code>
                  </pre>
                )}
              </div>

              {/* 10. Relevant Analysis Metadata */}
              <div className="pt-3 border-t border-[var(--pg-border-subtle)] space-y-1 font-mono text-[11px] text-[var(--pg-text-muted)]">
                <div>Finding ID: {selectedFinding.id}</div>
                <div>Review Request ID: {review.requestId}</div>
                <div>Model / Engine Stack: {review.modelUsed}</div>
                <div>Last Status Update: {new Date(selectedFinding.updatedAt).toLocaleString()}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
