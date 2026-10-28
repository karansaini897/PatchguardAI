import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ReviewFinding, SourceFileRecord } from '../types/patchguard';
import { compareSeverity } from '../lib/staticAnalyzer';
import { SEVERITY_META, SeverityLabel } from './SeverityIndicator';
import { Check, Copy, CornerDownRight, WrapText } from 'lucide-react';

interface SourceViewerProps {
  file: SourceFileRecord;
  findingsForFile: ReviewFinding[];
  selectedFinding: ReviewFinding | null;
  onSelectFinding: (finding: ReviewFinding) => void;
}

/**
 * Deterministic lightweight token highlighter for TypeScript, JavaScript, Python, Java, and SQL.
 * Preserves exact character positions and whitespace without external dependencies.
 */
function renderHighlightedLine(lineText: string): React.ReactNode {
  const trimmed = lineText.trimStart();
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  ) {
    return <span className="text-[var(--pg-text-muted)] italic">{lineText}</span>;
  }

  const tokenRegex =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:import|from|export|async|await|function|const|let|var|return|if|else|for|while|try|catch|finally|throw|new|class|interface|type|public|private|protected|static|final|def|None|True|False|true|false|null|undefined|SELECT|FROM|WHERE|AND|OR|INSERT|INTO|VALUES|UPDATE|SET|DELETE|ORDER|BY|LIMIT|JOIN|LEFT|INNER|ON|GROUP|HAVING)\b|\b(?:Promise|Error|Record|Map|Set|Array|String|Number|Boolean|Object|Response|Request|ResultSet|PreparedStatement|Connection)\b|\b\d+(?:\.\d+)?\b)/g;

  const parts = lineText.split(tokenRegex);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'")) ||
      (part.startsWith('`') && part.endsWith('`'))
    ) {
      return (
        <span key={idx} className="text-[var(--pg-accent-text)]">
          {part}
        </span>
      );
    }
    if (
      /^(import|from|export|async|await|function|const|let|var|return|if|else|for|while|try|catch|finally|throw|new|class|interface|type|public|private|protected|static|final|def|SELECT|FROM|WHERE|AND|OR|INSERT|INTO|VALUES|UPDATE|SET|DELETE|ORDER|BY|LIMIT|JOIN|LEFT|INNER|ON|GROUP|HAVING)$/.test(
        part
      )
    ) {
      return (
        <span key={idx} className="text-[var(--pg-info)] font-medium">
          {part}
        </span>
      );
    }
    if (
      /^(Promise|Error|Record|Map|Set|Array|String|Number|Boolean|Object|Response|Request|ResultSet|PreparedStatement|Connection)$/.test(
        part
      )
    ) {
      return (
        <span key={idx} className="text-[var(--pg-warning)]">
          {part}
        </span>
      );
    }
    if (/^(None|True|False|true|false|null|undefined|\d+(?:\.\d+)?)$/.test(part)) {
      return (
        <span key={idx} className="text-[var(--pg-danger)]">
          {part}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const SourceViewer: React.FC<SourceViewerProps> = ({
  file,
  findingsForFile,
  selectedFinding,
  onSelectFinding,
}) => {
  const lineRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const [copiedSource, setCopiedSource] = useState<boolean>(false);

  const lines = useMemo(() => file.content.split(/\r?\n/), [file.content]);

  // Only map findings with verified source line numbers inside this exact file
  const validFindings = useMemo(
    () =>
      findingsForFile.filter(
        (f) =>
          f.location.isValidLocation &&
          f.location.startLine >= 1 &&
          f.location.endLine <= lines.length &&
          f.location.startLine <= f.location.endLine
      ),
    [findingsForFile, lines.length]
  );

  // Map each 1-indexed line number to all valid findings that cover that line
  const findingsByLine = useMemo(() => {
    const map = new Map<number, ReviewFinding[]>();
    for (const f of validFindings) {
      for (let ln = f.location.startLine; ln <= f.location.endLine; ln++) {
        const existing = map.get(ln) || [];
        existing.push(f);
        existing.sort((a, b) => compareSeverity(a.severity, b.severity));
        map.set(ln, existing);
      }
    }
    return map;
  }, [validFindings]);

  const isSelectedFindingInThisFile = Boolean(
    selectedFinding &&
      selectedFinding.location.fileId === file.id &&
      selectedFinding.location.isValidLocation &&
      selectedFinding.location.startLine >= 1 &&
      selectedFinding.location.endLine <= lines.length
  );

  const scrollToActiveFinding = () => {
    if (!isSelectedFindingInThisFile || !selectedFinding) return;
    const targetRow = lineRefs.current[selectedFinding.location.startLine];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // Scroll selected finding into view when selection changes
  useEffect(() => {
    scrollToActiveFinding();
  }, [selectedFinding, file.id, lines.length]);

  const handleCopyFileSource = () => {
    navigator.clipboard?.writeText(file.content).catch(() => {});
    setCopiedSource(true);
    setTimeout(() => setCopiedSource(false), 1800);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--pg-bg-code)] text-[var(--pg-text-primary)] select-text">
      {/* File Metadata & Source Toolbar */}
      <div className="px-3 py-2 bg-[var(--pg-bg-surface)] border-b border-[var(--pg-border-default)] flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[var(--pg-text-primary)] font-semibold truncate"
            title={file.filename}
          >
            {file.filename}
          </span>
          <span className="text-[var(--pg-text-muted)] shrink-0">
            ({file.language.toUpperCase()} · {lines.length} lines)
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-[var(--pg-text-secondary)]">
            {validFindings.length} verified finding{validFindings.length === 1 ? '' : 's'}
          </span>

          {isSelectedFindingInThisFile && selectedFinding && (
            <button
              type="button"
              onClick={scrollToActiveFinding}
              title={`Scroll to selected finding at L${selectedFinding.location.startLine}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[var(--pg-border-strong)] bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] hover:bg-[var(--pg-bg-interactive)] cursor-pointer tabular-nums"
            >
              <CornerDownRight className="w-3 h-3" />
              <span>
                L{selectedFinding.location.startLine}
                {selectedFinding.location.endLine !== selectedFinding.location.startLine
                  ? `–${selectedFinding.location.endLine}`
                  : ''}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setWrapLines((prev) => !prev)}
            aria-pressed={wrapLines}
            title="Toggle line wrapping in source viewer"
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border transition-colors cursor-pointer ${
              wrapLines
                ? 'border-[var(--pg-border-strong)] bg-[var(--pg-bg-elevated)] text-[var(--pg-text-primary)]'
                : 'border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)]'
            }`}
          >
            <WrapText className="w-3 h-3" />
            <span>{wrapLines ? 'Wrap: On' : 'Wrap: Off'}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyFileSource}
            title="Copy full source file to clipboard"
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] cursor-pointer"
          >
            {copiedSource ? (
              <>
                <Check className="w-3 h-3 text-[var(--pg-success)]" />
                <span className="text-[var(--pg-success)]">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy File</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Scrollable Code Surface */}
      <div className="flex-1 overflow-auto font-mono text-[12.5px] leading-[1.65]">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((lineText: string, index: number) => {
              const lineNumber = index + 1;
              const attachedFindings = findingsByLine.get(lineNumber) || [];
              const primaryFinding = attachedFindings[0] || null;

              const isSelectedRange = Boolean(
                isSelectedFindingInThisFile &&
                  selectedFinding &&
                  lineNumber >= selectedFinding.location.startLine &&
                  lineNumber <= selectedFinding.location.endLine
              );

              const isSelectedStartLine = Boolean(
                isSelectedRange &&
                  selectedFinding &&
                  lineNumber === selectedFinding.location.startLine
              );

              // Distinguish selected finding range vs other finding lines vs normal lines
              let rowBgClass = 'hover:bg-[var(--pg-bg-interactive)]';
              if (isSelectedRange) {
                rowBgClass = 'bg-[var(--pg-bg-code-defect)]';
              } else if (primaryFinding) {
                rowBgClass = 'bg-[var(--pg-bg-code-active)] hover:bg-[var(--pg-bg-interactive)]';
              }

              const primaryMeta = primaryFinding
                ? SEVERITY_META[primaryFinding.severity] || SEVERITY_META.medium
                : null;

              return (
                <React.Fragment key={lineNumber}>
                  <tr
                    ref={(el) => {
                      lineRefs.current[lineNumber] = el;
                    }}
                    onClick={() => {
                      if (primaryFinding) {
                        onSelectFinding(primaryFinding);
                      }
                    }}
                    className={`${rowBgClass} transition-colors ${
                      primaryFinding ? 'cursor-pointer' : ''
                    }`}
                  >
                    {/* Gutter: Active Marker + Severity Glyph + Tabular Line Number */}
                    <td
                      className={`w-24 px-2 py-0.5 select-none border-r text-right align-top tabular-nums shrink-0 ${
                        isSelectedRange
                          ? 'bg-[var(--pg-bg-elevated)] border-[var(--pg-border-strong)] text-[var(--pg-accent-text)] font-semibold'
                          : primaryFinding
                          ? 'bg-[var(--pg-bg-code-gutter)] border-[var(--pg-border-default)] text-[var(--pg-text-primary)]'
                          : 'bg-[var(--pg-bg-code-gutter)] border-[var(--pg-border-subtle)] text-[var(--pg-text-muted)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        {primaryFinding && primaryMeta ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectFinding(primaryFinding);
                            }}
                            title={`${primaryMeta.label.toUpperCase()}: ${primaryFinding.title}${
                              attachedFindings.length > 1
                                ? ` (+${attachedFindings.length - 1} more on L${lineNumber})`
                                : ''
                            }`}
                            aria-label={`Inspect ${primaryFinding.severity} finding on line ${lineNumber}: ${primaryFinding.title}`}
                            className={`inline-flex items-center gap-0.5 text-[11px] font-bold hover:opacity-80 focus:outline-none cursor-pointer ${primaryMeta.colorClass}`}
                          >
                            <span>{isSelectedRange ? '▶' : primaryMeta.glyph}</span>
                            {attachedFindings.length > 1 && (
                              <span className="text-[9px] text-[var(--pg-text-secondary)]">
                                +{attachedFindings.length - 1}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="w-3 inline-block" aria-hidden="true">
                            {isSelectedRange ? '▶' : ''}
                          </span>
                        )}
                        <span>{lineNumber}</span>
                      </div>
                    </td>

                    {/* Verbatim Code Line */}
                    <td
                      className={`px-4 py-0.5 font-mono text-[var(--pg-text-primary)] ${
                        wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                      }`}
                    >
                      {lineText.length > 0 ? renderHighlightedLine(lineText) : ' '}
                    </td>
                  </tr>

                  {/* Inline Finding Callout Banner directly below the start line of the selected finding */}
                  {isSelectedStartLine && selectedFinding && (
                    <tr className="bg-[var(--pg-bg-elevated)] border-y border-[var(--pg-border-strong)]">
                      <td className="px-2 py-1.5 text-right font-mono text-[10px] text-[var(--pg-accent-text)] bg-[var(--pg-bg-code-gutter)] border-r border-[var(--pg-border-strong)] align-top uppercase">
                        ACTIVE
                      </td>
                      <td className="px-4 py-2 font-sans text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <SeverityLabel severity={selectedFinding.severity} compact />
                            <span className="font-semibold text-[var(--pg-text-primary)]">
                              {selectedFinding.title}
                            </span>
                            {selectedFinding.staticCorroboration?.ruleId && (
                              <span className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
                                [{selectedFinding.staticCorroboration.ruleId}]
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[11px] text-[var(--pg-text-secondary)] tabular-nums">
                            Verified L{selectedFinding.location.startLine}
                            {selectedFinding.location.endLine !== selectedFinding.location.startLine
                              ? `–L${selectedFinding.location.endLine}`
                              : ''}{' '}
                            · {selectedFinding.confidence.toUpperCase()} CONFIDENCE
                          </span>
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
    </div>
  );
};
