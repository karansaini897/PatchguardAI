import type {
  AnalysisStageReport,
  ApiErrorCategory,
  FindingCategory,
  FindingLocation,
  ReviewExecutionStatus,
  ReviewFinding,
  ReviewRecord,
  ReviewRequestPayload,
  SeverityLevel,
  SourceFileRecord,
  StructuredApiError,
} from '../types/patchguard.ts';
import {
  computeSourceContentHash,
  createQuarantinedFindingLocation,
  mergeAndCorroborateFindings,
  resolveTargetSourceFile,
  runStaticAnalysisOnFiles,
  STATIC_ANALYZER_VERSION,
  validateAndNormalizeFindingLocation,
} from './staticAnalyzer.ts';

export const AI_MODEL_ID = 'gemini-3.1-flash-lite';

export const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3, // 1 initial request + at most 2 bounded retries
  baseDelayMs: 600,
  maxDelayMs: 4000,
  maxRetryAfterMs: 8000,
  jitterMaxMs: 250,
  perAttemptTimeoutMs: 18000,
};

/**
 * Resolves a valid TCP server port from an environment variable string,
 * falling back to defaultPort (3000) when absent, non-numeric, or outside 1..65535.
 */
export function resolveServerPort(
  rawPort: string | undefined | null,
  defaultPort = 3000
): number {
  if (!rawPort || typeof rawPort !== 'string') return defaultPort;
  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) return defaultPort;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return defaultPort;
  }
  return parsed;
}

/**
 * Verifies whether a candidate server API key is genuinely configured and not an example placeholder.
 */
export function isConfiguredGeminiApiKey(rawKey: string | undefined | null): boolean {
  if (!rawKey || typeof rawKey !== 'string') return false;
  const trimmed = rawKey.trim();
  if (trimmed.length < 10) return false;
  const isPlaceholder =
    /^(MY_GEMINI_API_KEY|YOUR_GEMINI_API_KEY|YOUR_API_KEY|YOUR_API_KEY_HERE|API_KEY_HERE|CHANGE_ME|REPLACE_ME|PLACEHOLDER|TODO|EXAMPLE_)/i.test(
      trimmed
    );
  return !isPlaceholder;
}

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  jitterMaxMs?: number;
  perAttemptTimeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  nowFn?: () => number;
}

export interface ClassifiedAiError {
  category: ApiErrorCategory;
  errorCode: string;
  httpStatus: number;
  retryable: boolean;
  sanitizedMessage: string;
  retryAfterMs: number | null;
}

export interface AiRetryResult<T> {
  ok: boolean;
  value?: T;
  attemptsMade: number;
  retriedCount: number;
  delaysMs: number[];
  error?: ClassifiedAiError;
}

export function sanitizeErrorMessage(raw: unknown): string {
  let text =
    typeof raw === 'string'
      ? raw
      : raw && typeof (raw as any).message === 'string'
      ? (raw as any).message
      : 'AI model request failed';

  const envKey =
    typeof process !== 'undefined' && process.env ? process.env.GEMINI_API_KEY?.trim() : undefined;
  if (envKey && envKey.length >= 8 && text.includes(envKey)) {
    text = text.split(envKey).join('[REDACTED]');
  }

  return text
    .replace(/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED]')
    .replace(/([?&](?:api_)?key=)[0-9A-Za-z-_]{12,}/gi, '$1[REDACTED]')
    .trim();
}

function getHeaderValue(headers: unknown, headerName: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const target = headerName.toLowerCase();

  if (typeof (headers as any).get === 'function') {
    const val = (headers as any).get(headerName) ?? (headers as any).get(target);
    if (typeof val === 'string' && val.trim() !== '') return val.trim();
  }

  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === target) {
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (Array.isArray(v) && v.length > 0 && v[0] != null) return String(v[0]).trim();
    }
  }
  return null;
}

export function parseRetryAfterMs(
  err: unknown,
  nowMs: number = Date.now(),
  maxRetryAfterMs: number = DEFAULT_RETRY_CONFIG.maxRetryAfterMs
): number | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as Record<string, any>;

  const rawHeader =
    getHeaderValue(anyErr.headers, 'retry-after') ??
    getHeaderValue(anyErr.response?.headers, 'retry-after') ??
    getHeaderValue(anyErr.error?.headers, 'retry-after') ??
    (typeof anyErr.retryAfter === 'number' || typeof anyErr.retryAfter === 'string'
      ? String(anyErr.retryAfter)
      : null);

  if (rawHeader !== null) {
    const asNumber = Number(rawHeader);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.min(maxRetryAfterMs, Math.max(0, Math.round(asNumber * 1000)));
    }
    const parsedDate = Date.parse(rawHeader);
    if (!Number.isNaN(parsedDate)) {
      const deltaMs = parsedDate - nowMs;
      if (deltaMs > 0) {
        return Math.min(maxRetryAfterMs, deltaMs);
      }
      return 0;
    }
  }

  const msg = sanitizeErrorMessage(err);
  const retryInMatch =
    msg.match(/retry\s*(?:in|after)[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|seconds)?/i) ||
    msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)(ms|s)"/i);

  if (retryInMatch) {
    const amount = Number(retryInMatch[1]);
    const unit = (retryInMatch[2] || 's').toLowerCase();
    if (Number.isFinite(amount) && amount >= 0) {
      const ms = unit.startsWith('ms') ? Math.round(amount) : Math.round(amount * 1000);
      return Math.min(maxRetryAfterMs, Math.max(0, ms));
    }
  }

  return null;
}

export function extractHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as Record<string, any>;

  const candidates = [
    anyErr.status,
    anyErr.statusCode,
    anyErr.httpStatus,
    anyErr.response?.status,
    anyErr.response?.statusCode,
    anyErr.error?.code,
    anyErr.error?.status,
    anyErr.code,
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && c >= 100 && c <= 599) {
      return c;
    }
    if (typeof c === 'string' && /^\d{3}$/.test(c.trim())) {
      const num = Number(c.trim());
      if (num >= 100 && num <= 599) return num;
    }
  }

  const msg = sanitizeErrorMessage(err);
  const httpMatch =
    msg.match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i) ||
    msg.match(/\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i) ||
    msg.match(/\bcode[:\s]+(400|401|403|404|429|500|502|503|504)\b/i) ||
    msg.match(/\b(400|401|403|404|429|500|502|503|504)\b/);

  if (httpMatch) {
    const parsed = Number(httpMatch[1]);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }

  return null;
}

export function classifyAiError(
  err: unknown,
  nowMs: number = Date.now(),
  maxRetryAfterMs: number = DEFAULT_RETRY_CONFIG.maxRetryAfterMs
): ClassifiedAiError {
  const sanitizedMessage = sanitizeErrorMessage(err);
  const upperMsg = sanitizedMessage.toUpperCase();
  const status = extractHttpStatus(err);
  const retryAfterMs = parseRetryAfterMs(err, nowMs, maxRetryAfterMs);
  const anyErr = (err && typeof err === 'object' ? err : {}) as Record<string, any>;

  // 1. Schema / Malformed JSON Response Error (Permanent - do not retry malformed output)
  if (
    anyErr.isSchemaValidationError === true ||
    upperMsg.includes('MODEL RESPONSE ROOT IS NOT A JSON ARRAY') ||
    upperMsg.includes('UNEXPECTED TOKEN') ||
    upperMsg.includes('JSON.PARSE')
  ) {
    return {
      category: 'INVALID_MODEL_RESPONSE',
      errorCode: 'INVALID_MODEL_RESPONSE',
      httpStatus: 502,
      retryable: false,
      sanitizedMessage,
      retryAfterMs: null,
    };
  }

  // 2. Permanent Authentication / Authorization / Invalid Key Errors (401, 403)
  if (
    status === 401 ||
    status === 403 ||
    upperMsg.includes('UNAUTHENTICATED') ||
    upperMsg.includes('PERMISSION_DENIED') ||
    upperMsg.includes('API_KEY_INVALID') ||
    upperMsg.includes('INVALID API KEY') ||
    upperMsg.includes('UNAUTHORIZED') ||
    upperMsg.includes('FORBIDDEN')
  ) {
    const code = status === 403 ? 403 : 401;
    return {
      category: 'AI_AUTH_ERROR',
      errorCode: `HTTP_${code}`,
      httpStatus: code,
      retryable: false,
      sanitizedMessage,
      retryAfterMs: null,
    };
  }

  // 3. Permanent Validation / Bad Request / Model Not Found Errors (400, 404, 422)
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    upperMsg.includes('INVALID_ARGUMENT') ||
    upperMsg.includes('FAILED_PRECONDITION') ||
    upperMsg.includes('NOT_FOUND') ||
    upperMsg.includes('BAD REQUEST')
  ) {
    const code = status || 400;
    return {
      category: 'INVALID_REQUEST',
      errorCode: `HTTP_${code}`,
      httpStatus: code,
      retryable: false,
      sanitizedMessage,
      retryAfterMs: null,
    };
  }

  // 4. Transient Rate Limit / Quota Exhausted (HTTP 429)
  if (
    status === 429 ||
    upperMsg.includes('RESOURCE_EXHAUSTED') ||
    upperMsg.includes('RATE LIMIT') ||
    upperMsg.includes('TOO MANY REQUESTS') ||
    upperMsg.includes('QUOTA')
  ) {
    return {
      category: 'AI_RATE_LIMIT',
      errorCode: 'HTTP_429',
      httpStatus: 429,
      retryable: true,
      sanitizedMessage,
      retryAfterMs,
    };
  }

  // 5. Transient Timeout / Deadline Exceeded (HTTP 504 / Timeout)
  if (
    status === 504 ||
    status === 408 ||
    anyErr.isTimeout === true ||
    anyErr.name === 'AbortError' ||
    upperMsg.includes('DEADLINE_EXCEEDED') ||
    upperMsg.includes('TIMED OUT') ||
    upperMsg.includes('TIMEOUT') ||
    upperMsg.includes('ETIMEDOUT')
  ) {
    return {
      category: 'AI_TIMEOUT',
      errorCode: 'HTTP_504',
      httpStatus: 504,
      retryable: true,
      sanitizedMessage,
      retryAfterMs,
    };
  }

  // 6. Transient Service Unavailable / High Demand / Overloaded (HTTP 503, 502, 500, Network Reset)
  if (
    status === 503 ||
    status === 502 ||
    status === 500 ||
    upperMsg.includes('UNAVAILABLE') ||
    upperMsg.includes('HIGH DEMAND') ||
    upperMsg.includes('OVERLOADED') ||
    upperMsg.includes('BAD GATEWAY') ||
    upperMsg.includes('ECONNRESET') ||
    upperMsg.includes('ECONNREFUSED') ||
    upperMsg.includes('FETCH FAILED')
  ) {
    const code = status === 502 || status === 500 ? status : 503;
    return {
      category: 'AI_SERVICE_UNAVAILABLE',
      errorCode: `HTTP_${code}`,
      httpStatus: code,
      retryable: true,
      sanitizedMessage,
      retryAfterMs,
    };
  }

  // 7. Unknown errors default to non-retryable to avoid retrying unknown permanent faults
  return {
    category: 'INCOMPLETE_ANALYSIS',
    errorCode: status ? `HTTP_${status}` : 'AI_STAGE_FAILED',
    httpStatus: status || 502,
    retryable: false,
    sanitizedMessage,
    retryAfterMs: null,
  };
}

export function computeBackoffDelayMs(
  retryNumber: number,
  retryAfterMs: number | null,
  options?: RetryPolicyOptions
): number {
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? DEFAULT_RETRY_CONFIG.maxRetryAfterMs;
  const jitterMaxMs = options?.jitterMaxMs ?? DEFAULT_RETRY_CONFIG.jitterMaxMs;
  const randomFn = options?.randomFn ?? Math.random;

  const expDelay = baseDelayMs * Math.pow(2, Math.max(0, retryNumber - 1));
  const jitter = Math.floor(Math.max(0, Math.min(1, randomFn())) * jitterMaxMs);
  const boundedExp = Math.min(maxDelayMs, Math.round(expDelay + jitter));

  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(maxRetryAfterMs, Math.max(boundedExp, retryAfterMs));
  }

  return boundedExp;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new Error(
            `Upstream AI model call timed out after ${timeoutMs}ms (HTTP 504 DEADLINE_EXCEEDED)`
          ) as Error & { status?: number; isTimeout?: boolean };
          timeoutErr.status = 504;
          timeoutErr.isTimeout = true;
          reject(timeoutErr);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function callAiWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryPolicyOptions
): Promise<AiRetryResult<T>> {
  const configuredMaxAttempts = options?.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts;
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(configuredMaxAttempts)));
  const perAttemptTimeoutMs =
    options?.perAttemptTimeoutMs ?? DEFAULT_RETRY_CONFIG.perAttemptTimeoutMs;
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? DEFAULT_RETRY_CONFIG.maxRetryAfterMs;
  const sleepFn = options?.sleepFn ?? defaultSleep;
  const nowFn = options?.nowFn ?? Date.now;

  const delaysMs: number[] = [];
  let attemptsMade = 0;
  let lastClassifiedError: ClassifiedAiError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      const value = await runWithTimeout(() => operation(attempt), perAttemptTimeoutMs);
      return {
        ok: true,
        value,
        attemptsMade,
        retriedCount: attemptsMade - 1,
        delaysMs,
      };
    } catch (err) {
      const classified = classifyAiError(err, nowFn(), maxRetryAfterMs);
      lastClassifiedError = classified;

      const hasRemainingAttempts = attempt < maxAttempts;
      if (!classified.retryable || !hasRemainingAttempts) {
        break;
      }

      const retryNumber = attempt;
      const delayMs = computeBackoffDelayMs(
        retryNumber,
        classified.retryAfterMs,
        options
      );
      delaysMs.push(delayMs);
      await sleepFn(delayMs);
    }
  }

  return {
    ok: false,
    attemptsMade,
    retriedCount: Math.max(0, attemptsMade - 1),
    delaysMs,
    error:
      lastClassifiedError || {
        category: 'AI_SERVICE_UNAVAILABLE',
        errorCode: 'HTTP_503',
        httpStatus: 503,
        retryable: true,
        sanitizedMessage: 'AI service unavailable after bounded retry attempts.',
        retryAfterMs: null,
      },
  };
}

export function buildStructuredErrorFromClassified(
  classified: ClassifiedAiError,
  requestId: string,
  attemptsMade: number
): StructuredApiError {
  const now = new Date().toISOString();
  const retrySummary =
    attemptsMade > 1 ? ` after ${attemptsMade} attempts (${attemptsMade - 1} retries)` : '';

  switch (classified.category) {
    case 'AI_SERVICE_UNAVAILABLE':
      return {
        category: 'AI_SERVICE_UNAVAILABLE',
        message: `AI semantic analysis service is temporarily unavailable (${classified.errorCode})${retrySummary}.`,
        technicalDetail: `${AI_MODEL_ID} returned ${classified.errorCode}: ${classified.sanitizedMessage.slice(
          0,
          200
        )}`,
        remediationStep:
          'Use Hybrid or Static-Only analysis mode to run deterministic static analysis immediately, or retry when model demand subsides.',
        requestId,
        timestamp: now,
        retryable: true,
        attemptsMade,
        httpStatus: classified.httpStatus,
      };
    case 'AI_RATE_LIMIT':
      return {
        category: 'AI_RATE_LIMIT',
        message: `Upstream AI model rate limit exceeded (HTTP 429)${retrySummary}.`,
        technicalDetail: `${AI_MODEL_ID} rejected request due to quota saturation: ${classified.sanitizedMessage.slice(
          0,
          200
        )}`,
        remediationStep:
          'Wait 15–30 seconds before retrying, or use deterministic Static Analysis while quota recovers.',
        requestId,
        timestamp: now,
        retryable: true,
        attemptsMade,
        httpStatus: 429,
      };
    case 'AI_TIMEOUT':
      return {
        category: 'AI_TIMEOUT',
        message: `Upstream AI reasoning stage timed out (HTTP 504)${retrySummary}.`,
        technicalDetail: `Deadline exceeded waiting for ${AI_MODEL_ID}: ${classified.sanitizedMessage.slice(
          0,
          200
        )}`,
        remediationStep:
          'Retry the review or scope the submission to fewer lines per request.',
        requestId,
        timestamp: now,
        retryable: true,
        attemptsMade,
        httpStatus: 504,
      };
    case 'AI_AUTH_ERROR':
      return {
        category: 'AI_AUTH_ERROR',
        message: `AI provider authentication or permission check failed (${classified.errorCode}).`,
        technicalDetail: `Permanent credential error (not retried): ${classified.sanitizedMessage.slice(
          0,
          200
        )}`,
        remediationStep:
          'Verify that GEMINI_API_KEY in server configuration is valid and has permission to invoke the configured model.',
        requestId,
        timestamp: now,
        retryable: false,
        attemptsMade,
        httpStatus: classified.httpStatus,
      };
    case 'INVALID_MODEL_RESPONSE':
      return {
        category: 'INVALID_MODEL_RESPONSE',
        message: 'AI provider returned malformed JSON that failed schema validation.',
        technicalDetail: classified.sanitizedMessage.slice(0, 200),
        remediationStep:
          'Retry the request; PatchGuard rejects unvalidated model outputs rather than fabricating findings.',
        requestId,
        timestamp: now,
        retryable: false,
        attemptsMade,
        httpStatus: 502,
      };
    case 'INVALID_REQUEST':
      return {
        category: 'INVALID_REQUEST',
        message: `AI provider rejected the request payload (${classified.errorCode}).`,
        technicalDetail: `Permanent request error (not retried): ${classified.sanitizedMessage.slice(
          0,
          200
        )}`,
        remediationStep:
          'Check the submitted source files and model configuration parameters.',
        requestId,
        timestamp: now,
        retryable: false,
        attemptsMade,
        httpStatus: classified.httpStatus,
      };
    default:
      return {
        category: 'INCOMPLETE_ANALYSIS',
        message: `AI semantic analysis stage failed (${classified.errorCode})${retrySummary}.`,
        technicalDetail: classified.sanitizedMessage.slice(0, 200),
        remediationStep:
          'Switch to Hybrid mode so deterministic static analysis can run, or verify AI provider health in Diagnostics.',
        requestId,
        timestamp: now,
        retryable: classified.retryable,
        attemptsMade,
        httpStatus: classified.httpStatus,
      };
  }
}

export function buildSimulatedError(
  category: ApiErrorCategory,
  requestId: string
): { status: number; error: StructuredApiError } {
  const now = new Date().toISOString();
  switch (category) {
    case 'MISSING_SERVER_CONFIG':
      return {
        status: 503,
        error: {
          category: 'MISSING_SERVER_CONFIG',
          message: 'AI provider API key is missing in server environment configuration.',
          technicalDetail:
            'Server checked process.env.GEMINI_API_KEY during AI-only execution mode and found an unset credential.',
          remediationStep:
            'Configure GEMINI_API_KEY in server secrets, or switch Analysis Mode to "Hybrid (Static + AI with Fallback)" or "Static Analyzer Only".',
          requestId,
          timestamp: now,
          retryable: false,
          attemptsMade: 0,
          httpStatus: 503,
        },
      };
    case 'AI_SERVICE_UNAVAILABLE':
      return {
        status: 503,
        error: {
          category: 'AI_SERVICE_UNAVAILABLE',
          message:
            'AI semantic analysis service is temporarily unavailable (HTTP 503) after 3 attempts (2 retries).',
          technicalDetail: `Model ${AI_MODEL_ID} returned HTTP 503 UNAVAILABLE (model experiencing high demand) across bounded exponential backoff retries.`,
          remediationStep:
            'Use Hybrid mode to preserve deterministic static analysis fallback, or retry when model demand subsides.',
          requestId,
          timestamp: now,
          retryable: true,
          attemptsMade: 3,
          httpStatus: 503,
        },
      };
    case 'AI_AUTH_ERROR':
      return {
        status: 401,
        error: {
          category: 'AI_AUTH_ERROR',
          message: 'AI provider authentication failed (HTTP 401).',
          technicalDetail:
            'Permanent authentication failure (API_KEY_INVALID / UNAUTHENTICATED). Request was aborted immediately without retry.',
          remediationStep:
            'Verify that the server GEMINI_API_KEY secret is valid and active.',
          requestId,
          timestamp: now,
          retryable: false,
          attemptsMade: 1,
          httpStatus: 401,
        },
      };
    case 'AI_RATE_LIMIT':
      return {
        status: 429,
        error: {
          category: 'AI_RATE_LIMIT',
          message: 'Upstream AI model rate limit exceeded (HTTP 429 RESOURCE_EXHAUSTED).',
          technicalDetail: `Model ${AI_MODEL_ID} rejected the request due to per-minute token or request quota saturation.`,
          remediationStep:
            'Wait 15–30 seconds before retrying, or execute deterministic Static Analysis while quota recovers.',
          requestId,
          timestamp: now,
          retryable: true,
          attemptsMade: 3,
          httpStatus: 429,
        },
      };
    case 'AI_TIMEOUT':
      return {
        status: 504,
        error: {
          category: 'AI_TIMEOUT',
          message: 'Upstream AI reasoning stage timed out before returning a complete response.',
          technicalDetail: `Deadline exceeded waiting for ${AI_MODEL_ID} generateContent completion.`,
          remediationStep:
            'Retry the review or scope the diff to fewer lines per submission.',
          requestId,
          timestamp: now,
          retryable: true,
          attemptsMade: 3,
          httpStatus: 504,
        },
      };
    case 'INVALID_MODEL_RESPONSE':
      return {
        status: 502,
        error: {
          category: 'INVALID_MODEL_RESPONSE',
          message: 'AI provider returned malformed JSON that failed schema validation.',
          technicalDetail:
            'Response payload from model did not conform to the required ReviewFinding[] schema contract.',
          remediationStep:
            'Retry the request; PatchGuard rejects unvalidated model outputs rather than rendering corrupted findings.',
          requestId,
          timestamp: now,
          retryable: false,
          attemptsMade: 1,
          httpStatus: 502,
        },
      };
    case 'INVALID_REQUEST':
    default:
      return {
        status: 400,
        error: {
          category: 'INVALID_REQUEST',
          message: 'Review request payload failed server-side validation.',
          technicalDetail:
            'Submitted payload must contain at least one non-empty source file with a valid filename and supported language.',
          remediationStep: 'Provide non-empty source code and a valid filename before submitting.',
          requestId,
          timestamp: now,
          retryable: false,
          attemptsMade: 1,
          httpStatus: 400,
        },
      };
  }
}

export function buildAiPromptForFiles(
  payload: ReviewRequestPayload,
  normalizedFiles: SourceFileRecord[]
): string {
  const numberedFilesPrompt = normalizedFiles
    .map((file) => {
      const numberedLines = file.content
        .split('\n')
        .map((line, i) => `${i + 1}: ${line}`)
        .join('\n');
      return `=== FILE: ${file.filename} (FileID: ${file.id}, Language: ${file.language}, Total Lines: ${file.lineCount}, ContentHash: ${file.contentHash}) ===\n${numberedLines}`;
    })
    .join('\n\n');

  return `You are PatchGuard AI, a principal-level software defect and security investigation engine.
Analyze the following source files for concrete defects, security risks, concurrency hazards, boundary bugs, error-handling flaws, and performance bottlenecks.

Review Title: ${payload.title || 'Untitled Code Review'}
Review Objective: ${payload.objective || 'General defect and security investigation'}
Focus Categories: ${(payload.focusAreas || []).join(', ') || 'all categories'}

Strict Rules:
1. Only report substantive, evidence-backed technical findings grounded in specific line numbers from the provided source code.
2. Do NOT invent hypothetical issues for lines or files that do not exist in the submission.
3. For each finding, provide the exact filename and exact 1-indexed startLine and endLine matching the numbered source lines.

Source Files:
${numberedFilesPrompt}`;
}

function hasExecutableCodeEvidence(snippet: string): boolean {
  const lines = (snippet || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(\/\/|#|--|\/\*|\*)/.test(l));
  return lines.length > 0;
}

export interface ParsedAiFindingsSummary {
  findings: ReviewFinding[];
  quarantinedCount: number;
  quarantineReasons: string[];
}

export function parseAndValidateAiFindings(
  rawText: string,
  normalizedFiles: SourceFileRecord[]
): ParsedAiFindingsSummary {
  let parsedItems: unknown;
  try {
    parsedItems = JSON.parse((rawText || '[]').trim());
  } catch (parseErr: any) {
    const schemaErr = new Error(
      `Model response is not valid JSON: ${parseErr?.message || 'syntax error'}`
    ) as Error & { isSchemaValidationError?: boolean };
    schemaErr.isSchemaValidationError = true;
    throw schemaErr;
  }

  if (!Array.isArray(parsedItems)) {
    const schemaErr = new Error('Model response root is not a JSON array.') as Error & {
      isSchemaValidationError?: boolean;
    };
    schemaErr.isSchemaValidationError = true;
    throw schemaErr;
  }

  const now = new Date().toISOString();
  let quarantinedCount = 0;
  const quarantineReasons: string[] = [];

  const validSeverities: SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info'];
  const validCategories: FindingCategory[] = [
    'security',
    'concurrency',
    'boundary',
    'error-handling',
    'performance',
    'correctness',
    'data-integrity',
    'maintainability',
  ];

  const findings: ReviewFinding[] = parsedItems.map((item: any, idx: number): ReviewFinding => {
    const requestedFileId = typeof item?.fileId === 'string' ? item.fileId : undefined;
    const requestedFilename = typeof item?.filename === 'string' ? item.filename : undefined;

    // Strictly resolve target file; never fall back to normalizedFiles[0] when filename mismatches
    const matchedFile = resolveTargetSourceFile(
      normalizedFiles,
      requestedFileId,
      requestedFilename
    );

    const parsedStart =
      item?.startLine !== undefined && item?.startLine !== null && item?.startLine !== ''
        ? Number(item.startLine)
        : undefined;
    const parsedEnd =
      item?.endLine !== undefined && item?.endLine !== null && item?.endLine !== ''
        ? Number(item.endLine)
        : undefined;

    let loc: FindingLocation;

    if (!matchedFile) {
      const displayFile = requestedFilename || requestedFileId || 'unreferenced-file';
      loc = createQuarantinedFindingLocation({
        fileId: 'unmatched-file',
        filename: displayFile,
        rawStartLine: parsedStart,
        rawEndLine: parsedEnd,
        reason: 'wrong_file',
        validationNote: `Referenced file "${displayFile}" is not present in the submitted review files (${normalizedFiles
          .map((f) => f.filename)
          .join(', ')}). PatchGuard quarantined this location instead of attributing it to another file.`,
      });
      quarantinedCount++;
      quarantineReasons.push(`wrong_file (${displayFile})`);
    } else {
      loc = validateAndNormalizeFindingLocation(matchedFile, parsedStart, parsedEnd);
      if (!loc.isValidLocation) {
        quarantinedCount++;
        quarantineReasons.push(
          `${loc.locationReason || 'invalid_line'} (${matchedFile.filename}:L${String(
            item?.startLine
          )})`
        );
      } else if (!hasExecutableCodeEvidence(loc.rawSnippet)) {
        loc = createQuarantinedFindingLocation({
          fileId: matchedFile.id,
          filename: matchedFile.filename,
          rawStartLine: loc.startLine,
          rawEndLine: loc.endLine,
          reason: 'insufficient_evidence',
          validationNote: `Referenced lines L${loc.startLine}–L${loc.endLine} in ${matchedFile.filename} contain only comments or whitespace and lack executable code evidence.`,
        });
        quarantinedCount++;
        quarantineReasons.push(`insufficient_evidence (${matchedFile.filename}:L${loc.startLine})`);
      }
    }

    const explanationText = String(item?.explanation || '').trim();
    const hasSubstantiveExplanation = explanationText.length >= 12;
    if (loc.isValidLocation && !hasSubstantiveExplanation) {
      loc = createQuarantinedFindingLocation({
        fileId: loc.fileId,
        filename: loc.filename,
        rawStartLine: loc.startLine,
        rawEndLine: loc.endLine,
        reason: 'insufficient_evidence',
        validationNote:
          'Finding did not include a substantive technical explanation supporting the vulnerability claim.',
      });
      quarantinedCount++;
      quarantineReasons.push(`insufficient_explanation (${loc.filename}:L${loc.startLine})`);
    }

    const normalizedSevInput = String(item?.severity || '')
      .trim()
      .toLowerCase() as SeverityLevel;
    const rawSev: SeverityLevel = validSeverities.includes(normalizedSevInput)
      ? normalizedSevInput
      : 'medium';

    const normalizedConfInput = String(item?.confidence || '')
      .trim()
      .toLowerCase() as 'high' | 'medium' | 'low';
    const rawConf: 'high' | 'medium' | 'low' = ['high', 'medium', 'low'].includes(
      normalizedConfInput
    )
      ? normalizedConfInput
      : 'medium';

    // Calibrate severity & confidence: do not blindly trust high/critical model severity without verified code evidence
    let calibratedSeverity: SeverityLevel = rawSev;
    let calibratedConfidence: 'high' | 'medium' | 'low' = rawConf;
    let calibrationNote = '';

    if (!loc.isValidLocation) {
      calibratedConfidence = 'low';
      if (rawSev === 'critical' || rawSev === 'high' || rawSev === 'medium') {
        calibratedSeverity = 'low';
        calibrationNote = ` [Severity downgraded from ${rawSev.toUpperCase()} to LOW because source location/evidence could not be verified (${
          loc.locationReason || 'unverified'
        }).]`;
      }
    } else if ((rawSev === 'critical' || rawSev === 'high') && rawConf === 'low') {
      calibratedSeverity = 'medium';
      calibrationNote = ` [Severity calibrated from ${rawSev.toUpperCase()} to MEDIUM because model reported LOW confidence without deterministic static corroboration.]`;
    }

    const rawCatLower = String(item?.category || '')
      .trim()
      .toLowerCase();
    let cat: FindingCategory = 'correctness';
    if (validCategories.includes(rawCatLower as FindingCategory)) {
      cat = rawCatLower as FindingCategory;
    } else if (/(sql|inject|auth|idor|secret|credential|xss|csrf|crypto|sec)/i.test(rawCatLower)) {
      cat = 'security';
    } else if (/(concurren|race|atomic|lock|thread|deadlock)/i.test(rawCatLower)) {
      cat = 'concurrency';
    } else if (/(bound|off-by-one|index|overflow|range)/i.test(rawCatLower)) {
      cat = 'boundary';
    } else if (/(error|exception|catch|swallow)/i.test(rawCatLower)) {
      cat = 'error-handling';
    } else if (/(perf|n\+1|latency|loop|memory)/i.test(rawCatLower)) {
      cat = 'performance';
    } else if (/(data|integrity|schema|transaction)/i.test(rawCatLower)) {
      cat = 'data-integrity';
    } else if (/(maintain|style|refactor)/i.test(rawCatLower)) {
      cat = 'maintainability';
    }

    const baseUncertainty =
      item?.uncertaintyNote ||
      `Generated by ${AI_MODEL_ID} semantic reasoning; verify call-site invariants before applying remediation.`;

    return {
      id: `fnd-ai-${Date.now().toString(36)}-${idx}`,
      title: String(item?.title || 'Unnamed finding'),
      severity: calibratedSeverity,
      category: cat,
      status: 'unreviewed',
      analysisSource: 'ai-gemini',
      confidence: calibratedConfidence,
      uncertaintyNote: `${baseUncertainty}${calibrationNote}`,
      location: loc,
      explanation:
        explanationText || 'No technical explanation provided by model (quarantined).',
      potentialImpact: String(item?.potentialImpact || 'Unverified operational impact.'),
      suggestedRemediation: String(
        item?.suggestedRemediation || 'Verify source lines manually before modifying code.'
      ),
      remediationCode: item?.remediationCode ? String(item.remediationCode) : undefined,
      createdAt: now,
      updatedAt: now,
    };
  });

  return { findings, quarantinedCount, quarantineReasons };
}

export interface ExecuteReviewPipelineOptions {
  requestId: string;
  /**
   * Optional function to invoke the AI model and return its raw JSON text output.
   * When null/undefined, indicates GEMINI_API_KEY is not configured on the server.
   */
  invokeAiModel?: ((prompt: string, attempt: number) => Promise<string>) | null;
  /**
   * Optional override for deterministic static analysis (used for testing static engine failures).
   */
  runStaticAnalysisFn?: (
    files: SourceFileRecord[],
    focusAreas?: FindingCategory[]
  ) => ReviewFinding[];
  retryOptions?: RetryPolicyOptions;
  onAiConnectivityUpdate?: (
    state: 'verified' | 'failed',
    message: string
  ) => void;
}

export type ExecuteReviewPipelineOutcome =
  | {
      ok: true;
      httpStatus: 200;
      review: ReviewRecord;
      requestId: string;
    }
  | {
      ok: false;
      httpStatus: number;
      error: StructuredApiError;
      requestId: string;
      failedReview?: ReviewRecord;
    };

export async function executeReviewPipeline(
  payload: ReviewRequestPayload,
  options: ExecuteReviewPipelineOptions
): Promise<ExecuteReviewPipelineOutcome> {
  const requestStart = Date.now();
  const {
    requestId,
    invokeAiModel,
    runStaticAnalysisFn = runStaticAnalysisOnFiles,
    retryOptions,
    onAiConnectivityUpdate,
  } = options;

  if (payload?.simulateFailureMode) {
    const sim = buildSimulatedError(payload.simulateFailureMode, requestId);
    return {
      ok: false,
      httpStatus: sim.status,
      error: sim.error,
      requestId,
    };
  }

  if (
    !payload ||
    !Array.isArray(payload.files) ||
    payload.files.length === 0 ||
    payload.files.some(
      (f) => !f.content || !f.content.trim() || !f.filename || !f.filename.trim()
    )
  ) {
    const errResp = buildSimulatedError('INVALID_REQUEST', requestId);
    return {
      ok: false,
      httpStatus: errResp.status,
      error: errResp.error,
      requestId,
    };
  }

  const normalizedFiles: SourceFileRecord[] = payload.files.map((f, index) => {
    const cleanContent = f.content.replace(/\r\n/g, '\n');
    return {
      id: f.id || `file-${index + 1}`,
      filename: f.filename.trim(),
      language: f.language || 'typescript',
      content: cleanContent,
      lineCount: cleanContent.split('\n').length,
      changeStatus: f.changeStatus || 'modified',
      contentHash: computeSourceContentHash(cleanContent),
    };
  });

  const analysisMode = payload.analysisMode || 'hybrid';
  const stages: AnalysisStageReport[] = [];
  let staticFindings: ReviewFinding[] = [];
  let aiFindings: ReviewFinding[] = [];
  const warnings: string[] = [];
  let errorDetails: StructuredApiError | undefined;
  let staticSucceeded = false;
  let aiSucceeded = false;
  let totalQuarantinedCount = 0;

  // Stage 1: Deterministic Static Analysis
  if (analysisMode === 'hybrid' || analysisMode === 'static-only') {
    const stgStart = Date.now();
    try {
      staticFindings = runStaticAnalysisFn(normalizedFiles, payload.focusAreas);
      const staticQuarantined = staticFindings.filter(
        (f) => !f.location.isValidLocation
      ).length;
      totalQuarantinedCount += staticQuarantined;
      staticSucceeded = true;

      stages.push({
        stageId: 'stage-static',
        name: 'Deterministic Pattern & Structural Analysis',
        engine: STATIC_ANALYZER_VERSION,
        status: staticQuarantined > 0 ? 'warning' : 'succeeded',
        durationMs: Math.max(4, Date.now() - stgStart),
        findingsProduced: staticFindings.length,
        attempts: 1,
        retriedCount: 0,
        errorMessage:
          staticQuarantined > 0
            ? `${staticQuarantined} static finding(s) had invalid locations and were quarantined.`
            : undefined,
      });
    } catch (staticErr: any) {
      const cleanMsg = sanitizeErrorMessage(staticErr);
      stages.push({
        stageId: 'stage-static',
        name: 'Deterministic Pattern & Structural Analysis',
        engine: STATIC_ANALYZER_VERSION,
        status: 'failed',
        durationMs: Math.max(4, Date.now() - stgStart),
        findingsProduced: 0,
        attempts: 1,
        retriedCount: 0,
        errorCode: 'STATIC_STAGE_FAILED',
        errorMessage: `Deterministic static analyzer failed: ${cleanMsg.slice(0, 140)}`,
      });
      warnings.push(`Static analysis stage failed (${cleanMsg.slice(0, 90)}).`);
    }
  } else {
    stages.push({
      stageId: 'stage-static',
      name: 'Deterministic Pattern & Structural Analysis',
      engine: STATIC_ANALYZER_VERSION,
      status: 'skipped',
      durationMs: 0,
      findingsProduced: 0,
      errorMessage: 'Skipped: Review executed in AI Reasoning Only mode.',
    });
  }

  // Stage 2: Gemini AI Semantic Analysis
  if (analysisMode === 'hybrid' || analysisMode === 'ai-only') {
    const aiStart = Date.now();

    if (!invokeAiModel) {
      if (analysisMode === 'ai-only') {
        const errResp = buildSimulatedError('MISSING_SERVER_CONFIG', requestId);
        return {
          ok: false,
          httpStatus: errResp.status,
          error: errResp.error,
          requestId,
        };
      }

      stages.push({
        stageId: 'stage-ai',
        name: 'Gemini Semantic Code Reasoning',
        engine: AI_MODEL_ID,
        status: 'skipped',
        durationMs: 0,
        findingsProduced: 0,
        attempts: 0,
        retriedCount: 0,
        retryable: false,
        errorCode: 'MISSING_SERVER_CONFIG',
        errorMessage:
          'Skipped: GEMINI_API_KEY is not configured on the server; semantic AI stage was skipped and review completed with deterministic static analysis.',
      });
      warnings.push(
        'Partially completed review: AI semantic stage skipped (GEMINI_API_KEY not configured on server). Showing verified findings from deterministic static analysis only.'
      );
    } else {
      const prompt = buildAiPromptForFiles(payload, normalizedFiles);

      const retryResult = await callAiWithRetry(
        async (attempt) => {
          const rawText = await invokeAiModel(prompt, attempt);
          return parseAndValidateAiFindings(rawText, normalizedFiles);
        },
        retryOptions
      );

      if (retryResult.ok && retryResult.value) {
        aiSucceeded = true;
        aiFindings = retryResult.value.findings;
        const aiQuarantined = retryResult.value.quarantinedCount;
        totalQuarantinedCount += aiQuarantined;

        onAiConnectivityUpdate?.(
          'verified',
          retryResult.retriedCount > 0
            ? `Latest review request succeeded via ${AI_MODEL_ID} on attempt ${retryResult.attemptsMade} (${retryResult.retriedCount} transient retry).`
            : `Latest review request succeeded via ${AI_MODEL_ID}.`
        );

        const retryNote =
          retryResult.retriedCount > 0
            ? `Succeeded on attempt ${retryResult.attemptsMade} after ${retryResult.retriedCount} transient retry(s).`
            : undefined;
        const quarantineNote =
          aiQuarantined > 0
            ? `${aiQuarantined} finding(s) quarantined by location/evidence verifier [${retryResult.value.quarantineReasons.join(
                ', '
              )}].`
            : undefined;

        stages.push({
          stageId: 'stage-ai',
          name: 'Gemini Semantic Code Reasoning',
          engine: AI_MODEL_ID,
          status: aiQuarantined > 0 ? 'warning' : 'succeeded',
          durationMs: Math.max(10, Date.now() - aiStart),
          findingsProduced: aiFindings.length,
          attempts: retryResult.attemptsMade,
          retriedCount: retryResult.retriedCount,
          httpStatus: 200,
          errorMessage: [retryNote, quarantineNote].filter(Boolean).join(' ') || undefined,
        });

        if (aiQuarantined > 0) {
          warnings.push(
            `${aiQuarantined} AI finding(s) failed source-location or evidence verification (${retryResult.value.quarantineReasons.join(
              ', '
            )}) and were quarantined.`
          );
        }
      } else {
        const classified = retryResult.error!;
        const structuredErr = buildStructuredErrorFromClassified(
          classified,
          requestId,
          retryResult.attemptsMade
        );
        errorDetails = structuredErr;

        onAiConnectivityUpdate?.(
          'failed',
          `AI stage error (${classified.errorCode} after ${retryResult.attemptsMade} attempt(s)): ${classified.sanitizedMessage.slice(
            0,
            120
          )}`
        );

        const attemptPhrase =
          retryResult.attemptsMade > 1
            ? `after ${retryResult.attemptsMade} attempts (${retryResult.retriedCount} retries)`
            : 'on initial attempt (permanent error — not retried)';

        stages.push({
          stageId: 'stage-ai',
          name: 'Gemini Semantic Code Reasoning',
          engine: AI_MODEL_ID,
          status: 'failed',
          durationMs: Math.max(10, Date.now() - aiStart),
          findingsProduced: 0,
          attempts: retryResult.attemptsMade,
          retriedCount: retryResult.retriedCount,
          httpStatus: classified.httpStatus,
          retryable: classified.retryable,
          errorCode: classified.errorCode,
          errorMessage: `AI model stage failed ${attemptPhrase} (${classified.errorCode}: ${classified.sanitizedMessage.slice(
            0,
            120
          )}).`,
        });

        warnings.push(
          `Partially completed review: AI semantic stage failed ${attemptPhrase} (${classified.errorCode}). Showing verified findings from deterministic static analysis only.`
        );
      }
    }
  } else {
    stages.push({
      stageId: 'stage-ai',
      name: 'Gemini Semantic Code Reasoning',
      engine: AI_MODEL_ID,
      status: 'skipped',
      durationMs: 0,
      findingsProduced: 0,
      errorMessage: 'Skipped: Review executed in Static Analyzer Only mode.',
    });
  }

  // If ALL active engines failed (no stage succeeded), mark review as failed and return structured failure
  const anyEngineSucceeded = staticSucceeded || aiSucceeded;
  if (!anyEngineSucceeded) {
    const fallbackError: StructuredApiError =
      errorDetails || {
        category: 'INCOMPLETE_ANALYSIS',
        message: 'All configured analysis engines failed to complete the review.',
        technicalDetail: warnings.join(' ') || 'Neither static nor AI analysis succeeded.',
        remediationStep:
          'Inspect System Diagnostics for stage error details and retry the review.',
        requestId,
        timestamp: new Date().toISOString(),
        retryable: true,
        httpStatus: 502,
      };

    const failedReview: ReviewRecord = {
      id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: payload.title?.trim() || `Review of ${normalizedFiles[0].filename}`,
      createdAt: new Date().toISOString(),
      durationMs: Math.max(8, Date.now() - requestStart),
      status: 'failed',
      objective:
        payload.objective?.trim() ||
        'Investigate code changes for security, concurrency, boundary, and error-handling risks.',
      focusAreas: payload.focusAreas || [],
      files: normalizedFiles,
      findings: [],
      stages,
      requestId,
      modelUsed: 'None (All Analysis Engines Failed)',
      warningMessage: fallbackError.message,
      errorDetails: fallbackError,
    };

    return {
      ok: false,
      httpStatus: fallbackError.httpStatus || 502,
      error: fallbackError,
      requestId,
      failedReview,
    };
  }

  const mergedFindings = mergeAndCorroborateFindings(staticFindings, aiFindings);

  // Determine accurate final review status and model attribution without ever implying AI succeeded when it failed
  let finalStatus: ReviewExecutionStatus;
  let modelUsed: string;

  if (analysisMode === 'static-only') {
    finalStatus = totalQuarantinedCount > 0 ? 'completed_with_warnings' : 'completed_static_only';
    modelUsed = `${STATIC_ANALYZER_VERSION} (Static Analysis Only)`;
  } else if (analysisMode === 'ai-only') {
    const hasStageWarning =
      totalQuarantinedCount > 0 || stages.some((s) => s.status === 'warning');
    finalStatus = hasStageWarning ? 'completed_with_warnings' : 'completed';
    modelUsed = AI_MODEL_ID;
  } else {
    // Hybrid mode
    if (aiSucceeded && staticSucceeded) {
      const hasStageWarning =
        totalQuarantinedCount > 0 || stages.some((s) => s.status === 'warning');
      finalStatus = hasStageWarning ? 'completed_with_warnings' : 'completed';
      modelUsed = `${AI_MODEL_ID} + ${STATIC_ANALYZER_VERSION}`;
    } else if (staticSucceeded && !aiSucceeded) {
      finalStatus = 'completed_with_warnings';
      const aiStage = stages.find((s) => s.stageId === 'stage-ai');
      const reason =
        aiStage?.errorCode === 'MISSING_SERVER_CONFIG'
          ? `${AI_MODEL_ID} skipped`
          : `${AI_MODEL_ID} failed`;
      modelUsed = `${STATIC_ANALYZER_VERSION} (Fallback — ${reason})`;
    } else {
      finalStatus = 'completed_with_warnings';
      modelUsed = `${AI_MODEL_ID} (Fallback — ${STATIC_ANALYZER_VERSION} failed)`;
    }
  }

  const reviewRecord: ReviewRecord = {
    id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: payload.title?.trim() || `Review of ${normalizedFiles[0].filename}`,
    createdAt: new Date().toISOString(),
    durationMs: Math.max(8, Date.now() - requestStart),
    status: finalStatus,
    objective:
      payload.objective?.trim() ||
      'Investigate code changes for security, concurrency, boundary, and error-handling risks.',
    focusAreas: payload.focusAreas || [],
    files: normalizedFiles,
    findings: mergedFindings,
    stages,
    requestId,
    modelUsed,
    warningMessage: warnings.length > 0 ? warnings.join(' ') : undefined,
    errorDetails,
  };

  return {
    ok: true,
    httpStatus: 200,
    review: reviewRecord,
    requestId,
  };
}
