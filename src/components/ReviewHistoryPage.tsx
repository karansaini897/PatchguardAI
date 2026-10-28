import React, { useMemo, useState } from 'react';
import {
  ReviewExecutionStatus,
  ReviewRecord,
  SeverityLevel,
  SupportedLanguage,
} from '../types/patchguard';
import { computeSeverityDistribution } from '../lib/evaluationMath';
import { compareSeverity } from '../lib/staticAnalyzer';
import { ReviewStatusLabel, SeverityLabel } from './SeverityIndicator';
import {
  ArrowUpDown,
  Database,
  ExternalLink,
  Search,
  Trash2,
} from 'lucide-react';

interface ReviewHistoryPageProps {
  reviews: ReviewRecord[];
  isLocalStorageAvailable: boolean;
  onOpenReview: (review: ReviewRecord) => void;
  onDeleteReview: (reviewId: string) => void;
  onStartNewReview: () => void;
}

type SortField = 'createdAt' | 'findingsCount' | 'durationMs' | 'highestSeverity';

export const ReviewHistoryPage: React.FC<ReviewHistoryPageProps> = ({
  reviews,
  isLocalStorageAvailable,
  onOpenReview,
  onDeleteReview,
  onStartNewReview,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<ReviewExecutionStatus | 'all'>('all');
  const [languageFilter, setLanguageFilter] = useState<SupportedLanguage | 'all'>('all');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [inspectedRecordId, setInspectedRecordId] = useState<string | null>(null);

  const pageSize = 10;

  const filteredAndSorted = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = reviews.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (
        languageFilter !== 'all' &&
        !r.files.some((f) => f.language === languageFilter)
      ) {
        return false;
      }
      if (q) {
        const hay = `${r.id} ${r.title} ${r.requestId} ${r.files
          .map((f) => f.filename)
          .join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'createdAt') {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (sortField === 'findingsCount') {
        cmp = a.findings.length - b.findings.length;
      } else if (sortField === 'durationMs') {
        cmp = a.durationMs - b.durationMs;
      } else if (sortField === 'highestSeverity') {
        const distA = computeSeverityDistribution(a.findings);
        const distB = computeSeverityDistribution(b.findings);
        const rank = (s: SeverityLevel | 'none') =>
          s === 'none' ? 99 : compareSeverity(s, 'critical');
        cmp = rank(distB.highestSeverity) - rank(distA.highestSeverity);
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [reviews, searchQuery, statusFilter, languageFilter, sortField, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginated = filteredAndSorted.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  return (
    <div className="max-w-[1360px] mx-auto px-6 py-6 space-y-6">
      {/* Header & Honest Storage Architecture Disclosure */}
      <div className="border-b border-[var(--pg-border-default)] pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            REVIEW HISTORY · TECHNICAL AUDIT LEDGER
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)] mt-1">
            Executed Code Review Records ({reviews.length})
          </h1>
        </div>

        <div className="px-3 py-2 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] flex items-center gap-2.5 text-xs font-mono text-[var(--pg-text-secondary)]">
          <Database className="w-3.5 h-3.5 text-[var(--pg-info)] shrink-0" />
          <span>
            Persistence Adapter:{' '}
            <strong className="text-[var(--pg-text-primary)]">
              {isLocalStorageAvailable
                ? 'Browser Local Storage (Single-Browser Scope — No Cross-Device Sync)'
                : 'Volatile Session Memory Fallback'}
            </strong>
          </span>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="p-3 bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-3.5 h-3.5 text-[var(--pg-text-muted)] absolute left-3 top-2.5" />
          <input
            type="search"
            aria-label="Search review records by ID, title, or filename"
            placeholder="Search by review ID, PR title, request ID, or filename..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="w-full pl-8 pr-3 py-1.5 text-xs font-mono bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <select
            aria-label="Filter by completion status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as ReviewExecutionStatus | 'all');
              setPage(1);
            }}
            className="px-2.5 py-1.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
          >
            <option value="all">Status: All</option>
            <option value="completed">Completed</option>
            <option value="completed_with_warnings">Completed with Warnings</option>
            <option value="failed">Failed</option>
          </select>

          <select
            aria-label="Filter by programming language"
            value={languageFilter}
            onChange={(e) => {
              setLanguageFilter(e.target.value as SupportedLanguage | 'all');
              setPage(1);
            }}
            className="px-2.5 py-1.5 bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
          >
            <option value="all">Language: All</option>
            <option value="typescript">TypeScript</option>
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
            <option value="sql">SQL</option>
          </select>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {confirmDeleteId && (
        <div
          role="alertdialog"
          aria-labelledby="delete-review-dialog-title"
          className="p-4 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
        >
          <div className="space-y-1">
            <div
              id="delete-review-dialog-title"
              className="font-mono font-semibold text-[var(--pg-text-primary)]"
            >
              Permanently delete review record {confirmDeleteId}?
            </div>
            <p className="text-[var(--pg-text-secondary)]">
              This removes the stored review and its finding status decisions from browser-local
              storage.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                onDeleteReview(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
              className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-danger)] text-white font-semibold cursor-pointer"
            >
              Confirm Deletion
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeleteId(null)}
              className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Records Table or Empty State */}
      {reviews.length === 0 ? (
        <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-8 space-y-3">
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            0 STORED REVIEW RECORDS
          </div>
          <h2 className="text-base font-semibold text-[var(--pg-text-primary)]">
            No review records exist in local storage yet
          </h2>
          <p className="text-xs text-[var(--pg-text-secondary)] max-w-xl leading-relaxed">
            Completed reviews and their finding triage states are automatically recorded here once
            you execute an analysis in New Review.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onStartNewReview}
              className="px-4 py-2 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] cursor-pointer"
            >
              Start First Code Review
            </button>
          </div>
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-6 text-xs space-y-2">
          <div className="font-mono font-semibold text-[var(--pg-warning)]">
            NO MATCHING REVIEW RECORDS
          </div>
          <p className="text-[var(--pg-text-secondary)]">
            None of the {reviews.length} stored review(s) match your active search or filter
            criteria.
          </p>
        </div>
      ) : (
        <div className="border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] font-mono text-[11px] text-[var(--pg-text-secondary)]">
                <th className="py-2.5 px-3">REVIEW ID</th>
                <th className="py-2.5 px-3">TITLE & SOURCE FILES</th>
                <th className="py-2.5 px-3">LANGUAGE</th>
                <th className="py-2.5 px-3">STATUS</th>
                <th className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('findingsCount')}
                    className="inline-flex items-center gap-1 hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    <span>FINDINGS</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-3">
                  <button
                    type="button"
                    onClick={() => toggleSort('highestSeverity')}
                    className="inline-flex items-center gap-1 hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    <span>HIGHEST SEVERITY</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('durationMs')}
                    className="inline-flex items-center gap-1 hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    <span>DURATION</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-3">
                  <button
                    type="button"
                    onClick={() => toggleSort('createdAt')}
                    className="inline-flex items-center gap-1 hover:text-[var(--pg-text-primary)] cursor-pointer"
                  >
                    <span>TIMESTAMP</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-3 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--pg-border-subtle)]">
              {paginated.map((rev) => {
                const dist = computeSeverityDistribution(rev.findings);
                const isInspected = inspectedRecordId === rev.id;
                const languages = Array.from(new Set(rev.files.map((f) => f.language))).join(', ');

                return (
                  <React.Fragment key={rev.id}>
                    <tr className="hover:bg-[var(--pg-bg-workspace)] transition-colors">
                      <td className="py-2.5 px-3 font-mono text-[11px] text-[var(--pg-text-secondary)] whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setInspectedRecordId(isInspected ? null : rev.id)
                          }
                          title="Click to inspect full identifiers and paths"
                          className="hover:underline text-[var(--pg-info)] cursor-pointer"
                        >
                          {rev.id}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 max-w-[320px]">
                        <div
                          className="font-semibold text-[var(--pg-text-primary)] truncate"
                          title={rev.title}
                        >
                          {rev.title}
                        </div>
                        <div
                          className="font-mono text-[11px] text-[var(--pg-text-muted)] truncate"
                          title={rev.files.map((f) => f.filename).join(', ')}
                        >
                          {rev.files.map((f) => f.filename).join(', ')}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] uppercase text-[var(--pg-text-secondary)] whitespace-nowrap">
                        {languages}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <ReviewStatusLabel status={rev.status} />
                      </td>
                      <td className="py-2.5 px-3 font-mono text-right tabular-nums text-[var(--pg-text-primary)] whitespace-nowrap">
                        {rev.findings.length}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {dist.highestSeverity === 'none' ? (
                          <span className="font-mono text-xs text-[var(--pg-text-muted)]">
                            None (0)
                          </span>
                        ) : (
                          <SeverityLabel severity={dist.highestSeverity} compact />
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-right tabular-nums text-[var(--pg-text-secondary)] whitespace-nowrap">
                        {rev.durationMs}ms
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] tabular-nums text-[var(--pg-text-muted)] whitespace-nowrap">
                        {new Date(rev.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onOpenReview(rev)}
                            className="px-2.5 py-1 font-mono text-[11px] bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] cursor-pointer"
                          >
                            Open Workspace
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete review ${rev.id}`}
                            onClick={() => setConfirmDeleteId(rev.id)}
                            className="p-1 text-[var(--pg-text-muted)] hover:text-[var(--pg-danger)] cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Accessible Expanded Row for Inspecting Full Untruncated Filenames & Identifiers */}
                    {isInspected && (
                      <tr className="bg-[var(--pg-bg-workspace)] font-mono text-[11px] text-[var(--pg-text-secondary)]">
                        <td colSpan={9} className="p-3 space-y-1">
                          <div>Full Review ID: {rev.id} · Request ID: {rev.requestId}</div>
                          <div>Model & Static Stack: {rev.modelUsed}</div>
                          <div>
                            Full File Paths:{' '}
                            {rev.files.map((f) => `${f.filename} (${f.lineCount}L)`).join(' | ')}
                          </div>
                          <div>Objective: {rev.objective}</div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="px-4 py-2.5 border-t border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between text-xs font-mono">
              <span className="text-[var(--pg-text-muted)] tabular-nums">
                Page {currentPage} of {totalPages} ({filteredAndSorted.length} record(s))
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 border border-[var(--pg-border-default)] disabled:opacity-40 cursor-pointer"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-2.5 py-1 border border-[var(--pg-border-default)] disabled:opacity-40 cursor-pointer"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
