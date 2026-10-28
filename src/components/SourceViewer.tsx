import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ReviewFinding, SourceFileRecord } from '../types/patchguard';
import {
  compareSeverity,
  resolveTargetSourceFile,
  verifyFindingLocationIntegrity,
} from '../lib/staticAnalyzer';
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

  // Defensively verify every candidate finding against this exact SourceFileRecord
  const validFindings = useMemo(() => {
    const verified: ReviewFinding[] = [];
    for (const f of findingsForFile) {
      const target = resolveTargetSourceFile([file], f.location?.fileId, f.location?.filename);
      if (!target || target.id !== file.id) continue;
      const checkedLocation = verifyFindingLocationIntegrity(f, [file]);
      if (
        checkedLocation.isValidLocation &&
        checkedLocation.startLine >= 1 &&
        checkedLocation.endLine <= lines.length &&
        checkedLocation.startLine <= checkedLocation.endLine
      ) {
        verified.push({
          ...f,
          location: checkedLocation,
        });
      }
    }
    return verified;
  }, [findingsForFile, file, lines.length]);

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

  // Verify the selected finding against this exact file before highlighting or scrolling
  const verifiedSelectedLocation = useMemo(() => {
    if (!selectedFinding) return null;
    const target = resolveTargetSourceFile(
      [file],
      selectedFinding.location?.fileId,
      selectedFinding.location?.filename
    );
    if (!target || target.id !== file.id) return null;
    const loc = verifyFindingLocationIntegrity(selectedFinding, [file]);
    if (
      !loc.isValidLocation ||
      loc.startLine < 1 ||
      loc.endLine > lines.length ||
      loc.startLine > loc.endLine
    ) {
      return null;
    }
    return loc;
  }, [selectedFinding, file, lines.length]);

  const isSelectedFindingInThisFile = Boolean(verifiedSelectedLocation);

  const scrollToActiveFinding = () => {
    if (!verifiedSelectedLocation) return;
    const targetRow = lineRefs.current[verifiedSelectedLocation.startLine];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // Scroll selected finding into view when selection changes
  useEffect(() => {
    scrollToActiveFinding();
  }, [verifiedSelectedLocation?.startLine, file.id, lines.length]);

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
            ({file.language.toUpperCase()} · {file.changeStatus.toUpperCase()} · {lines.length}{' '}
            lines)
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-[var(--pg-text-secondary)]">
            {validFindings.length} verified finding{validFindings.length === 1 ? '' : 's'}
          </span>

          {verifiedSelectedLocation && (
            <button
              type="button"
              onClick={scrollToActiveFinding}
              title={`Scroll to selected finding at L${verifiedSelectedLocation.startLine}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[var(--pg-border-strong)] bg-[var(--pg-bg-elevated)] text-[var(--pg-accent-text)] hover:bg-[var(--pg-bg-interactive)] cursor-pointer tabular-nums"
            >
              <CornerDownRight className="w-3 h-3" />
              <span>
                L{verifiedSelectedLocation.startLine}
                {verifiedSelectedLocation.endLine !== verifiedSelectedLocation.startLine
                  ? `–${verifiedSelectedLocation.endLine}`
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
                  verifiedSelectedLocation &&
                  lineNumber >= verifiedSelectedLocation.startLine &&
                  lineNumber <= verifiedSelectedLocation.endLine
              );

              const isSelectedStartLine = Boolean(
                isSelectedRange &&
                  verifiedSelectedLocation &&
                  lineNumber === verifiedSelectedLocation.startLine
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
                  {isSelectedStartLine && selectedFinding && verifiedSelectedLocation && (
                    <tr className="bg-[var(--pg-bg-elevated)] border-y border-[var(--pg-border-strong)]">
                      <td className="px-2 py-1.5 text-right font-mono text-[10px] text-[var(--pg-accent-text)] bg-[var(--pg-bg-code-gutter)] border-r border-[var(--pg-border-strong)] align-top uppercase font-semibold">
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
                          <span className="font-mono text-[11px] text-[var(--pg-success)] tabular-nums">
                            ✓ Verified L{verifiedSelectedLocation.startLine}
                            {verifiedSelectedLocation.endLine !== verifiedSelectedLocation.startLine
                              ? `–L${verifiedSelectedLocation.endLine}`
                              : ''}{' '}
                            <span className="text-[var(--pg-text-secondary)]">
                              · {selectedFinding.confidence.toUpperCase()} CONFIDENCE
                            </span>
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
