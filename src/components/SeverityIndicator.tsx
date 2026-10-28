import React from 'react';
import {
  AnalysisSourceType,
  FindingStatus,
  ReviewExecutionStatus,
  SeverityLevel,
} from '../types/patchguard';

export const SEVERITY_META: Record<
  SeverityLevel,
  {
    label: string;
    shortLabel: string;
    glyph: string;
    colorClass: string;
    bgSubtleClass: string;
    barColor: string;
  }
> = {
  critical: {
    label: 'Critical',
    shortLabel: 'CRIT',
    glyph: '◆',
    colorClass: 'text-[var(--pg-critical)]',
    bgSubtleClass: 'bg-[var(--pg-critical-subtle)]',
    barColor: 'var(--pg-critical)',
  },
  high: {
    label: 'High',
    shortLabel: 'HIGH',
    glyph: '▲',
    colorClass: 'text-[var(--pg-danger)]',
    bgSubtleClass: 'bg-[var(--pg-danger-subtle)]',
    barColor: 'var(--pg-danger)',
  },
  medium: {
    label: 'Medium',
    shortLabel: 'MED',
    glyph: '●',
    colorClass: 'text-[var(--pg-warning)]',
    bgSubtleClass: 'bg-[var(--pg-warning-subtle)]',
    barColor: 'var(--pg-warning)',
  },
  low: {
    label: 'Low',
    shortLabel: 'LOW',
    glyph: '▪',
    colorClass: 'text-[var(--pg-info)]',
    bgSubtleClass: 'bg-[var(--pg-info-subtle)]',
    barColor: 'var(--pg-info)',
  },
  info: {
    label: 'Info',
    shortLabel: 'INFO',
    glyph: '○',
    colorClass: 'text-[var(--pg-text-secondary)]',
    bgSubtleClass: 'bg-[var(--pg-bg-interactive)]',
    barColor: 'var(--pg-text-muted)',
  },
};

export const SeverityLabel: React.FC<{
  severity: SeverityLevel;
  compact?: boolean;
}> = ({ severity, compact = false }) => {
  const meta = SEVERITY_META[severity] || SEVERITY_META.medium;
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-xs font-semibold tracking-tight whitespace-nowrap shrink-0 ${meta.colorClass}`}
      title={`Severity: ${meta.label}`}
    >
      <span aria-hidden="true" className="text-[11px] leading-none">
        {meta.glyph}
      </span>
      <span>{compact ? meta.shortLabel : meta.label.toUpperCase()}</span>
    </span>
  );
};

export const FindingStatusLabel: React.FC<{
  status: FindingStatus;
  compact?: boolean;
}> = ({ status, compact = false }) => {
  const map: Record<
    FindingStatus,
    { text: string; shortText: string; symbol: string; cls: string }
  > = {
    unreviewed: {
      text: 'Unreviewed',
      shortText: 'Unreviewed',
      symbol: '○',
      cls: 'text-[var(--pg-warning)]',
    },
    reviewed: {
      text: 'Reviewed',
      shortText: 'Reviewed',
      symbol: '✓',
      cls: 'text-[var(--pg-success)]',
    },
    dismissed: {
      text: 'Dismissed (Not Proven Safe)',
      shortText: 'Dismissed',
      symbol: '×',
      cls: 'text-[var(--pg-text-muted)]',
    },
    reopened: {
      text: 'Reopened',
      shortText: 'Reopened',
      symbol: '↺',
      cls: 'text-[var(--pg-accent-text)]',
    },
  };
  const item = map[status];
  return (
    <span
      title={`Review status: ${item.text}`}
      className={`inline-flex items-center gap-1 font-mono text-[11px] whitespace-nowrap shrink-0 ${item.cls}`}
    >
      <span aria-hidden="true">{item.symbol}</span>
      <span>{compact ? item.shortText : item.text}</span>
    </span>
  );
};

export const AnalysisSourceLabel: React.FC<{ source: AnalysisSourceType }> = ({ source }) => {
  if (source === 'corroborated') {
    return (
      <span className="font-mono text-xs text-[var(--pg-success)] whitespace-nowrap shrink-0">
        Corroborated (Static + AI)
      </span>
    );
  }
  if (source === 'static-pattern') {
    return (
      <span className="font-mono text-xs text-[var(--pg-info)] whitespace-nowrap shrink-0">
        Static Analyzer (Deterministic)
      </span>
    );
  }
  return (
    <span className="font-mono text-xs text-[var(--pg-text-secondary)] whitespace-nowrap shrink-0">
      AI Reasoning (Unverified Claim)
    </span>
  );
};

export const ReviewStatusLabel: React.FC<{ status: ReviewExecutionStatus }> = ({ status }) => {
  const config: Record<
    ReviewExecutionStatus,
    { label: string; symbol: string; color: string }
  > = {
    completed: {
      label: 'Completed (AI Assisted)',
      symbol: '✓',
      color: 'text-[var(--pg-success)]',
    },
    completed_static_only: {
      label: 'Completed (Static Only)',
      symbol: '✓',
      color: 'text-[var(--pg-info)]',
    },
    completed_with_warnings: {
      label: 'Partially Completed (Warnings)',
      symbol: '△',
      color: 'text-[var(--pg-warning)]',
    },
    failed: {
      label: 'Failed',
      symbol: '✕',
      color: 'text-[var(--pg-danger)]',
    },
    cancelled: {
      label: 'Cancelled',
      symbol: '⊘',
      color: 'text-[var(--pg-text-muted)]',
    },
    in_progress: {
      label: 'In Progress',
      symbol: '⋯',
      color: 'text-[var(--pg-accent-text)]',
    },
    processing: {
      label: 'Processing',
      symbol: '⋯',
      color: 'text-[var(--pg-accent-text)]',
    },
    queued: {
      label: 'Queued',
      symbol: '◦',
      color: 'text-[var(--pg-text-secondary)]',
    },
  };
  const c = config[status] || config.completed;
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-xs font-medium whitespace-nowrap shrink-0 ${c.color}`}>
      <span aria-hidden="true">{c.symbol}</span>
      <span>{c.label}</span>
    </span>
  );
};
