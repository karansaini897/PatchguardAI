import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalysisSourceType,
  FindingCategory,
  FindingStatus,
  ReviewFinding,
  ReviewRecord,
  SeverityLevel,
} from '../types/patchguard';
import {
  resolveTargetSourceFile,
  sortFindingsBySeverity,
  verifyReviewFindingsIntegrity,
} from '../lib/staticAnalyzer';
import { computeSeverityDistribution } from '../lib/evaluationMath';
import { persistence, WorkspaceLayoutPrefs } from '../lib/persistence';
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
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  FileCode2,
  Filter,
  Layers,
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

const DEFAULT_LAYOUT: WorkspaceLayoutPrefs = {
  sourceWidthPercent: 44,
  findingsWidthPercent: 28,
};

function clampWorkspaceLayout(prefs: WorkspaceLayoutPrefs): WorkspaceLayoutPrefs {
  const source = Math.max(25, Math.min(56, Math.round(prefs.sourceWidthPercent)));
  const maxFindings = Math.min(45, 100 - source - 22);
  const findings = Math.max(20, Math.min(maxFindings, Math.round(prefs.findingsWidthPercent)));
  return {
    sourceWidthPercent: source,
    findingsWidthPercent: findings,
  };
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

  // Resizable panel proportions (persisted via localStorage)
  const [layoutPrefs, setLayoutPrefs] = useState<WorkspaceLayoutPrefs>(() =>
    clampWorkspaceLayout(persistence.getWorkspaceLayout())
  );
  const workspaceContainerRef = useRef<HTMLDivElement | null>(null);
  const activeDragHandleRef = useRef<'left' | 'right' | null>(null);

  // Analysis stages drawer visibility
  const [showStagesPanel, setShowStagesPanel] = useState<boolean>(false);

  // Finding filters
  const [severityFilter, setSeverityFilter] = useState<SeverityLevel | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<FindingCategory | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<AnalysisSourceType | 'all'>('all');
  const [confidenceFilter, setConfidenceFilter] = useState<'high' | 'medium' | 'low' | 'all'>(
    'all'
  );
  const [statusFilter, setStatusFilter] = useState<FindingStatus | 'all'>('all');
  const [fileFilter, setFileFilter] = useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Mobile/Tablet active sub-pane ('source' | 'findings' | 'evidence')
  const [mobilePane, setMobilePane] = useState<'source' | 'findings' | 'evidence'>('findings');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedRemediationId, setCopiedRemediationId] = useState<string | null>(null);
  const [liveStatusAnnouncement, setLiveStatusAnnouncement] = useState<string>('');

  // Defensively verify all findings against the exact source files in this review
  const verifiedFindings = useMemo(() => {
    if (!review) return [];
    const checked = verifyReviewFindingsIntegrity(review.findings, review.files);
    return sortFindingsBySeverity(checked);
  }, [review]);

  // Synchronize default file, first finding, and stages drawer when active review changes
  useEffect(() => {
    if (!review) {
      setSelectedFileId('');
      setSelectedFindingId(null);
      setShowStagesPanel(false);
      return;
    }

    const hasDegradedStage =
      review.status === 'completed_with_warnings' ||
      review.status === 'failed' ||
      review.stages.some((s) => s.status === 'failed' || s.status === 'warning');
    setShowStagesPanel(hasDegradedStage);

    const targetFinding =
      (initialSelectedFindingId &&
        verifiedFindings.find((f) => f.id === initialSelectedFindingId)) ||
      verifiedFindings[0] ||
      null;

    if (targetFinding) {
      setSelectedFindingId(targetFinding.id);
      const resolvedFile = resolveTargetSourceFile(
        review.files,
        targetFinding.location.fileId,
        targetFinding.location.filename
      );
      if (resolvedFile && targetFinding.location.isValidLocation) {
        setSelectedFileId(resolvedFile.id);
      } else {
        setSelectedFileId(review.files[0]?.id || '');
      }
    } else {
      setSelectedFindingId(null);
      setSelectedFileId(review.files[0]?.id || '');
    }

    setSeverityFilter('all');
    setCategoryFilter('all');
    setSourceFilter('all');
    setConfidenceFilter('all');
    setStatusFilter('all');
    setFileFilter('all');
    setSearchQuery('');
    setLiveStatusAnnouncement('');
  }, [review?.id, initialSelectedFindingId]);

  // Pointer drag handlers for desktop resizable panels
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!activeDragHandleRef.current || !workspaceContainerRef.current) return;
      const rect = workspaceContainerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relPercent = ((e.clientX - rect.left) / rect.width) * 100;

      setLayoutPrefs((prev) => {
        let next: WorkspaceLayoutPrefs;
        if (activeDragHandleRef.current === 'left') {
          next = clampWorkspaceLayout({
            sourceWidthPercent: relPercent,
            findingsWidthPercent: prev.findingsWidthPercent,
          });
        } else {
          const desiredFindings = relPercent - prev.sourceWidthPercent;
          next = clampWorkspaceLayout({
            sourceWidthPercent: prev.sourceWidthPercent,
            findingsWidthPercent: desiredFindings,
          });
        }
        persistence.saveWorkspaceLayout(next);
        return next;
      });
    };

    const handleMouseUp = () => {
      if (activeDragHandleRef.current) {
        activeDragHandleRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const updateLayoutAndPersist = (next: WorkspaceLayoutPrefs) => {
    const clamped = clampWorkspaceLayout(next);
    setLayoutPrefs(clamped);
    persistence.saveWorkspaceLayout(clamped);
  };

  const isCustomLayout =
    layoutPrefs.sourceWidthPercent !== DEFAULT_LAYOUT.sourceWidthPercent ||
    layoutPrefs.findingsWidthPercent !== DEFAULT_LAYOUT.findingsWidthPercent;

  const evidenceWidthPercent = Math.max(
    22,
    100 - layoutPrefs.sourceWidthPercent - layoutPrefs.findingsWidthPercent
  );

  // Filter findings using verified file resolution and all filter facets
  const filteredFindings = useMemo(() => {
    if (!review) return [];
    return verifiedFindings.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
      if (categoryFilter !== 'all' && f.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && f.analysisSource !== sourceFilter) return false;
      if (confidenceFilter !== 'all' && f.confidence !== confidenceFilter) return false;
      if (statusFilter !== 'all' && f.status !== statusFilter) return false;
      if (fileFilter !== 'all') {
        const resolved = resolveTargetSourceFile(
          review.files,
          f.location.fileId,
          f.location.filename
        );
        if (!resolved || resolved.id !== fileFilter) return false;
      }
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const ruleId = f.staticCorroboration?.ruleId || '';
        const hay = `${f.title} ${f.explanation} ${f.location.filename} ${ruleId} ${f.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    review,
    verifiedFindings,
    severityFilter,
    categoryFilter,
    sourceFilter,
    confidenceFilter,
    statusFilter,
    fileFilter,
    searchQuery,
  ]);

  const selectedFinding: ReviewFinding | null = useMemo(() => {
    if (!selectedFindingId) return null;
    return verifiedFindings.find((f) => f.id === selectedFindingId) || null;
  }, [verifiedFindings, selectedFindingId]);

  const selectedFindingTargetFile = useMemo(() => {
    if (!review || !selectedFinding) return null;
    return resolveTargetSourceFile(
      review.files,
      selectedFinding.location.fileId,
      selectedFinding.location.filename
    );
  }, [review, selectedFinding]);

  const selectedFindingIndex = useMemo(() => {
    if (!selectedFinding) return -1;
    return filteredFindings.findIndex((f) => f.id === selectedFinding.id);
  }, [filteredFindings, selectedFinding]);

  const activeFile = useMemo(() => {
    if (!review || review.files.length === 0) return null;
    return review.files.find((f) => f.id === selectedFileId) || review.files[0];
  }, [review, selectedFileId]);

  // Only pass verified findings that resolve unambiguously to activeFile
  const findingsForActiveFile = useMemo(() => {
    if (!review || !activeFile) return [];
    return verifiedFindings.filter((f) => {
      if (!f.location.isValidLocation) return false;
      const resolved = resolveTargetSourceFile(
        review.files,
        f.location.fileId,
        f.location.filename
      );
      return resolved?.id === activeFile.id;
    });
  }, [review, activeFile, verifiedFindings]);

  const distribution = useMemo(
    () => computeSeverityDistribution(verifiedFindings),
    [verifiedFindings]
  );

  const quarantinedFindingsCount = useMemo(
    () => verifiedFindings.filter((f) => !f.location.isValidLocation).length,
    [verifiedFindings]
  );

  const hasActiveFilters =
    severityFilter !== 'all' ||
    categoryFilter !== 'all' ||
    sourceFilter !== 'all' ||
    confidenceFilter !== 'all' ||
    statusFilter !== 'all' ||
    fileFilter !== 'all' ||
    searchQuery.trim() !== '';

  const resetAllFilters = () => {
    setSeverityFilter('all');
    setCategoryFilter('all');
    setSourceFilter('all');
    setConfidenceFilter('all');
    setStatusFilter('all');
    setFileFilter('all');
    setSearchQuery('');
    setLiveStatusAnnouncement('Reset all finding filters.');
  };

  // Navigate to a finding only after verifying both its location integrity and target file association
  const handleSelectFinding = (finding: ReviewFinding, allowToggleDeselect = false) => {
    if (allowToggleDeselect && selectedFindingId === finding.id) {
      setSelectedFindingId(null);
      setLiveStatusAnnouncement(`Deselected finding ${finding.title}.`);
      return;
    }
    setSelectedFindingId(finding.id);

    if (review && finding.location.isValidLocation) {
      const targetFile = resolveTargetSourceFile(
        review.files,
        finding.location.fileId,
        finding.location.filename
      );
      // Only switch active file when the finding has a verified location and resolves unambiguously to a file in this review
      if (targetFile && targetFile.id !== selectedFileId) {
        setSelectedFileId(targetFile.id);
      }
    }
  };

  const handleNavigateToFindingSource = (finding: ReviewFinding) => {
    if (!review || !finding.location.isValidLocation) return;
    const targetFile = resolveTargetSourceFile(
      review.files,
      finding.location.fileId,
      finding.location.filename
    );
    if (!targetFile) return;
    setSelectedFileId(targetFile.id);
    if (window.innerWidth < 1024) {
      setMobilePane('source');
    }
    setLiveStatusAnnouncement(
      `Navigated to ${targetFile.filename} line ${finding.location.startLine}.`
    );
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
          target.getAttribute('role') === 'separator' ||
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
      : `${finding.location.filename} (Unverified Location · ${
          finding.location.locationReason || 'quarantined'
        })`;
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

  const handleCopyRemediationOnly = (finding: ReviewFinding) => {
    const text = finding.remediationCode
      ? `${finding.suggestedRemediation}\n\n${finding.remediationCode}`
      : finding.suggestedRemediation;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedRemediationId(finding.id);
    setLiveStatusAnnouncement(
      `Copied suggested remediation for ${finding.title}. Finding status remains ${finding.status}.`
    );
    setTimeout(() => setCopiedRemediationId(null), 1800);
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
    <div className="flex flex-col lg:h-[calc(100vh-5.25rem)] min-h-[560px] bg-[var(--pg-bg-canvas)] overflow-x-hidden lg:overflow-hidden">
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
              Pre-computed static demonstration of PR #418 ({verifiedFindings.length} verified
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

      {/* Partial Completion / Degraded Stage / Quarantine Warnings Banner */}
      {(review.warningMessage || quarantinedFindingsCount > 0) && (
        <div
          role="status"
          className="px-4 py-2 bg-[var(--pg-warning-subtle)] border-b border-[var(--pg-border-default)] flex items-start justify-between gap-4 text-xs text-[var(--pg-text-primary)]"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-[var(--pg-warning)] shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold font-mono text-[var(--pg-warning)]">
                REVIEW PIPELINE & LOCATION VERIFICATION NOTICE
              </div>
              {review.warningMessage && (
                <div className="text-[var(--pg-text-secondary)]">{review.warningMessage}</div>
              )}
              {quarantinedFindingsCount > 0 && !review.warningMessage?.includes('quarantined') && (
                <div className="text-[var(--pg-text-secondary)]">
                  {quarantinedFindingsCount} finding(s) contained unverified or out-of-bounds
                  source locations and were quarantined by the frontend location verifier.
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowStagesPanel((prev) => !prev)}
            className="px-2.5 py-1 font-mono text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] shrink-0 cursor-pointer"
          >
            {showStagesPanel ? 'Hide Stage Telemetry' : 'Inspect Stage Telemetry'}
          </button>
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

        {/* Severity Distribution Bar, Counts, Stage Drawer Toggle & Split Reset */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-xs font-mono max-w-full min-w-0">
          {/* Proportional Severity Distribution Bar (only when findings exist) */}
          {distribution.total > 0 && (
            <div
              aria-label="Severity distribution bar"
              title={`Critical: ${distribution.critical}, High: ${distribution.high}, Medium: ${distribution.medium}, Low: ${distribution.low}, Info: ${distribution.info}`}
              className="hidden sm:flex w-24 h-2 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] overflow-hidden"
            >
              {(['critical', 'high', 'medium', 'low', 'info'] as SeverityLevel[]).map((sev) => {
                const count = distribution[sev];
                if (count <= 0) return null;
                const pct = (count / distribution.total) * 100;
                return (
                  <div
                    key={sev}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: SEVERITY_META[sev].barColor,
                    }}
                  />
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 sm:border-r border-[var(--pg-border-default)] sm:pr-3 tabular-nums">
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

          <button
            type="button"
            onClick={() => setShowStagesPanel((prev) => !prev)}
            aria-expanded={showStagesPanel}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors cursor-pointer ${
              showStagesPanel
                ? 'border-[var(--pg-border-strong)] bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)]'
                : 'border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Analysis Stages ({review.stages.length})</span>
          </button>

          {isCustomLayout && (
            <button
              type="button"
              onClick={() => updateLayoutAndPersist(DEFAULT_LAYOUT)}
              title="Reset desktop panel widths to default (44% / 28% / 28%)"
              className="hidden lg:inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-muted)] hover:text-[var(--pg-text-primary)] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Split</span>
            </button>
          )}
        </div>
      </div>

      {/* Expandable Analysis Stages & Pipeline Telemetry Panel */}
      {showStagesPanel && (
        <section
          aria-label="Analysis pipeline stages breakdown"
          className="px-4 py-3 bg-[var(--pg-bg-workspace)] border-b border-[var(--pg-border-default)] grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono"
        >
          {review.stages.map((st) => {
            const statusColor =
              st.status === 'succeeded'
                ? 'text-[var(--pg-success)]'
                : st.status === 'failed'
                ? 'text-[var(--pg-danger)]'
                : st.status === 'warning'
                ? 'text-[var(--pg-warning)]'
                : 'text-[var(--pg-text-muted)]';

            return (
              <div
                key={st.stageId}
                className="p-2.5 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--pg-text-primary)] truncate">
                    {st.name}
                  </span>
                  <span className={`font-semibold uppercase ${statusColor}`}>
                    {st.status}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--pg-text-secondary)] truncate">
                  Engine: {st.engine}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--pg-text-muted)] tabular-nums pt-0.5">
                  <span>Duration: {st.durationMs}ms</span>
                  <span>Findings: {st.findingsProduced}</span>
                  {typeof st.attempts === 'number' && st.attempts > 0 && (
                    <span>
                      Attempts: {st.attempts}
                      {st.retriedCount ? ` (${st.retriedCount} retries)` : ''}
                    </span>
                  )}
                </div>
                {(st.errorCode || st.errorMessage) && (
                  <div className="pt-1 border-t border-[var(--pg-border-subtle)] text-[11px] text-[var(--pg-warning)] break-words">
                    {st.errorCode ? `[${st.errorCode}] ` : ''}
                    {st.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

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
              {mobilePane !== 'source' &&
                selectedFinding.location.isValidLocation &&
                selectedFindingTargetFile && (
                  <button
                    type="button"
                    onClick={() => handleNavigateToFindingSource(selectedFinding)}
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

      {/* Three-Pane Resizable Investigation Canvas */}
      <div
        ref={workspaceContainerRef}
        className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden"
      >
        {/* ===================================================================
            PANEL A: SOURCE CODE & FILE SWITCHER
            =================================================================== */}
        <section
          aria-label="Source Code Viewer"
          style={{ width: `${layoutPrefs.sourceWidthPercent}%` }}
          className={`max-lg:!w-full flex-1 lg:flex-none flex flex-col min-h-0 min-w-0 border-r border-[var(--pg-border-default)] ${
            mobilePane === 'source' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* File Switcher Tabs with Language, Change Status, Line Count & Verified Finding Count */}
          <div className="px-2 py-1.5 bg-[var(--pg-bg-workspace)] border-b border-[var(--pg-border-default)] flex items-center gap-1 overflow-x-auto">
            {review.files.map((file) => {
              const isSelected = activeFile?.id === file.id;
              const fileFindingCount = verifiedFindings.filter((f) => {
                const resolved = resolveTargetSourceFile(
                  review.files,
                  f.location.fileId,
                  f.location.filename
                );
                return resolved?.id === file.id;
              }).length;
              const changeBadge =
                file.changeStatus === 'modified'
                  ? 'MOD'
                  : file.changeStatus === 'added'
                  ? 'ADD'
                  : 'SNIP';

              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedFileId(file.id)}
                  title={`${file.filename} (${file.language.toUpperCase()} · ${file.changeStatus} · ${file.lineCount} lines)`}
                  className={`inline-flex items-center gap-2 px-3 py-1 text-xs font-mono transition-colors shrink-0 cursor-pointer border ${
                    isSelected
                      ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] border-[var(--pg-border-strong)] font-semibold'
                      : 'bg-transparent text-[var(--pg-text-secondary)] border-transparent hover:bg-[var(--pg-bg-interactive)] hover:text-[var(--pg-text-primary)]'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5 text-[var(--pg-text-muted)]" />
                  <span>{file.filename.split('/').pop() || file.filename}</span>
                  <span className="text-[10px] text-[var(--pg-text-muted)] uppercase">
                    {changeBadge} · {file.lineCount}L
                  </span>
                  <span className="text-[11px] text-[var(--pg-accent-text)] tabular-nums">
                    ({fileFindingCount})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Cross-File or Quarantined Location Context Strip in Panel A */}
          {selectedFinding &&
            (!selectedFinding.location.isValidLocation ||
              (selectedFindingTargetFile &&
                activeFile &&
                selectedFindingTargetFile.id !== activeFile.id)) && (
              <div className="px-3 py-1.5 bg-[var(--pg-bg-surface)] border-b border-[var(--pg-border-default)] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                {selectedFinding.location.isValidLocation && selectedFindingTargetFile ? (
                  <>
                    <span className="text-[var(--pg-text-secondary)] truncate">
                      Selected finding{' '}
                      <strong className="text-[var(--pg-text-primary)]">
                        {selectedFinding.title}
                      </strong>{' '}
                      is located in{' '}
                      <span className="text-[var(--pg-accent-text)]">
                        {selectedFindingTargetFile.filename}:L{selectedFinding.location.startLine}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleNavigateToFindingSource(selectedFinding)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--pg-border-strong)] bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] hover:bg-[var(--pg-bg-interactive)] shrink-0 cursor-pointer"
                    >
                      <CornerDownRight className="w-3 h-3" />
                      <span>
                        Jump to {selectedFindingTargetFile.filename.split('/').pop()}:L
                        {selectedFinding.location.startLine}
                      </span>
                    </button>
                  </>
                ) : (
                  <span className="text-[var(--pg-warning)]">
                    △ Selected finding has an unverified/quarantined location (
                    {selectedFinding.location.locationReason || 'out-of-bounds'}) — line
                    highlighting suppressed.
                  </span>
                )}
              </div>
            )}

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

        {/* RESIZE HANDLE 1: Between Panel A (Source) and Panel B (Findings) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize source viewer and findings panel"
          aria-valuemin={25}
          aria-valuemax={56}
          aria-valuenow={Math.round(layoutPrefs.sourceWidthPercent)}
          tabIndex={0}
          onMouseDown={() => {
            activeDragHandleRef.current = 'left';
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              updateLayoutAndPersist({
                ...layoutPrefs,
                sourceWidthPercent: layoutPrefs.sourceWidthPercent - 2,
              });
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              updateLayoutAndPersist({
                ...layoutPrefs,
                sourceWidthPercent: layoutPrefs.sourceWidthPercent + 2,
              });
            }
          }}
          className="hidden lg:flex w-1.5 bg-[var(--pg-bg-workspace)] hover:bg-[var(--pg-accent)] focus:bg-[var(--pg-accent)] cursor-col-resize items-center justify-center transition-colors shrink-0"
        />

        {/* ===================================================================
            PANEL B: PRIORITIZED FINDINGS & FILTER BAR
            =================================================================== */}
        <section
          aria-label="Prioritized Review Findings"
          style={{ width: `${layoutPrefs.findingsWidthPercent}%` }}
          className={`max-lg:!w-full flex-1 lg:flex-none flex flex-col min-h-0 min-w-0 border-r border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] ${
            mobilePane === 'findings' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Filter & Search Toolbar */}
          <div className="p-3 bg-[var(--pg-bg-surface)] border-b border-[var(--pg-border-default)] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-[var(--pg-text-primary)]">
                <Filter className="w-3.5 h-3.5 text-[var(--pg-text-muted)]" />
                <span className="tabular-nums">
                  FINDINGS ({filteredFindings.length} / {verifiedFindings.length})
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

            {/* 6 Dedicated Filter Selectors (Severity, Category, Status, Engine Source, File, Confidence) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs font-mono">
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
                aria-label="Filter by Analysis Engine Source"
                value={sourceFilter}
                onChange={(e) =>
                  setSourceFilter(e.target.value as AnalysisSourceType | 'all')
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">Engine: All</option>
                <option value="corroborated">Corroborated (Static+AI)</option>
                <option value="static-pattern">Static Analyzer Only</option>
                <option value="ai-gemini">AI Semantic Only</option>
              </select>

              <select
                aria-label="Filter by Source File"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">File: All ({review.files.length})</option>
                {review.files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.filename.split('/').pop() || f.filename}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by Confidence Level"
                value={confidenceFilter}
                onChange={(e) =>
                  setConfidenceFilter(
                    e.target.value as 'high' | 'medium' | 'low' | 'all'
                  )
                }
                className="px-2 py-1 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="all">Confidence: All</option>
                <option value="high">Conf: High</option>
                <option value="medium">Conf: Medium</option>
                <option value="low">Conf: Low</option>
              </select>
            </div>
          </div>

          {/* Findings List Surface */}
          <div className="flex-1 overflow-y-auto divide-y divide-[var(--pg-border-default)]">
            {verifiedFindings.length === 0 ? (
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
                  This review contains {verifiedFindings.length} total finding(s), but none match
                  the active filter criteria.
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
                const resolvedFile = resolveTargetSourceFile(
                  review.files,
                  finding.location.fileId,
                  finding.location.filename
                );
                const shortFile =
                  (resolvedFile?.filename || finding.location.filename).split('/').pop() ||
                  finding.location.filename;
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
                        title={
                          finding.location.isValidLocation
                            ? `${finding.location.filename}:L${finding.location.startLine}–L${finding.location.endLine}`
                            : finding.location.validationNote || 'Location Quarantined'
                        }
                      >
                        {finding.location.isValidLocation && resolvedFile ? (
                          <>
                            <span className="text-[var(--pg-success)] mr-1" aria-hidden="true">
                              ✓
                            </span>
                            {shortFile}:L{finding.location.startLine}
                            {finding.location.endLine !== finding.location.startLine
                              ? `–${finding.location.endLine}`
                              : ''}
                          </>
                        ) : (
                          <span className="text-[var(--pg-warning)]">
                            △ {shortFile} · Quarantined (
                            {finding.location.locationReason || 'invalid'})
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

        {/* RESIZE HANDLE 2: Between Panel B (Findings) and Panel C (Evidence) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize findings panel and evidence details panel"
          aria-valuemin={20}
          aria-valuemax={53}
          aria-valuenow={Math.round(layoutPrefs.findingsWidthPercent)}
          tabIndex={0}
          onMouseDown={() => {
            activeDragHandleRef.current = 'right';
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              updateLayoutAndPersist({
                ...layoutPrefs,
                findingsWidthPercent: layoutPrefs.findingsWidthPercent - 2,
              });
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              updateLayoutAndPersist({
                ...layoutPrefs,
                findingsWidthPercent: layoutPrefs.findingsWidthPercent + 2,
              });
            }
          }}
          className="hidden lg:flex w-1.5 bg-[var(--pg-bg-workspace)] hover:bg-[var(--pg-accent)] focus:bg-[var(--pg-accent)] cursor-col-resize items-center justify-center transition-colors shrink-0"
        />

        {/* ===================================================================
            PANEL C: EVIDENCE, REMEDIATION & TRIAGE ACTIONS
            =================================================================== */}
        <section
          aria-label="Finding Evidence and Remediation Details"
          style={{ width: `${evidenceWidthPercent}%` }}
          className={`max-lg:!w-full flex-1 lg:flex-none flex flex-col min-h-0 min-w-0 bg-[var(--pg-bg-surface)] overflow-y-auto ${
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

                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[var(--pg-text-secondary)] tabular-nums pt-0.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>Category: {selectedFinding.category}</span>
                      {selectedFinding.staticCorroboration?.ruleId && (
                        <span>Rule: {selectedFinding.staticCorroboration.ruleId}</span>
                      )}
                    </div>

                    {selectedFinding.location.isValidLocation && selectedFindingTargetFile ? (
                      <button
                        type="button"
                        onClick={() => handleNavigateToFindingSource(selectedFinding)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-accent-text)] hover:border-[var(--pg-border-strong)] cursor-pointer"
                      >
                        <CornerDownRight className="w-3 h-3" />
                        <span>
                          {selectedFindingTargetFile.filename}:L
                          {selectedFinding.location.startLine}
                          {selectedFinding.location.endLine !== selectedFinding.location.startLine
                            ? `–L${selectedFinding.location.endLine}`
                            : ''}
                        </span>
                      </button>
                    ) : (
                      <span className="text-[var(--pg-warning)]">
                        {selectedFinding.location.filename} · Location Quarantined (
                        {selectedFinding.location.locationReason || 'unverified'})
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
                    {selectedFinding.location.isValidLocation ? (
                      <span className="text-[var(--pg-success)] tabular-nums">
                        ✓ Verified L{selectedFinding.location.startLine}–L
                        {selectedFinding.location.endLine}
                      </span>
                    ) : (
                      <span className="text-[var(--pg-warning)] uppercase">
                        △ Quarantined ({selectedFinding.location.locationReason || 'unverified'})
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
                    <div className="p-2.5 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] font-mono text-[11px] text-[var(--pg-warning)] space-y-1">
                      <div>
                        {selectedFinding.location.validationNote ||
                          `Location Quarantined: The model reported line numbers outside the verified bounds of ${selectedFinding.location.filename}. PatchGuard never fabricates or clamps unverified code snippets.`}
                      </div>
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
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[var(--pg-warning)]">
                        [UNVERIFIED SUGGESTED FIX]
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyRemediationOnly(selectedFinding)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
                      >
                        {copiedRemediationId === selectedFinding.id ? (
                          <>
                            <Check className="w-2.5 h-2.5 text-[var(--pg-success)]" />
                            <span className="text-[var(--pg-success)]">Copied Fix</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-2.5 h-2.5" />
                            <span>Copy Remediation</span>
                          </>
                        )}
                      </button>
                    </div>
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
                <div>Total Findings: {verifiedFindings.length}</div>
                <div>Model & Engine Stack: {review.modelUsed}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
