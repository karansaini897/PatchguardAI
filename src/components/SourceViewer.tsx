import React, { useEffect, useMemo, useRef } from 'react';
import {
  ReviewFinding,
  SeverityLevel,
  SourceFileRecord,
} from '../types/patchguard';
import { compareSeverity } from '../lib/staticAnalyzer';
import { SEVERITY_META, SeverityLabel } from './SeverityIndicator';
import { AlertTriangle, FileCode, CheckCircle2 } from 'lucide-react';

interface SourceViewerProps {
  files: SourceFileRecord[];
  activeFileId: string;
  onSelectFile: (fileId: string) => void;
  findings: ReviewFinding[];
  selectedFinding: ReviewFinding | null;
  onSelectFinding: (finding: ReviewFinding) => void;
}

/**
 * Lightweight, deterministic syntax highlighter for TypeScript, JS, Python, Java, and SQL.
 * Avoids heavy external DOM mutation libraries and guarantees fast rendering even on large files.
 */
function renderHighlightedLine(line: string): React.ReactNode {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
    return <span className="text-[var(--pg-text-muted)] italic">{line}</span>;
  }

  // Split by strings, template literals, SQL/code keywords, and numbers
  const tokenRegex =
    /(`[^`]*`|'[^']*'|"[^"]*"|\b(?:export|async|function|const|let|var|if|else|for|while|return|try|catch|throw|new|import|from|interface|type|class|public|private|final|void|int|def|pass|except|SELECT|FROM|WHERE|AND|OR|UPDATE|SET|DELETE|INSERT|INTO|VALUES|LIMIT|RETURNING|NOW|await|true|false|null|undefined)\b|\b\d+\b)/g;

  const parts = line.split(tokenRegex);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (
      (part.startsWith("'") && part.endsWith("'")) ||
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith('`') && part.endsWith('`'))
    ) {
      return (
        <span key={idx} className="text-[var(--pg-warning)]">
          {part}
        </span>
      );
    }
    if (/^\d+$/.test(part)) {
      return (
        <span key={idx} className="text-[var(--pg-accent-text)]">
          {part}
        </span>
      );
    }
    if (
      /^(SELECT|FROM|WHERE|AND|OR|UPDATE|SET|DELETE|INSERT|INTO|VALUES|LIMIT|RETURNING|NOW)$/.test(
        part
      )
    ) {
      return (
        <span key={idx} className="text-[var(--pg-info)] font-semibold">
          {part}
        </span>
      );
    }
    if (
      /^(export|async|function|const|let|var|if|else|for|while|return|try|catch|throw|new|import|from|interface|type|class|public|private|final|void|int|def|pass|except|await|true|false|null|undefined)$/.test(
        part
      )
    ) {
      return (
        <span key={idx} className="text-[var(--pg-info)]">
          {part}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const SourceViewer: React.FC<SourceViewerProps> = ({
  files,
  activeFileId,
  onSelectFile,
  findings,
  selectedFinding,
  onSelectFinding,
}) => {
  const activeFile = useMemo(
    () => files.find((f) => f.id === activeFileId) || files[0],
    [files, activeFileId]
  );

  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Map valid findings per line for the active file
  const lineFindingsMap = useMemo(() => {
    const map = new Map<number, ReviewFinding[]>();
    if (!activeFile) return map;

    for (const f of findings) {
      if (f.location.filename !== activeFile.filename) continue;
      if (!f.location.isValidLocation) continue;
      const lineNum = f.location.startLine;
      const list = map.get(lineNum) || [];
      list.push(f);
      map.set(lineNum, list);
    }
    return map;
  }, [findings, activeFile]);

  // Invalid-location findings targeting this file
  const invalidFindingsForFile = useMemo(() => {
    if (!activeFile) return [];
    return findings.filter(
      (f) => f.location.filename === activeFile.filename && !f.location.isValidLocation
    );
  }, [findings, activeFile]);

  // Scroll to active finding line inside the code container without scrolling the window header
  useEffect(() => {
    if (
      selectedFinding &&
      activeFile &&
      selectedFinding.location.filename === activeFile.filename &&
      selectedFinding.location.isValidLocation &&
      viewportRef.current
    ) {
      const targetEl = lineRefs.current[selectedFinding.location.startLine];
      const container = viewportRef.current;
      if (targetEl) {
        const targetTop = targetEl.offsetTop - container.offsetTop;
        const desiredScroll = Math.max(0, targetTop - container.clientHeight / 3);
        container.scrollTo({ top: desiredScroll, behavior: 'smooth' });
      }
    }
  }, [selectedFinding, activeFile]);

  if (!activeFile) {
    return (
      <div className="p-6 text-sm text-[var(--pg-text-muted)]">
        No source file loaded in this workspace.
      </div>
    );
  }

  const lines = useMemo(() => activeFile.content.split(/\r?\n/), [activeFile.content]);

  return (
    <div className="flex flex-col h-full bg-[var(--pg-bg-code)] border-r border-[var(--pg-border-default)] select-text">
      {/* Region Header & File Switcher */}
      <div className="border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] px-3 py-2">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="font-mono text-[11px] font-semibold tracking-wider text-[var(--pg-text-secondary)]">
            A · SOURCE & CHANGE CONTEXT
          </span>
          <span className="font-mono text-[11px] text-[var(--pg-text-muted)] tabular-nums">
            {activeFile.language.toUpperCase()} · {lines.length} lines · {activeFile.changeStatus}
          </span>
        </div>

        {/* Multi-file or single-file source navigation tabs */}
        <div
          className="flex items-center gap-1 overflow-x-auto py-0.5"
          role="tablist"
          aria-label="Reviewed source files"
        >
          {files.map((file) => {
            const fileFindings = findings.filter((f) => f.location.filename === file.filename);
            const unreviewedCount = fileFindings.filter((f) => f.status === 'unreviewed').length;
            const isSelected = file.id === activeFile.id;

            return (
              <button
                key={file.id}
                role="tab"
                aria-selected={isSelected}
                onClick={() => onSelectFile(file.id)}
                className={`group flex items-center gap-2 px-2.5 py-1.5 text-xs font-mono transition-colors border whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--pg-accent)] ${
                  isSelected
                    ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] border-[var(--pg-border-strong)]'
                    : 'bg-transparent text-[var(--pg-text-secondary)] border-transparent hover:bg-[var(--pg-bg-interactive)] hover:text-[var(--pg-text-primary)]'
                }`}
              >
                <FileCode className="w-3.5 h-3.5 text-[var(--pg-info)] shrink-0" />
                <span className="truncate max-w-[210px]" title={file.filename}>
                  {file.filename}
                </span>
                <span className="text-[11px] text-[var(--pg-text-muted)] tabular-nums">
                  · {fileFindings.length}
                </span>
                {fileFindings.length > 0 && unreviewedCount === 0 && (
                  <CheckCircle2
                    className="w-3 h-3 text-[var(--pg-success)] shrink-0"
                    aria-label="All findings reviewed"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Out-of-bounds / Invalid Location Quarantine Notice */}
      {selectedFinding &&
        selectedFinding.location.filename === activeFile.filename &&
        !selectedFinding.location.isValidLocation && (
          <div
            role="alert"
            className="px-3 py-2.5 bg-[var(--pg-warning-subtle)] border-b border-[var(--pg-border-default)] flex items-start gap-2.5 text-xs"
          >
            <AlertTriangle className="w-4 h-4 text-[var(--pg-warning)] shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold text-[var(--pg-text-primary)]">
                Source Location Unavailable (Line L{selectedFinding.location.startLine} Out of Bounds)
              </div>
              <p className="text-[var(--pg-text-secondary)] leading-relaxed">
                {selectedFinding.location.validationNote ||
                  `The selected finding references line ${selectedFinding.location.startLine}, which does not exist in ${activeFile.filename} (${lines.length} lines). Approximate highlighting is disabled.`}
              </p>
            </div>
          </div>
        )}

      {/* Code Viewport */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-auto font-mono text-[12.5px] leading-[1.65]"
        data-testid="source-code-viewer"
      >
        <div className="min-w-max py-2">
          {lines.map((lineText, idx) => {
            const lineNumber = idx + 1;
            const attachedFindings = lineFindingsMap.get(lineNumber) || [];
            const isSelectedRange =
              selectedFinding &&
              selectedFinding.location.filename === activeFile.filename &&
              selectedFinding.location.isValidLocation &&
              lineNumber >= selectedFinding.location.startLine &&
              lineNumber <= selectedFinding.location.endLine;

            // Highest severity on this line
            let topSeverity: SeverityLevel | null = null;
            for (const af of attachedFindings) {
              if (!topSeverity || compareSeverity(af.severity, topSeverity) < 0) {
                topSeverity = af.severity;
              }
            }

            const rowBg = isSelectedRange
              ? 'bg-[var(--pg-bg-code-defect)]'
              : attachedFindings.length > 0
              ? 'bg-[var(--pg-bg-code-active)]'
              : 'hover:bg-[var(--pg-bg-workspace)]';

            return (
              <div
                key={lineNumber}
                ref={(el) => {
                  lineRefs.current[lineNumber] = el;
                }}
                className={`flex items-stretch transition-colors ${rowBg}`}
              >
                {/* Gutter: Line Number + Finding Marker */}
                <div className="w-20 shrink-0 flex items-center justify-between px-2.5 bg-[var(--pg-bg-code-gutter)] border-r border-[var(--pg-border-subtle)] select-none text-[11px] text-[var(--pg-text-muted)] tabular-nums">
                  <span>{lineNumber}</span>
                  {attachedFindings.length > 0 && topSeverity && (
                    <button
                      type="button"
                      onClick={() => onSelectFinding(attachedFindings[0])}
                      aria-label={`Line ${lineNumber}: ${attachedFindings.length} finding(s), highest severity ${topSeverity}. Click to inspect: ${attachedFindings[0].title}`}
                      title={`L${lineNumber} · ${attachedFindings.length} finding(s): ${attachedFindings
                        .map((f) => f.title)
                        .join(' | ')}`}
                      className={`px-1 py-0.2 font-mono text-[10px] font-bold transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-[var(--pg-accent)] ${SEVERITY_META[topSeverity].colorClass}`}
                    >
                      {SEVERITY_META[topSeverity].glyph}
                      {attachedFindings.length > 1 ? attachedFindings.length : ''}
                    </button>
                  )}
                </div>

                {/* Source Line Content + Inline Annotation Anchor */}
                <div className="flex-1 px-4 whitespace-pre flex items-center justify-between gap-6">
                  <span className="text-[var(--pg-text-primary)]">
                    {lineText.length > 0 ? renderHighlightedLine(lineText) : ' '}
                  </span>

                  {attachedFindings.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onSelectFinding(attachedFindings[0])}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono bg-[var(--pg-bg-surface)] border border-[var(--pg-border-default)] hover:border-[var(--pg-border-strong)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--pg-accent)]"
                    >
                      <SeverityLabel severity={attachedFindings[0].severity} compact />
                      <span className="truncate max-w-[220px]">{attachedFindings[0].title}</span>
                      {attachedFindings.length > 1 && (
                        <span className="text-[var(--pg-text-muted)]">
                          (+{attachedFindings.length - 1})
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer Metadata & Quarantine Count */}
      {invalidFindingsForFile.length > 0 && (
        <div className="border-t border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-[var(--pg-warning)]">
          <span>
            {invalidFindingsForFile.length} finding(s) for {activeFile.filename} have unverified line references outside L1–L{lines.length}
          </span>
          <button
            type="button"
            onClick={() => onSelectFinding(invalidFindingsForFile[0])}
            className="underline hover:text-[var(--pg-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--pg-accent)]"
          >
            Inspect quarantined finding
          </button>
        </div>
      )}
    </div>
  );
};
