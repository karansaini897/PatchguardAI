import React, { useState } from 'react';
import {
  FindingCategory,
  ReviewRecord,
  ReviewRequestPayload,
  StructuredApiError,
  SupportedLanguage,
} from '../types/patchguard';
import { CURATED_CODE_SNIPPETS, CodeExampleSnippet } from '../lib/curatedData';
import { executeCodeReview } from '../lib/apiClient';
import {
  AlertTriangle,
  Code2,
  FilePlus,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';

interface NewReviewPageProps {
  onReviewCompleted: (review: ReviewRecord) => void;
}

const ALL_FOCUS_AREAS: Array<{ id: FindingCategory; label: string; hint: string }> = [
  { id: 'security', label: 'Security & Injection', hint: 'SQLi, hardcoded secrets, IDOR auth' },
  { id: 'concurrency', label: 'Concurrency & Atomicity', hint: 'Async race conditions, lost updates' },
  { id: 'boundary', label: 'Boundary Conditions', hint: 'Off-by-one loops, index overflow' },
  { id: 'error-handling', label: 'Error Handling', hint: 'Swallowed exceptions, silent catches' },
  { id: 'performance', label: 'Performance', hint: 'Sequential N+1 queries inside loops' },
  { id: 'correctness', label: 'Logical Correctness', hint: 'Control-flow & invariant mismatches' },
  { id: 'data-integrity', label: 'Data Integrity', hint: 'Partial writes, schema assumptions' },
  { id: 'maintainability', label: 'Maintainability', hint: 'Dead branches, brittle contracts' },
];

const OBJECTIVE_PRESETS = [
  'Investigate authorization checks and tenant isolation predicates.',
  'Look for incorrect boundary conditions and off-by-one loop terminations.',
  'Examine asynchronous read-modify-write concurrency hazards.',
  'Examine error handling and identify swallowed exceptions.',
  'Identify potentially unsafe input handling and SQL string interpolation.',
  'Investigate sequential N+1 query performance bottlenecks.',
];

export const NewReviewPage: React.FC<NewReviewPageProps> = ({ onReviewCompleted }) => {
  const defaultSnippet = CURATED_CODE_SNIPPETS[0];

  const [title, setTitle] = useState<string>(defaultSnippet.title);
  const [objective, setObjective] = useState<string>(defaultSnippet.objective);
  const [focusAreas, setFocusAreas] = useState<FindingCategory[]>(defaultSnippet.focusAreas);
  const [analysisMode, setAnalysisMode] = useState<'hybrid' | 'static-only' | 'ai-only'>('hybrid');
  const [files, setFiles] = useState(defaultSnippet.files);
  const [activeFileIdx, setActiveFileIdx] = useState<number>(0);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [pendingSnippetConfirm, setPendingSnippetConfirm] = useState<CodeExampleSnippet | null>(
    null
  );

  // Submission & Error states
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<StructuredApiError | null>(null);

  const activeFile = files[activeFileIdx] || files[0];

  const toggleFocusArea = (cat: FindingCategory) => {
    setFocusAreas((prev) =>
      prev.includes(cat) ? prev.filter((item) => item !== cat) : [...prev, cat]
    );
  };

  const applySnippet = (snippet: CodeExampleSnippet) => {
    setTitle(snippet.title);
    setObjective(snippet.objective);
    setFocusAreas(snippet.focusAreas);
    setFiles(snippet.files.map((f) => ({ ...f })));
    setActiveFileIdx(0);
    setIsDirty(false);
    setPendingSnippetConfirm(null);
    setValidationError(null);
    setApiError(null);
  };

  const handleRequestLoadSnippet = (snippet: CodeExampleSnippet) => {
    if (isDirty) {
      setPendingSnippetConfirm(snippet);
    } else {
      applySnippet(snippet);
    }
  };

  const handleUpdateActiveFile = (
    patch: Partial<{
      filename: string;
      language: SupportedLanguage;
      content: string;
    }>
  ) => {
    setIsDirty(true);
    setValidationError(null);
    setFiles((prev) =>
      prev.map((file, idx) => (idx === activeFileIdx ? { ...file, ...patch } : file))
    );
  };

  const handleAddFile = () => {
    const nextIdx = files.length + 1;
    const newFile = {
      id: `file-custom-${Date.now()}`,
      filename: `src/module_${nextIdx}.ts`,
      language: 'typescript' as SupportedLanguage,
      changeStatus: 'added' as const,
      content: `export async function handler_${nextIdx}(input: string) {\n  // Enter source code to investigate\n  return input;\n}`,
    };
    setFiles((prev) => [...prev, newFile]);
    setActiveFileIdx(files.length);
    setIsDirty(true);
  };

  const handleRemoveFile = (idx: number) => {
    if (files.length <= 1) return;
    const next = files.filter((_, i) => i !== idx);
    setFiles(next);
    setActiveFileIdx(Math.max(0, idx - 1));
  };

  const handleSubmitReview = async (overrideMode?: 'hybrid' | 'static-only' | 'ai-only') => {
    if (isSubmitting) return;
    setValidationError(null);
    setApiError(null);

    // 1. Validate input
    for (const f of files) {
      if (!f.filename.trim()) {
        setValidationError('Every source file must have a non-empty filename.');
        return;
      }
      if (!f.content.trim()) {
        setValidationError(`Source file "${f.filename}" cannot be empty.`);
        return;
      }
    }

    const modeToUse = overrideMode || analysisMode;
    setIsSubmitting(true);

    const payload: ReviewRequestPayload = {
      title: title.trim() || `Review of ${files[0].filename}`,
      objective:
        objective.trim() ||
        'Investigate code changes for security, concurrency, boundary, and error-handling defects.',
      focusAreas,
      files,
      analysisMode: modeToUse,
    };

    const result = await executeCodeReview(payload);
    setIsSubmitting(false);

    if (!result.ok) {
      setApiError((result as { ok: false; error: StructuredApiError }).error);
      return;
    }

    onReviewCompleted(result.review);
  };

  const activeLines = activeFile ? activeFile.content.split(/\r?\n/) : [];

  return (
    <div className="max-w-[1360px] mx-auto px-6 py-6 space-y-6">
      {/* Header & Example Loader */}
      <div className="border-b border-[var(--pg-border-default)] pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-[var(--pg-text-muted)]">
            NEW CODE REVIEW · INVESTIGATION SUBMISSION WORKFLOW
          </div>
          <h1 className="text-xl font-semibold text-[var(--pg-text-primary)] mt-1">
            Configure Source Change & Investigation Scope
          </h1>
        </div>

        {/* Example Snippet Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-[var(--pg-text-secondary)]">
            Load Curated Example:
          </span>
          {CURATED_CODE_SNIPPETS.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              onClick={() => handleRequestLoadSnippet(snippet)}
              className="px-2.5 py-1.5 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {snippet.label.split('·')[0].trim()} · {snippet.files.length} file(s)
            </button>
          ))}
        </div>
      </div>

      {/* Overwrite Confirmation Banner (Never overwrite modified source unexpectedly) */}
      {pendingSnippetConfirm && (
        <div
          role="alertdialog"
          aria-labelledby="overwrite-confirm-title"
          className="p-4 bg-[var(--pg-warning-subtle)] border border-[var(--pg-border-default)] flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs"
        >
          <div className="space-y-1">
            <div
              id="overwrite-confirm-title"
              className="font-semibold text-[var(--pg-text-primary)]"
            >
              Replace current modified source code with "{pendingSnippetConfirm.label}"?
            </div>
            <p className="text-[var(--pg-text-secondary)]">
              You have unsaved edits in the code editor. Confirm before overwriting your input.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => applySnippet(pendingSnippetConfirm)}
              className="px-3 py-1.5 font-mono text-xs bg-[var(--pg-warning)] text-[var(--pg-text-inverse)] font-semibold cursor-pointer"
            >
              Confirm Overwrite
            </button>
            <button
              type="button"
              onClick={() => setPendingSnippetConfirm(null)}
              className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] cursor-pointer"
            >
              Keep Current Code
            </button>
          </div>
        </div>
      )}

      {/* Validation Error Banner */}
      {validationError && (
        <div
          role="alert"
          className="p-3 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] flex items-center gap-2.5 text-xs text-[var(--pg-text-primary)]"
        >
          <AlertTriangle className="w-4 h-4 text-[var(--pg-danger)] shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      {/* Structured API Failure State Banner (Preserves source and provides retry/fallback) */}
      {apiError && (
        <div
          role="alert"
          className="p-4 bg-[var(--pg-danger-subtle)] border border-[var(--pg-border-default)] space-y-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono font-semibold text-[var(--pg-danger)]">
              ANALYSIS REQUEST FAILED · {apiError.category}
            </div>
            <span className="font-mono text-[11px] text-[var(--pg-text-muted)]">
              Request ID: {apiError.requestId}
            </span>
          </div>
          <div className="text-sm font-semibold text-[var(--pg-text-primary)]">
            {apiError.message}
          </div>
          <div className="font-mono text-[11px] text-[var(--pg-text-secondary)]">
            Diagnostic detail: {apiError.technicalDetail}
          </div>
          <div className="text-[var(--pg-text-secondary)]">
            Recommended action: {apiError.remediationStep}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleSubmitReview()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] font-semibold cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry Analysis Request</span>
            </button>
            {analysisMode !== 'static-only' && (
              <button
                type="button"
                onClick={() => {
                  setAnalysisMode('static-only');
                  handleSubmitReview('static-only');
                }}
                className="px-3 py-1.5 font-mono text-xs border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] cursor-pointer"
              >
                Run Deterministic Static Analyzer Only
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Two-Column Engineering Input Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 8 Columns: Source Code Editor & File Tabs */}
        <div className="lg:col-span-8 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] flex flex-col">
          {/* File Tabs & Add File Button */}
          <div className="px-3 py-2 border-b border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between gap-2 overflow-x-auto">
            <div className="flex items-center gap-1">
              {files.map((file, idx) => (
                <div
                  key={file.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono border transition-colors ${
                    idx === activeFileIdx
                      ? 'bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] border-[var(--pg-border-strong)]'
                      : 'bg-transparent text-[var(--pg-text-secondary)] border-transparent hover:bg-[var(--pg-bg-interactive)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveFileIdx(idx)}
                    className="cursor-pointer whitespace-nowrap"
                  >
                    {file.filename || `untitled_${idx + 1}`}
                  </button>
                  {files.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(idx)}
                      aria-label={`Remove file ${file.filename}`}
                      className="text-[var(--pg-text-muted)] hover:text-[var(--pg-danger)] cursor-pointer"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={handleAddFile}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-mono border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] text-[var(--pg-text-primary)] hover:border-[var(--pg-border-strong)] shrink-0 cursor-pointer"
            >
              <FilePlus className="w-3.5 h-3.5" />
              <span>Add File</span>
            </button>
          </div>

          {/* Active File Metadata Row (Filename + Language) */}
          <div className="p-3 border-b border-[var(--pg-border-default)] grid grid-cols-1 sm:grid-cols-3 gap-3 bg-[var(--pg-bg-surface)]">
            <div className="sm:col-span-2">
              <label
                htmlFor="review-filename-input"
                className="block font-mono text-[11px] text-[var(--pg-text-secondary)] mb-1"
              >
                FILENAME / PATH
              </label>
              <input
                id="review-filename-input"
                type="text"
                value={activeFile.filename}
                onChange={(e) => handleUpdateActiveFile({ filename: e.target.value })}
                placeholder="e.g. src/ledger/payoutController.ts"
                className="w-full px-3 py-1.5 text-xs font-mono bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              />
            </div>

            <div>
              <label
                htmlFor="review-language-select"
                className="block font-mono text-[11px] text-[var(--pg-text-secondary)] mb-1"
              >
                LANGUAGE
              </label>
              <select
                id="review-language-select"
                value={activeFile.language}
                onChange={(e) =>
                  handleUpdateActiveFile({
                    language: e.target.value as SupportedLanguage,
                  })
                }
                className="w-full px-3 py-1.5 text-xs font-mono bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
              >
                <option value="typescript">TypeScript</option>
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
                <option value="java">Java</option>
                <option value="sql">SQL</option>
              </select>
            </div>
          </div>

          {/* Line-Numbered Code Input Surface */}
          <div className="relative flex bg-[var(--pg-bg-code)] min-h-[380px] max-h-[540px] overflow-auto">
            {/* Synchronized Line Numbers Gutter */}
            <div
              aria-hidden="true"
              className="w-12 py-3 px-2 bg-[var(--pg-bg-code-gutter)] border-r border-[var(--pg-border-subtle)] font-mono text-[12px] leading-[1.6] text-right text-[var(--pg-text-muted)] select-none tabular-nums shrink-0"
            >
              {activeLines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>

            <textarea
              id="source-code-textarea"
              aria-label={`Source code for ${activeFile.filename}`}
              value={activeFile.content}
              onChange={(e) => handleUpdateActiveFile({ content: e.target.value })}
              spellCheck={false}
              rows={Math.max(18, activeLines.length + 2)}
              className="flex-1 p-3 bg-transparent font-mono text-[12.5px] leading-[1.6] text-[var(--pg-text-primary)] focus:outline-none resize-y whitespace-pre overflow-x-auto"
            />
          </div>

          <div className="px-3 py-2 border-t border-[var(--pg-border-default)] bg-[var(--pg-bg-workspace)] flex items-center justify-between text-[11px] font-mono text-[var(--pg-text-muted)]">
            <span>
              Deterministic static rules available for TypeScript, JavaScript, Python, Java, and SQL
            </span>
            <span className="tabular-nums">
              {activeLines.length} lines · {activeFile.content.length} chars
            </span>
          </div>
        </div>

        {/* Right 4 Columns: Review Title, Objective, Focus Categories & Execution */}
        <div className="lg:col-span-4 border border-[var(--pg-border-default)] bg-[var(--pg-bg-surface)] p-4 space-y-5">
          <div>
            <label
              htmlFor="review-title-input"
              className="block font-mono text-[11px] text-[var(--pg-text-secondary)] mb-1"
            >
              REVIEW IDENTIFIER / PR TITLE
            </label>
            <input
              id="review-title-input"
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setIsDirty(true);
              }}
              placeholder="e.g. PR #418: Settle multi-tenant merchant payouts"
              className="w-full px-3 py-1.5 text-xs bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)]"
            />
          </div>

          {/* 7.1 Review Objectives */}
          <div className="space-y-2">
            <label
              htmlFor="review-objective-input"
              className="block font-mono text-[11px] text-[var(--pg-text-secondary)]"
            >
              REVIEW OBJECTIVE (SHAPES ANALYSIS PROMPT)
            </label>
            <textarea
              id="review-objective-input"
              rows={3}
              value={objective}
              onChange={(e) => {
                setObjective(e.target.value);
                setIsDirty(true);
              }}
              placeholder="Describe what you want investigated..."
              className="w-full p-2.5 text-xs bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)] focus:outline-none focus:border-[var(--pg-accent)] leading-relaxed"
            />
            <div className="space-y-1">
              <div className="font-mono text-[10px] text-[var(--pg-text-muted)]">
                QUICK OBJECTIVE TEMPLATES:
              </div>
              <div className="flex flex-wrap gap-1">
                {OBJECTIVE_PRESETS.map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setObjective(preset)}
                    className="px-2 py-0.5 text-[11px] bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-subtle)] text-[var(--pg-text-secondary)] hover:text-[var(--pg-text-primary)] hover:border-[var(--pg-border-default)] text-left cursor-pointer"
                  >
                    {preset.slice(0, 38)}...
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Selected Analysis Focus Categories */}
          <div className="space-y-2">
            <div className="flex items-center justify-between font-mono text-[11px] text-[var(--pg-text-secondary)]">
              <span>SELECTED ANALYSIS FOCUS ({focusAreas.length})</span>
              <button
                type="button"
                onClick={() =>
                  setFocusAreas(
                    focusAreas.length === ALL_FOCUS_AREAS.length
                      ? ['security', 'concurrency']
                      : ALL_FOCUS_AREAS.map((a) => a.id)
                  )
                }
                className="text-[var(--pg-info)] hover:underline cursor-pointer"
              >
                {focusAreas.length === ALL_FOCUS_AREAS.length ? 'Reset Focus' : 'Select All'}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              {ALL_FOCUS_AREAS.map((area) => {
                const active = focusAreas.includes(area.id);
                return (
                  <button
                    key={area.id}
                    type="button"
                    onClick={() => toggleFocusArea(area.id)}
                    aria-pressed={active}
                    className={`px-3 py-1.5 text-left border transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                      active
                        ? 'bg-[var(--pg-bg-elevated)] border-[var(--pg-border-strong)] text-[var(--pg-text-primary)]'
                        : 'bg-[var(--pg-bg-workspace)] border-[var(--pg-border-subtle)] text-[var(--pg-text-muted)] hover:text-[var(--pg-text-secondary)]'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-medium">{area.label}</div>
                      <div className="text-[11px] text-[var(--pg-text-muted)]">{area.hint}</div>
                    </div>
                    <span className="font-mono text-xs">
                      {active ? '✓ ACTIVE' : 'OFF'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Analysis Pipeline Mode */}
          <div className="space-y-1.5">
            <label
              htmlFor="analysis-pipeline-mode"
              className="block font-mono text-[11px] text-[var(--pg-text-secondary)]"
            >
              ANALYSIS PIPELINE ENGINE MODE
            </label>
            <select
              id="analysis-pipeline-mode"
              value={analysisMode}
              onChange={(e) =>
                setAnalysisMode(e.target.value as 'hybrid' | 'static-only' | 'ai-only')
              }
              className="w-full px-3 py-1.5 text-xs font-mono bg-[var(--pg-bg-workspace)] border border-[var(--pg-border-default)] text-[var(--pg-text-primary)]"
            >
              <option value="hybrid">
                Hybrid (Static Analyzer + Gemini 3.8 Flash Corroboration)
              </option>
              <option value="static-only">
                Deterministic Static Analyzer Only (pg-static-ast-1.4.2)
              </option>
              <option value="ai-only">
                Gemini 3.8 Flash Semantic Reasoning Only
              </option>
            </select>
          </div>

          {/* Submit Action */}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleSubmitReview()}
            className="w-full py-2.5 px-4 text-xs font-semibold bg-[var(--pg-accent)] text-[var(--pg-text-inverse)] hover:bg-[var(--pg-accent-hover)] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Executing Analysis Pipeline...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                <span>Execute Code Review ({files.length} File{files.length > 1 ? 's' : ''})</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
