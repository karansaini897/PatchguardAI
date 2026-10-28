import React, { useEffect, useMemo, useState } from 'react';
import {
  AnalysisSourceType,
  FindingCategory,
  FindingStatus,
  ReviewFinding,
  ReviewRecord,
  SeverityLevel,
} from '../types/patchguard';
import { compareSeverity } from '../lib/staticAnalyzer';
import { computeSeverityDistribution } from '../lib/evaluationMath';
import { SourceViewer } from './SourceViewer';
import {
  AnalysisSourceLabel,
  FindingStatusLabel,
  ReviewStatusLabel,
  SeverityLabel,
} from './SeverityIndicator';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCode2,
  Filter,
  RotateCcw,
  Search,
  ShieldAlert,
  XCircle,
} from 'lucide-react';

interface ReviewWorkspaceProps {
  review: ReviewRecord | null;
  initialSelectedFindingId?: string | null;
  onUpdateFindingStatus: (
    reviewId: string,
    findingId: string,
    nextStatus: FindingStatus
  ) => void;
  onStartNewReview: () => void;
  onLoadIsolatedDemo: () => void;
}

export const ReviewWorkspace: React.FC<ReviewWorkspaceProps> = ({
  review,
  initialSelectedFindingId = null,
  onUpdateFindingStatus,
  onStartNewReview,
  onLoadIsolatedDemo,
}) => {
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    initialSelectedFindingId
  );

  // Finding filters
  const [severityFilter, setSeverityFilter] = useState<SeverityLevel | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<FindingCategory | 'all'>('all');
  const [confidenceFilter, setConfidenceFilter] = useState<'high' | 'medium' | 'low' | 'all'>(
    'all'
  );
  const [statusFilter, setStatusFilter] = useState<FindingStatus | 'all'>('all');
  const [fileFilter, setFileFilter] = useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Mobile/Tablet active sub-pane ('source' | 'findings' | 'evidence')
  const [mobilePane, setMobilePane] = useState<'source' | 'findings' | 'evidence'>('findings');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [liveStatusAnnouncement, setLiveStatusAnnouncement] = useState<string>('');

  // Synchronize default file and first finding whenever the active review changes
  useEffect(() => {
    if (!review) {
      setSelectedFileId('');
      setSelectedFindingId(null);
      return;
    }

    const sorted = [...review.findings].sort((a, b) => {
      const sev = compareSeverity(a.severity, b.severity);
      if (sev !== 0) return sev;
      return a.location.startLine - b.location.startLine;
    });

    const targetFinding =
      (initialSelectedFindingId &&
        review.findings.find((f) => f.id === initialSelectedFindingId)) ||
      sorted[0] ||
      null;

    if (targetFinding) {
      setSelectedFindingId(targetFinding.id);
      if (targetFinding.location.fileId) {
        setSelectedFileId(targetFinding.location.fileId);
      } else {
        setSelectedFileId(review.files[0]?.id || '');
      }
    } else {
      setSelectedFindingId(null);
      setSelectedFileId(review.files[0]?.id || '');
    }

    setSeverityFilter('all');
    setCategoryFilter('all');
    setConfidenceFilter('all');
    setStatusFilter('all');
    setFileFilter('all');
    setSearchQuery('');
    setLiveStatusAnnouncement('');
  }, [review?.id, initialSelectedFindingId]);

  const sortedFindings = useMemo(() => {
    if (!review) return [];
    return [...review.findings].sort((a, b) => {
      const sevCmp = compareSeverity(a.severity, b.severity);
      if (sevCmp !== 0) return sevCmp;
      return a.location.startLine - b.location.startLine;
    });
  }, [review]);

  const filteredFindings = useMemo(() => {
    return sortedFindings.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
      if (categoryFilter !== 'all' && f.category !== categoryFilter) return false;
      if (confidenceFilter !== 'all' && f.confidence !== confidenceFilter) return false;
      if (statusFilter !== 'all' && f.status !== statusFilter) return false;
      if (fileFilter !== 'all' && f.location.fileId !== fileFilter) return false;
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const ruleId = f.staticCorroboration?.ruleId || '';
        const hay = `${f.title} ${f.explanation} ${f.location.filename} ${ruleId} ${f.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    sortedFindings,
    severityFilter,
    categoryFilter,
    confidenceFilter,
    statusFilter,
    fileFilter,
    searchQuery,
  ]);

  const selectedFinding: ReviewFinding | null = useMemo(() => {
    if (!review || !selectedFindingId) return null;
    return review.findings.find((f) => f.id === selectedFindingId) || null;
  }, [review, selectedFindingId]);

  const selectedFindingIndex = useMemo(() => {
    if (!selectedFinding) return -1;
    return filteredFindings.findIndex((f) => f.id === selectedFinding.id);
  }, [filteredFindings, selectedFinding]);

  const activeFile = useMemo(() => {
    if (!review || review.files.length === 0) return null;
    return review.files.find((f) => f.id === selectedFileId) || review.files[0];
  }, [review, selectedFileId]);

  const findingsForActiveFile = useMemo(() => {
    if (!review || !activeFile) return [];
    return sortedFindings.filter((f) => f.location.fileId === activeFile.id);
  }, [review, activeFile, sortedFindings]);

  const distribution = useMemo(
    () => computeSeverityDistribution(review?.findings || []),
    [review?.findings]
  );

  const hasActiveFilters =
    severityFilter !== 'all' ||
    categoryFilter !== 'all' ||
    confidenceFilter !== 'all' ||
    statusFilter !== 'all' ||
    fileFilter !== 'all' ||
    searchQuery.trim() !== '';

  const resetAllFilters = () => {
    setSeverityFilter('all');
    setCategoryFilter('all');
    setConfidenceFilter('all');
    setStatusFilter('all');
    setFileFilter('all');
    setSearchQuery('');
    setLiveStatusAnnouncement('Reset all finding filters.');
  };

  const handleSelectFinding = (finding: ReviewFinding, allowToggleDeselect = false) => {
    if (allowToggleDeselect && selectedFindingId === finding.id) {
      setSelectedFindingId(null);
      setLiveStatusAnnouncement(`Deselected finding ${finding.title}.`);
      return;
    }
    setSelectedFindingId(finding.id);
    if (finding.location.fileId && finding.location.fileId !== selectedFileId) {
      setSelectedFileId(finding.location.fileId);
    }
  };

  const handleStepFinding = (direction: -1 | 1) => {
    if (filteredFindings.length === 0) return;
    if (selectedFindingIndex === -1) {
      handleSelectFinding(filteredFindings[0]);
      return;
    }
    const nextIdx =
      (selectedFindingIndex + direction + filteredFindings.length) %
      filteredFindings.length;
    const nextFinding = filteredFindings[nextIdx];
    if (nextFinding) {
      handleSelectFinding(nextFinding);
    }
  };

  // Keyboard navigation for stepping through findings (j/k or ArrowDown/ArrowUp) and Esc to deselect
  useEffect(() => {
    if (!review) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (filteredFindings.length > 0) {
          e.preventDefault();
          handleStepFinding(1);
        }
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (filteredFindings.length > 0) {
          e.preventDefault();
          handleStepFinding(-1);
        }
      } else if (e.key === 'Escape' && selectedFindingId) {
        e.preventDefault();
        setSelectedFindingId(null);
        setLiveStatusAnnouncement('Deselected active finding.');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [review, filteredFindings, selectedFindingIndex, selectedFindingId]);

  const formatSourceEngineShort = (src: AnalysisSourceType) => {
    if (src === 'corroborated') return 'Static+AI';
    if (src === 'ai-gemini') return 'AI';
    return 'Static';
  };

  const handleCopyFindingDetails = (finding: ReviewFinding) => {
    const locationStr = finding.location.isValidLocation
      ? `${finding.location.filename}:L${finding.location.startLine}${
          finding.location.endLine !== finding.location.startLine
            ? `-${finding.location.endLine}`
            : ''
        }`
      : `${finding.location.filename} (Unverified Location)`;
    const ruleId = finding.staticCorroboration?.ruleId || 'AI-SEMANTIC';
    const text = [
      `[${finding.severity.toUpperCase()}] ${finding.title}`,
      `Rule: ${ruleId} | Category: ${finding.category} | Engine: ${formatSourceEngineShort(
        finding.analysisSource
      )} | Confidence: ${finding.confidence.toUpperCase()}`,
      `Location: ${locationStr}`,
      ``,
      `Why It Matters:`,
      finding.explanation,
      ``,
      `Potential Impact:`,
      finding.potentialImpact,
      ``,
      `Recommended Remediation (Unverified Suggested Fix):`,
      finding.suggestedRemediation,
      finding.remediationCode ? `\n${finding.remediationCode}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(finding.id);
    setLiveStatusAnnouncement(`Copied evidence report for ${finding.title} to clipboard.`);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleStatusChange = (finding: ReviewFinding, nextStatus: FindingStatus) => {
    if (!review) return;
    onUpdateFindingStatus(review.id, finding.id, nextStatus);
    setLiveStatusAnnouncement(
      `Updated finding "${finding.title}" status to ${nextStatus}.`
    );
  };

  // Empty Workspace State (No review loaded)
  if (!review) {
    return (
      <div className="max-w-3xl mx-auto my-12 p-8 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)]">
        <div className="space-y-4">
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            WORKSPACE IDLE · NO ACTIVE REVIEW RECORD LOADED
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)]">
            No Code Review Currently Loaded in Workspace
          </h1>
          <p className="text-sm text-[var(--pg-text-secondary)] leading-relaxed">
            Submit a new code change for deterministic static analysis and Gemini semantic
            corroboration, or load the isolated demonstration review record to inspect the
            three-pane workspace layout.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onStartNewReview}
              className="px-4 py-2 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] transition-colors cursor-pointer"
            >
              Start a New Review
            </button>
            <button
              type="button"
              onClick={onLoadIsolatedDemo}
              className="px-4 py-2 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors cursor-pointer"
            >
              Load Isolated Demo Review (PR #418)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-[var(--pg-bg-canvas)] overflow-hidden">
      {/* Screen-Reader Live Status Region */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatusAnnouncement}
      </div>

      {/* Isolated Demo Notice Banner (Only shown when viewing the explicit demo record) */}
      {review.isDemoRecord && (
        <div className="px-4 py-1.5 bg-[var(--pg-info-subtle)] border-b border-[var(--pg-border-default)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 font-mono text-[var(--pg-text-primary)]">
            <span className="font-semibold text-[var(--pg-info)]">[ISOLATED DEMO RECORD]</span>
            <span>
              Pre-computed static demonstration of PR #418 ({review.findings.length} verified
              findings). Stored separately from your local review history.
            </span>
          </div>
          <button
            type="button"
            onClick={onStartNewReview}
            className="font-mono text-xs underline text-[var(--pg-accent-text)] hover:opacity-80 cursor-pointer shrink-0"
          >
            Run Live Review Instead →
          </button>
        </div>
      )}

      {/* Partial Completion / Degraded Stage Warnings Banner */}
      {review.warningMessage && (
        <div
          role="status"
          className="px-4 py-2 bg-[var(--pg-warning-subtle)] border-b border-[var(--pg-border-default)] flex items-start gap-2.5 text-xs text-[var(--pg-text-primary)]"
        >
          <AlertTriangle className="w-4 h-4 text-[var(--pg-warning)] shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold font-mono text-[var(--pg-warning)]">
              REVIEW PIPELINE DIAGNOSTIC NOTICE
            </div>
            <div className="text-[var(--pg-text-secondary)]">{review.warningMessage}</div>
          </div>
        </div>
      )}

      {/* Workspace Summary Strip */}
      <div className="px-4 py-2.5 bg-[var(--pg-bg-surface)] border-b border-[var(--pg-border-default)] flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className="text-sm font-semibold text-[var(--pg-text-primary)] truncate"
              title={review.title}
            >
              {review.title}
            </h1>
            <ReviewStatusLabel status={review.status} />
            <span className="font-mono text-xs text-[var(--pg-text-muted)] tabular-nums">
              ID: {review.id} · {review.durationMs}ms · {review.modelUsed}
            </span>
          </div>
          <p
            className="text-xs text-[var(--pg-text-secondary)] truncate mt-0.5"
            title={review.objective}
          >
            Objective: {review.objective}
          </p>
        </div>

        {/* Severity Distribution Summary & Stage Statuses */}
        <div className="flex flex-wrap items-center gap-4 text-xs font-mono shrink-0">
          <div className="flex items-center gap-3 border-r border-[var(--pg-border-default)] pr-4 tabular-nums">
            <span className="text-[var(--pg-text-muted)]">FINDINGS ({distribution.total}):</span>
            <span className="text-[var(--pg-critical)] font-semibold">
              ◆ {distribution.critical} Crit
            </span>
            <span className="text-[var(--pg-danger)] font-semibold">
              ▲ {distribution.high} High
            </span>
            <span className="text-[var(--pg-warning)]">● {distribution.medium} Med</span>
            <span className="text-[var(--pg-info)]">▪ {distribution.low} Low</span>
          </div>

          {/* Pipeline Stages Summary */}
          <div className="hidden xl:flex items-center gap-3 text-[11px]">
            {review.stages.map((st) => (
              <span
                key={st.stageId}
                title={st.errorMessage || `${st.name} (${st.engine})`}
                className="text-[var(--pg-text-secondary)] tabular-nums"
              >
                {st.stageId === 'static_analysis'
                  ? 'Static'
                  : st.stageId === 'ai_semantic_analysis'
                  ? 'AI Semantic'
                  : 'Corroboration'}
                :{' '}
                <strong
                  className={
                    st.status === 'succeeded'
                      ? 'text-[var(--pg-success)]'
                      : st.status === 'failed' || st.status === 'warning'
                      ? 'text-[var(--pg-warning)]'
                      : 'text-[var(--pg-text-muted)]'
                  }
                >
                  {st.status.toUpperCase()}
                </strong>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile / Tablet Sub-Pane Switcher (< 1024px) */}
      <div className="lg:hidden border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)]">
        <div className="flex">
          <button
            type="button"
            onClick={() => setMobilePane('source')}
            className={`flex-1 py-2 text-xs font-mono border-b-2 cursor-pointer ${
              mobilePane === 'source'
                ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
                : 'border-transparent text-[var(--pg-text-secondary)]'
            }`}
          >
            A. Source ({review.files.length})
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('findings')}
            className={`flex-1 py-2 text-xs font-mono border-b-2 cursor-pointer ${
              mobilePane === 'findings'
                ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
                : 'border-transparent text-[var(--pg-text-secondary)]'
            }`}
          >
            B. Findings ({filteredFindings.length})
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('evidence')}
            className={`flex-1 py-2 text-xs font-mono border-b-2 cursor-pointer ${
              mobilePane === 'evidence'
                ? 'border-[var(--pg-accent)] text-[var(--pg-text-primary)] font-semibold'
                : 'border-transparent text-[var(--pg-text-secondary)]'
            }`}
          >
            C. Evidence{' '}
            {selectedFinding && selectedFinding.location.isValidLocation
              ? `(L${selectedFinding.location.startLine})`
              : ''}
          </button>
        </div>

        {/* Compact Active Finding Context Bar on Mobile/Tablet */}
        {selectedFinding && (
          <div className="px-3 py-1.5 bg-[var(--pg-bg-surface)] border-t border-[var(--pg-border-subtle)] flex items-center justify-between gap-2 text-[11px] font-mono">
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              <SeverityLabel severity={selectedFinding.severity} compact />
              <span className="text-[var(--pg-text-primary)] truncate">
                {selectedFinding.title}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {mobilePane !== 'source' && selectedFinding.location.isValidLocation && (
                <button
                  type="button"
                  onClick={() => setMobilePane('source')}
                  className="px-2 py-0.5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] cursor-pointer"
                >
                  View L{selectedFinding.location.startLine}
                </button>
              )}
              {mobilePane !== 'evidence' && (
                <button
                  type="button"
                  onClick={() => setMobilePane('evidence')}
                  className="px-2 py-0.5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] cursor-pointer"
                >
                  Remediation
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Three-Pane Split Investigation Canvas (Desktop 12-Col Grid: 5 / 4 / 3) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
        {/* ===================================================================
            PANEL A: SOURCE CODE & FILE SWITCHER (5 Columns on Desktop)
            =================================================================== */}
        <section
          aria-label="Source Code Viewer"
          className={`lg:col-span-5 flex flex-col min-h-0 border-r border-[var(--pg-border-default)] ${
            mobilePane === 'source' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* File Switcher Tabs */}
          <div className="px-2 py-1.5 bg-[var(--pg-bg-workspace)] border-b border-[var(--pg-border-default)] flex items-center gap-1 overflow-x-auto">
            {review.files.map((file) => {
              const isSelected = activeFile?.id === file.id;
              const fileFindingCount = review.findings.filter(
                (f) => f.location.fileId === file.id
              ).length;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedFileId(file.id)}
                  title={file.filename}
                  className={`inline-flex items-center gap-2 px-3 py-1 text-xs font-mono transition-colors shrink-0 cursor-pointer border ${
                    isSelected
                      ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] border-[var(--pg-border-strong)] font-semibold'
                      : 'bg-transparent text-[var(--pg-text-secondary)] border-transparent hover:bg-[var(--pg-bg-interactive)] hover:text-[var(--pg-text-primary)]'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5 text-[var(--pg-text-muted)]" />
                  <span>{file.filename.split('/').pop() || file.filename}</span>
                  <span className="text-[11px] text-[var(--pg-text-muted)] tabular-nums">
                    ({fileFindingCount})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Code Viewer Surface */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeFile ? (
              <SourceViewer
                file={activeFile}
                findingsForFile={findingsForActiveFile}
                selectedFinding={selectedFinding}
                onSelectFinding={(f) => {
                  handleSelectFinding(f);
                  if (window.innerWidth < 1024) {
                    setMobilePane('evidence');
                  }
                }}
              />
            ) : (
              <div className="p-6 text-xs font-mono text-[var(--pg-text-muted)]">
                No source files recorded in this review.
              </div>
            )}
          </div>
        </section>

        {/* ===================================================================
            PANEL B: PRIORITIZED FINDINGS & FILTER BAR (4 Columns on Desktop)
            =================================================================== */}
        <section
          aria-label="Prioritized Review Findings"
          className={`lg:col-span-4 flex flex-col min-h-0 border-r border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] ${
            mobilePane === 'findings' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Filter & Search Toolbar */}
          <div className="p-3 bg-[var(--pg-bg-surface)] border-b border-[var(--pg-border-default)] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-[var(--pg-text-primary)]">
                <Filter className="w-3.5 h-3.5 text-[var(--pg-text-muted)]" />
                <span className="tabular-nums">
                  FINDINGS ({filteredFindings.length} / {review.findings.length})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="hidden sm:inline font-mono text-[10px] text-[var(--pg-text-muted)]"
                  title="Use J / K or Down / Up arrow keys to step through findings"
                >
                  J/K or ↑↓ nav
                </span>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="inline-flex items-center gap-1 text-xs font-mono text-[var(--pg-info)] hover:underline cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset Filters</span>
                  </button>
                )}
              </div>
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--pg-text-muted)] absolute left-2.5 top-2" />
              <input
                type="search"
                aria-label="Filter findings by keyword, rule ID, or file"
                placeholder="Filter by title, rule ID (e.g. PG-SEC-001), or file..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 text-xs font-mono bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] placeholder:text-[var(--pg-text-muted)] focus:outline-none focus:border-[var(--pg-accent)]"
              />
            </div>

            {/* 4-Column Filter Selectors */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs font-mono">
              <select
                aria-label="Filter by Severity"
                value={severityFilter}
                onChange={(e) =>
                  setSeverityFilter(e.target.value as SeverityLevel | 'all')
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">Severity: All</option>
                <option value="critical">◆ Critical</option>
                <option value="high">▲ High</option>
                <option value="medium">● Medium</option>
                <option value="low">▪ Low</option>
                <option value="info">○ Info</option>
              </select>

              <select
                aria-label="Filter by Category"
                value={categoryFilter}
                onChange={(e) =>
                  setCategoryFilter(e.target.value as FindingCategory | 'all')
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">Category: All</option>
                <option value="security">Security</option>
                <option value="concurrency">Concurrency</option>
                <option value="boundary">Boundary</option>
                <option value="error-handling">Error Handling</option>
                <option value="performance">Performance</option>
                <option value="correctness">Correctness</option>
                <option value="data-integrity">Data Integrity</option>
                <option value="maintainability">Maintainability</option>
              </select>

              <select
                aria-label="Filter by Triage Status"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as FindingStatus | 'all')
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">Status: All</option>
                <option value="unreviewed">Unreviewed</option>
                <option value="reviewed">Reviewed</option>
                <option value="dismissed">Dismissed</option>
                <option value="reopened">Reopened</option>
              </select>

              <select
                aria-label="Filter by Confidence or File"
                value={fileFilter !== 'all' ? `file:${fileFilter}` : `conf:${confidenceFilter}`}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.startsWith('file:')) {
                    setFileFilter(val.replace('file:', ''));
                    setConfidenceFilter('all');
                  } else {
                    setFileFilter('all');
                    setConfidenceFilter(
                      val.replace('conf:', '') as 'high' | 'medium' | 'low' | 'all'
                    );
                  }
                }}
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="conf:all">Conf / File: All</option>
                <option value="conf:high">Conf: High</option>
                <option value="conf:medium">Conf: Medium</option>
                <option value="conf:low">Conf: Low</option>
                {review.files.map((f) => (
                  <option key={f.id} value={`file:${f.id}`}>
                    File: {f.filename.split('/').pop() || f.filename}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Findings List Surface */}
          <div className="flex-1 overflow-y-auto divide-y divide-[var(--pg-border-default)]">
            {review.findings.length === 0 ? (
              /* Zero-Findings Review State (Distinguished from Filter-Empty State) */
              <div className="p-6 space-y-3 text-xs">
                <div className="flex items-center gap-2 text-[var(--pg-success)] font-mono font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>ZERO DEFECTS DETECTED IN ANALYZED SOURCE</span>
                </div>
                <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                  The deterministic static analyzer and semantic corroboration completed without
                  flagging any defects for the submitted code.
                </p>
                <div className="p-3 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] font-mono text-[11px] text-[var(--pg-text-muted)] space-y-1">
                  <div>
                    Scope Note: Automated static and semantic checks inspect only the submitted file
                    contents and cannot verify external runtime infrastructure or unsubmitted
                    dependencies.
                  </div>
                </div>
              </div>
            ) : filteredFindings.length === 0 ? (
              /* Filter-Mismatch Empty State */
              <div className="p-6 space-y-3 text-xs">
                <div className="font-mono text-[var(--pg-warning)] font-semibold">
                  0 FINDINGS MATCH CURRENT FILTERS
                </div>
                <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                  This review contains {review.findings.length} total finding(s), but none match the
                  active filter criteria.
                </p>
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
                >
                  Clear Active Filters
                </button>
              </div>
            ) : (
              filteredFindings.map((finding) => {
                const isSelected = selectedFinding?.id === finding.id;
                const shortFile =
                  finding.location.filename.split('/').pop() || finding.location.filename;
                const ruleId = finding.staticCorroboration?.ruleId;
                return (
                  <div
                    key={finding.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => {
                      handleSelectFinding(finding, true);
                      if (window.innerWidth < 1024 && !isSelected) {
                        setMobilePane('evidence');
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectFinding(finding, true);
                        if (window.innerWidth < 1024 && !isSelected) {
                          setMobilePane('evidence');
                        }
                      }
                    }}
                    className={`p-3.5 transition-colors cursor-pointer select-none ${
                      isSelected
                        ? 'bg-[var(--pg-bg-elevated)] ring-1 ring-inset ring-[var(--pg-border-strong)]'
                        : 'bg-[var(--pg-bg-surface)] hover:bg-[var(--pg-bg-workspace)]'
                    }`}
                  >
                    {/* Row 1: Severity + Category + Rule ID + Review Status */}
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityLabel severity={finding.severity} compact />
                        <span className="font-mono text-[11px] text-[var(--pg-text-muted)] uppercase">
                          {finding.category}
                        </span>
                        {ruleId && (
                          <span className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                            [{ruleId}]
                          </span>
                        )}
                      </div>
                      <FindingStatusLabel status={finding.status} />
                    </div>

                    {/* Row 2: Finding Title */}
                    <div className="text-xs font-semibold text-[var(--pg-text-primary)] leading-snug mb-1">
                      {finding.title}
                    </div>

                    {/* Row 3: Concise Technical Explanation Preview */}
                    <p className="text-[11px] text-[var(--pg-text-secondary)] line-clamp-2 leading-relaxed mb-2">
                      {finding.explanation}
                    </p>

                    {/* Row 4: Verified File + Line Range + Confidence + Engine */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[var(--pg-text-muted)] tabular-nums pt-1 border-t border-[var(--pg-border-subtle)]">
                      <span
                        className="truncate max-w-[210px] text-[var(--pg-text-secondary)]"
                        title={finding.location.filename}
                      >
                        {finding.location.isValidLocation ? (
                          <>
                            {shortFile}:L{finding.location.startLine}
                            {finding.location.endLine !== finding.location.startLine
                              ? `–${finding.location.endLine}`
                              : ''}
                          </>
                        ) : (
                          <span className="text-[var(--pg-warning)]">
                            {shortFile} · Location Quarantined
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span>Engine: {formatSourceEngineShort(finding.analysisSource)}</span>
                        <span>·</span>
                        <span>Conf: {finding.confidence.toUpperCase()}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ===================================================================
            PANEL C: EVIDENCE, REMEDIATION & TRIAGE ACTIONS (3 Columns on Desktop)
            =================================================================== */}
        <section
          aria-label="Finding Evidence and Remediation Details"
          className={`lg:col-span-3 flex flex-col min-h-0 bg-[var(--pg-bg-surface)] overflow-y-auto ${
            mobilePane === 'evidence' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {selectedFinding ? (
            <div className="flex flex-col h-full">
              {/* Sticky Evidence Navigation & Step Header */}
              <div className="px-4 py-2 bg-[var(--pg-bg-workspace)] border-b border-[var(--pg-border-default)] flex items-center justify-between gap-2 text-xs font-mono shrink-0">
                <span className="text-[11px] text-[var(--pg-text-secondary)] tabular-nums">
                  {selectedFindingIndex >= 0
                    ? `FINDING ${selectedFindingIndex + 1} OF ${filteredFindings.length}`
                    : 'FINDING DETAILS'}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={filteredFindings.length <= 1}
                    onClick={() => handleStepFinding(-1)}
                    title="Previous finding (K or Up Arrow)"
                    aria-label="Previous finding"
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronUp className="w-3 h-3" />
                    <span>Prev</span>
                  </button>
                  <button
                    type="button"
                    disabled={filteredFindings.length <= 1}
                    onClick={() => handleStepFinding(1)}
                    title="Next finding (J or Down Arrow)"
                    aria-label="Next finding"
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] disabled:opacity-40 cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" />
                    <span>Next</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFindingId(null);
                      setLiveStatusAnnouncement('Deselected finding.');
                    }}
                    title="Deselect finding (Esc)"
                    className="px-2 py-0.5 text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    Deselect
                  </button>
                </div>
              </div>

              {/* 7-Section Structured Engineering Evidence Body */}
              <div className="p-4 space-y-5 text-xs flex-1 overflow-y-auto">
                {/* SECTION 01: WHAT WAS DETECTED */}
                <div className="border-b border-[var(--pg-border-default)] pb-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-[var(--pg-text-muted)] uppercase">
                    <span>01 · WHAT WAS DETECTED</span>
                    <span>ID: {selectedFinding.id}</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SeverityLabel severity={selectedFinding.severity} />
                    <FindingStatusLabel status={selectedFinding.status} />
                  </div>

                  <h2 className="text-sm font-semibold text-[var(--pg-text-primary)] leading-snug">
                    {selectedFinding.title}
                  </h2>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--pg-text-secondary)] tabular-nums">
                    <span>Category: {selectedFinding.category}</span>
                    {selectedFinding.staticCorroboration?.ruleId && (
                      <span>Rule: {selectedFinding.staticCorroboration.ruleId}</span>
                    )}
                    {selectedFinding.location.isValidLocation ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFileId(selectedFinding.location.fileId);
                          if (window.innerWidth < 1024) {
                            setMobilePane('source');
                          }
                        }}
                        className="text-[var(--pg-accent-text)] hover:underline cursor-pointer"
                      >
                        {selectedFinding.location.filename}:L{selectedFinding.location.startLine}
                        {selectedFinding.location.endLine !== selectedFinding.location.startLine
                          ? `–L${selectedFinding.location.endLine}`
                          : ''}
                      </button>
                    ) : (
                      <span className="text-[var(--pg-warning)]">
                        {selectedFinding.location.filename} (Location Quarantined)
                      </span>
                    )}
                  </div>
                </div>

                {/* SECTION 02: WHY IT MATTERS */}
                <div className="space-y-1.5">
                  <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)] uppercase">
                    02 · WHY IT MATTERS (TECHNICAL EXPLANATION)
                  </div>
                  <p className="text-[var(--pg-text-primary)] leading-relaxed">
                    {selectedFinding.explanation}
                  </p>
                </div>

                {/* SECTION 03: SUPPORTING CODE EVIDENCE */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="font-semibold text-[var(--pg-text-secondary)] uppercase">
                      03 · SUPPORTING CODE EVIDENCE
                    </span>
                    {selectedFinding.location.isValidLocation && (
                      <span className="text-[var(--pg-text-muted)] tabular-nums">
                        Verified L{selectedFinding.location.startLine}–L
                        {selectedFinding.location.endLine}
                      </span>
                    )}
                  </div>

                  {selectedFinding.location.isValidLocation &&
                  selectedFinding.location.rawSnippet ? (
                    <div className="bg-[var(--pg-bg-code)] border border-[var(--pg-border-default)] font-mono text-[11.5px] overflow-x-auto leading-relaxed">
                      <table className="w-full border-collapse">
                        <tbody>
                          {selectedFinding.location.rawSnippet
                            .split(/\r?\n/)
                            .map((line: string, idx: number) => {
                              const lineNum = selectedFinding.location.startLine + idx;
                              return (
                                <tr
                                  key={lineNum}
                                  className="border-b border-[var(--pg-border-subtle)] last:border-b-0"
                                >
                                  <td className="w-10 px-2 py-0.5 text-right select-none bg-[var(--pg-bg-code-gutter)] border-r border-[var(--pg-border-subtle)] text-[var(--pg-text-muted)] tabular-nums">
                                    {lineNum}
                                  </td>
                                  <td className="px-2.5 py-0.5 text-[var(--pg-text-primary)] whitespace-pre">
                                    {line || ' '}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-2.5 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] font-mono text-[11px] text-[var(--pg-warning)]">
                      {selectedFinding.location.validationNote ||
                        `Location Quarantined: The model reported line numbers outside the verified bounds of ${selectedFinding.location.filename}. PatchGuard never fabricates or clamps unverified code snippets.`}
                    </div>
                  )}
                </div>

                {/* SECTION 04: POTENTIAL IMPACT */}
                <div className="space-y-1.5">
                  <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)] uppercase">
                    04 · POTENTIAL OPERATIONAL & SECURITY IMPACT
                  </div>
                  <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                    {selectedFinding.potentialImpact}
                  </p>
                </div>

                {/* SECTION 05: RECOMMENDED REMEDIATION (UNVERIFIED SUGGESTED FIX) */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[11px]">
                    <span className="font-semibold text-[var(--pg-accent-text)] uppercase">
                      05 · RECOMMENDED REMEDIATION
                    </span>
                    <span className="text-[10px] text-[var(--pg-warning)]">
                      [UNVERIFIED SUGGESTED FIX]
                    </span>
                  </div>
                  <p className="text-[var(--pg-text-primary)] leading-relaxed">
                    {selectedFinding.suggestedRemediation}
                  </p>
                  {selectedFinding.remediationCode && (
                    <pre className="p-2.5 bg-[var(--pg-bg-code)] border border-[var(--pg-border-default)] font-mono text-[11.5px] text-[var(--pg-accent-text)] overflow-x-auto whitespace-pre leading-relaxed">
                      {selectedFinding.remediationCode}
                    </pre>
                  )}
                  <div className="p-2 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] font-mono text-[10.5px] text-[var(--pg-text-muted)] leading-relaxed">
                    Verification Notice: Remediation snippets are advisory patterns and are not
                    automatically compiled or unit-tested against your repository. Validate types,
                    invariants, and call-site contracts before applying.
                  </div>
                </div>

                {/* SECTION 06: CONFIDENCE & ENGINE PROVENANCE */}
                <div className="p-3 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] space-y-2">
                  <div className="font-mono text-[11px] font-semibold text-[var(--pg-text-secondary)] uppercase">
                    06 · CONFIDENCE & ENGINE PROVENANCE
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-[var(--pg-text-muted)]">CONFIDENCE LEVEL</span>
                    <span className="text-[var(--pg-text-primary)] uppercase font-semibold">
                      {selectedFinding.confidence}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-[var(--pg-text-muted)]">DETECTION ENGINE</span>
                    <AnalysisSourceLabel source={selectedFinding.analysisSource} />
                  </div>
                  {selectedFinding.staticCorroboration && (
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[var(--pg-text-muted)]">STATIC CORROBORATION</span>
                      <span className="text-[var(--pg-text-primary)]">
                        {selectedFinding.staticCorroboration.ruleId} (
                        {selectedFinding.staticCorroboration.engineName})
                      </span>
                    </div>
                  )}
                  {selectedFinding.uncertaintyNote && (
                    <p className="text-[11px] text-[var(--pg-text-secondary)] pt-1 border-t border-[var(--pg-border-subtle)] leading-relaxed">
                      Note: {selectedFinding.uncertaintyNote}
                    </p>
                  )}
                </div>

                {/* SECTION 07: VERIFICATION & REVIEW STATUS ACTIONS */}
                <div className="pt-2 border-t border-[var(--pg-border-default)] space-y-2.5">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="font-semibold text-[var(--pg-text-secondary)] uppercase">
                      07 · VERIFICATION & REVIEW STATUS
                    </span>
                    <FindingStatusLabel status={selectedFinding.status} />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {selectedFinding.status !== 'reviewed' ? (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(selectedFinding, 'reviewed')}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-xs bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] font-semibold hover:bg-[var(--pg-accent-hover)] transition-colors cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Mark Reviewed</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(selectedFinding, 'reopened')}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reopen Finding</span>
                      </button>
                    )}

                    {selectedFinding.status !== 'dismissed' ? (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(selectedFinding, 'dismissed')}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Dismiss Finding</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(selectedFinding, 'reopened')}
                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reopen Finding</span>
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyFindingDetails(selectedFinding)}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] transition-colors cursor-pointer"
                  >
                    {copiedId === selectedFinding.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[var(--pg-success)]" />
                        <span className="text-[var(--pg-success)]">
                          Copied Evidence Report to Clipboard
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Finding & Remediation Report</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Deselected or No-Finding Workspace Overview in Panel C */
            <div className="p-6 text-xs font-mono text-[var(--pg-text-muted)] space-y-4">
              <div className="flex items-center gap-2 text-[var(--pg-text-secondary)] font-semibold">
                <ShieldAlert className="w-4 h-4 text-[var(--pg-accent-text)]" />
                <span>NO ACTIVE FINDING SELECTED</span>
              </div>
              <p className="font-sans text-[var(--pg-text-secondary)] leading-relaxed">
                Select any finding in Panel B or click a flagged severity glyph in the source code
                gutter to inspect its verified line evidence, impact analysis, and suggested
                remediation.
              </p>

              {filteredFindings.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleSelectFinding(filteredFindings[0])}
                  className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] font-semibold hover:bg-[var(--pg-accent-hover)] cursor-pointer"
                >
                  Inspect First Finding (
                  {filteredFindings[0].staticCorroboration?.ruleId ||
                    filteredFindings[0].severity.toUpperCase()}
                  )
                </button>
              )}

              <div className="pt-3 border-t border-[var(--pg-border-default)] space-y-1.5 text-[11px]">
                <div className="text-[var(--pg-text-secondary)] font-semibold">
                  ACTIVE REVIEW SUMMARY
                </div>
                <div>Files Analyzed: {review.files.length}</div>
                <div>Total Findings: {review.findings.length}</div>
                <div>Model & Engine Stack: {review.modelUsed}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
