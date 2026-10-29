import type {
  AnalysisStageReport,
  ApiErrorCategory,
  AuthenticatedUser,
  FindingCategory,
  FindingStatus,
  LocationValidationReason,
  ProjectRecord,
  ReviewExecutionStatus,
  ReviewFinding,
  ReviewRecord,
  ReviewRequestPayload,
  SeverityLevel,
  SourceFileRecord,
  SourceRetentionMetadata,
  SourceRetentionMode,
  StructuredApiError,
} from '../types/patchguard.ts';
import {
  executeReviewPipeline,
  ExecuteReviewPipelineOptions,
} from './reviewOrchestrator.ts';
import { verifyReviewFindingsIntegrity } from './staticAnalyzer.ts';

export const REVIEW_PAYLOAD_LIMITS = {
  MAX_BODY_BYTES: 256 * 1024, // 256 KB max request payload
  MAX_FILES: 20,
  MAX_SINGLE_FILE_BYTES: 120 * 1024, // 120 KB per file
  MAX_TITLE_LENGTH: 240,
  MAX_OBJECTIVE_LENGTH: 2000,
} as const;

const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'java',
  'sql',
]);

/**
 * Validates that a candidate Supabase URL is a real https/http endpoint and not a placeholder.
 */
export function isConfiguredSupabaseUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/i.test(trimmed)) return false;
  if (
    /your-project-ref\.supabase\.co|example\.supabase\.co|placeholder|change_me|replace_me/i.test(
      trimmed
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Validates that a candidate Supabase publishable/anon key is configured and not a placeholder.
 */
/**
 * Safely decodes the payload of a standard 3-segment JWT without external dependencies
 * to inspect non-sensitive role metadata (e.g., detecting if a `service_role` JWT was
 * accidentally placed into an anon/publishable variable).
 */
export function extractJwtRoleClaim(rawToken: string | undefined | null): string | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    let jsonStr = '';
    if (typeof atob === 'function') {
      jsonStr = atob(padded);
    } else if (typeof Buffer !== 'undefined') {
      jsonStr = Buffer.from(padded, 'base64').toString('utf8');
    } else {
      return null;
    }
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return typeof parsed.role === 'string' ? parsed.role : null;
  } catch {
    return null;
  }
}

export function isConfiguredSupabaseAnonKey(rawKey: string | undefined | null): boolean {
  if (!rawKey || typeof rawKey !== 'string') return false;
  const trimmed = rawKey.trim();
  if (trimmed.length < 20) return false;
  if (
    /^(your-supabase-anon|your_supabase_anon|my_supabase_anon|placeholder|change_me|replace_me|todo)/i.test(
      trimmed
    )
  ) {
    return false;
  }
  // Never accept a secret/service_role key as a public anon key
  if (/^sb_secret_/i.test(trimmed)) {
    return false;
  }
  if (extractJwtRoleClaim(trimmed) === 'service_role') {
    return false;
  }
  return true;
}

/**
 * Validates that a candidate server-only Supabase service-role key is configured.
 */
export function isConfiguredSupabaseServiceRoleKey(
  rawKey: string | undefined | null
): boolean {
  if (!rawKey || typeof rawKey !== 'string') return false;
  const trimmed = rawKey.trim();
  if (trimmed.length < 20) return false;
  if (
    /^(your-supabase-service-role|your_supabase_service_role|placeholder|change_me|replace_me|todo)/i.test(
      trimmed
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Security audit helper: verifies that client-exposed VITE_ variables never contain
 * a Supabase service-role key or a Gemini API key.
 */
export function assertNoClientSideSecretLeakage(
  envRecord: Record<string, string | undefined>
): { safe: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const [key, value] of Object.entries(envRecord)) {
    if (!key.startsWith('VITE_')) continue;
    const upperKey = key.toUpperCase();
    const val = (value || '').trim();

    if (
      upperKey.includes('SERVICE_ROLE') ||
      upperKey.includes('GEMINI_API_KEY') ||
      upperKey.includes('SECRET_KEY')
    ) {
      violations.push(
        `Forbidden client environment variable name "${key}": server-only secrets must never use the VITE_ prefix.`
      );
    }

    if (/^AIza[0-9A-Za-z-_]{20,}/.test(val)) {
      violations.push(
        `Client variable "${key}" appears to contain a Google/Gemini API key.`
      );
    }

    if (/^sb_secret_/i.test(val) || extractJwtRoleClaim(val) === 'service_role') {
      violations.push(
        `Client variable "${key}" appears to contain a Supabase secret/service_role key.`
      );
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}

/**
 * Determines whether the isolated, development-only local authentication sandbox
 * is permitted to run.
 *
 * Security Rules:
 * 1. NEVER allowed when `NODE_ENV === 'production'`.
 * 2. NEVER allowed when live Supabase Auth (`SUPABASE_URL` + `SUPABASE_ANON_KEY`) is configured.
 * 3. NEVER allowed when `ALLOW_LOCAL_DEV_AUTH === 'false'`.
 * 4. Allowed ONLY in non-production development/test environments before a live Supabase
 *    project is configured.
 */
export function isLocalDevAuthAllowed(
  envRecord: Record<string, string | undefined>
): { allowed: boolean; reason: string } {
  const nodeEnv = (envRecord.NODE_ENV || 'development').trim().toLowerCase();
  if (nodeEnv === 'production') {
    return {
      allowed: false,
      reason:
        'Local development authentication fallback is strictly disabled in production (NODE_ENV=production). Configure SUPABASE_URL and SUPABASE_ANON_KEY to use Supabase Auth.',
    };
  }

  const explicitToggle = (envRecord.ALLOW_LOCAL_DEV_AUTH || '').trim().toLowerCase();
  if (explicitToggle === 'false' || explicitToggle === '0') {
    return {
      allowed: false,
      reason:
        'Local development authentication fallback is disabled via ALLOW_LOCAL_DEV_AUTH=false. Configure SUPABASE_URL and SUPABASE_ANON_KEY to use Supabase Auth.',
    };
  }

  const supabaseUrl = envRecord.SUPABASE_URL || envRecord.VITE_SUPABASE_URL;
  const supabaseAnonKey = envRecord.SUPABASE_ANON_KEY || envRecord.VITE_SUPABASE_ANON_KEY;
  if (isConfiguredSupabaseUrl(supabaseUrl) && isConfiguredSupabaseAnonKey(supabaseAnonKey)) {
    return {
      allowed: false,
      reason:
        'Live Supabase Auth is configured; local development authentication fallback is disabled so all sessions are verified exclusively by Supabase Auth.',
    };
  }

  return {
    allowed: true,
    reason:
      'Isolated development-only authentication sandbox is active because NODE_ENV is not production and live SUPABASE_URL / SUPABASE_ANON_KEY are not yet configured.',
  };
}

/**
 * Validates that a production deployment (`NODE_ENV === 'production'`) does not attempt
 * to enable the local-auth fallback and has real Supabase Auth configured.
 */
export function assertProductionAuthConfiguration(
  envRecord: Record<string, string | undefined>
): { valid: boolean; error?: string } {
  const nodeEnv = (envRecord.NODE_ENV || 'development').trim().toLowerCase();
  if (nodeEnv !== 'production') {
    return { valid: true };
  }

  const explicitToggle = (envRecord.ALLOW_LOCAL_DEV_AUTH || '').trim().toLowerCase();
  if (explicitToggle === 'true' || explicitToggle === '1') {
    return {
      valid: false,
      error:
        'FATAL SECURITY CONFIGURATION: ALLOW_LOCAL_DEV_AUTH cannot be enabled when NODE_ENV=production. Production deployments must use Supabase Auth.',
    };
  }

  const supabaseUrl = envRecord.SUPABASE_URL || envRecord.VITE_SUPABASE_URL;
  const supabaseAnonKey = envRecord.SUPABASE_ANON_KEY || envRecord.VITE_SUPABASE_ANON_KEY;
  if (!isConfiguredSupabaseUrl(supabaseUrl) || !isConfiguredSupabaseAnonKey(supabaseAnonKey)) {
    return {
      valid: false,
      error:
        'Production authentication requires valid SUPABASE_URL and SUPABASE_ANON_KEY environment variables. The local development auth fallback is disabled in production.',
    };
  }

  return { valid: true };
}

/**
 * Extracts a Bearer token from an HTTP Authorization header.
 */
export function extractBearerToken(
  authorizationHeader: string | undefined | null
): string | null {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return null;
  }
  const trimmed = authorizationHeader.trim();
  const match = trimmed.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim();
}

/**
 * Redacts high-entropy credentials, API keys, and private keys from source code snippets
 * before storing snapshots in Supabase Postgres.
 */
export function redactSecretsInSource(content: string): {
  redactedContent: string;
  redactedCount: number;
} {
  if (!content) {
    return { redactedContent: '', redactedCount: 0 };
  }

  let redactedCount = 0;
  const patterns: RegExp[] = [
    /\b(?:sk_live|sk_test|rk_live|rk_test)_[0-9a-zA-Z]{10,}\b/g,
    /\bAIza[0-9A-Za-z-_]{20,}\b/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bsb_secret_[0-9A-Za-z-_]{16,}\b/g,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ];

  let output = content;
  for (const regex of patterns) {
    output = output.replace(regex, () => {
      redactedCount++;
      return '[REDACTED_SECRET]';
    });
  }

  return { redactedContent: output, redactedCount };
}

/**
 * Applies the project's Source-Code Retention Policy before persisting a ReviewRecord to Supabase:
 * - Always redacts detected live secrets in both finding snippets and file contents.
 * - In `redacted_snippets_only` mode (default): purges raw source lines outside a ±4-line
 *   context window around verified findings while preserving exact 1-indexed line numbers,
 *   file lineCount, and original contentHash so line-range navigation and integrity checks remain intact.
 * - In `redacted_full_source` mode: retains the full source file with secrets redacted.
 */
export function applySourceRetentionPolicy(
  review: ReviewRecord,
  mode: SourceRetentionMode = 'redacted_snippets_only'
): ReviewRecord {
  let totalRedactedCount = 0;

  const sanitizedFindings: ReviewFinding[] = review.findings.map((finding) => {
    const snippetRedaction = redactSecretsInSource(finding.location.rawSnippet || '');
    const explanationRedaction = redactSecretsInSource(finding.explanation || '');
    const matchedPatternRedaction = finding.staticCorroboration?.matchedPattern
      ? redactSecretsInSource(finding.staticCorroboration.matchedPattern)
      : { redactedContent: '', redactedCount: 0 };

    totalRedactedCount +=
      snippetRedaction.redactedCount +
      explanationRedaction.redactedCount +
      matchedPatternRedaction.redactedCount;

    return {
      ...finding,
      explanation: explanationRedaction.redactedContent,
      staticCorroboration: finding.staticCorroboration
        ? {
            ...finding.staticCorroboration,
            matchedPattern: matchedPatternRedaction.redactedContent,
          }
        : undefined,
      location: {
        ...finding.location,
        rawSnippet: snippetRedaction.redactedContent,
      },
    };
  });

  const sanitizedFiles: SourceFileRecord[] = review.files.map((file) => {
    const fileRedaction = redactSecretsInSource(file.content);
    totalRedactedCount += fileRedaction.redactedCount;

    if (mode === 'redacted_full_source') {
      return {
        ...file,
        content: fileRedaction.redactedContent,
      };
    }

    // Mode: 'redacted_snippets_only'
    // Keep only lines within ±4 lines of any verified finding in this file (or first 5 header lines if 0 findings)
    const lines = fileRedaction.redactedContent.split('\n');
    const retainedLineNumbers = new Set<number>();

    const fileFindings = sanitizedFindings.filter(
      (f) =>
        f.location.isValidLocation &&
        (f.location.fileId === file.id || f.location.filename === file.filename)
    );

    if (fileFindings.length === 0) {
      for (let i = 1; i <= Math.min(3, lines.length); i++) {
        retainedLineNumbers.add(i);
      }
    } else {
      for (const f of fileFindings) {
        const start = Math.max(1, f.location.startLine - 4);
        const end = Math.min(lines.length, f.location.endLine + 4);
        for (let lineNum = start; lineNum <= end; lineNum++) {
          retainedLineNumbers.add(lineNum);
        }
      }
    }

    const retainedLines = lines.map((lineText, idx) => {
      const lineNum = idx + 1;
      if (retainedLineNumbers.has(lineNum)) {
        return lineText;
      }
      return '// [retained-snippet-only: non-evidence line omitted by project retention policy]';
    });

    return {
      ...file,
      content: retainedLines.join('\n'),
      lineCount: lines.length,
    };
  });

  const retentionMetadata: SourceRetentionMetadata = {
    mode,
    secretsRedacted: true,
    redactedCount: totalRedactedCount,
    rawSourcePurged: mode === 'redacted_snippets_only',
    appliedAt: new Date().toISOString(),
  };

  return {
    ...review,
    files: sanitizedFiles,
    findings: sanitizedFindings,
    retentionPolicy: retentionMetadata,
  };
}

/**
 * Enforces strict request validation and payload byte-size limits for review submissions.
 */
export function validateReviewRequestWithLimits(
  payload: unknown,
  rawByteLength?: number,
  requestId = `req-${Date.now().toString(36)}`
):
  | { ok: true; validatedPayload: ReviewRequestPayload; computedBytes: number }
  | { ok: false; httpStatus: number; error: StructuredApiError } {
  const now = new Date().toISOString();

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      httpStatus: 400,
      error: {
        category: 'INVALID_REQUEST',
        message: 'Review request body must be a non-null JSON object.',
        technicalDetail: 'Received empty, primitive, or array request body.',
        remediationStep: 'Submit a valid ReviewRequestPayload JSON object.',
        requestId,
        timestamp: now,
        retryable: false,
        httpStatus: 400,
      },
    };
  }

  const serializedBytes =
    typeof rawByteLength === 'number' && Number.isFinite(rawByteLength)
      ? rawByteLength
      : new TextEncoder().encode(JSON.stringify(payload)).length;

  if (serializedBytes > REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES) {
    return {
      ok: false,
      httpStatus: 413,
      error: {
        category: 'PAYLOAD_TOO_LARGE',
        message: `Review submission exceeds the maximum allowed payload size (${Math.round(
          REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES / 1024
        )} KB).`,
        technicalDetail: `Request payload measured ${serializedBytes} bytes; limit is ${REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES} bytes.`,
        remediationStep:
          'Split large pull requests into smaller file batches or trim generated lockfiles before submitting.',
        requestId,
        timestamp: now,
        retryable: false,
        httpStatus: 413,
      },
    };
  }

  const candidate = payload as ReviewRequestPayload;

  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      error: {
        category: 'INVALID_REQUEST',
        message: 'Review submission must include at least one source file.',
        technicalDetail: 'payload.files was missing or empty.',
        remediationStep: 'Add at least one non-empty source file to the review request.',
        requestId,
        timestamp: now,
        retryable: false,
        httpStatus: 400,
      },
    };
  }

  if (candidate.files.length > REVIEW_PAYLOAD_LIMITS.MAX_FILES) {
    return {
      ok: false,
      httpStatus: 413,
      error: {
        category: 'PAYLOAD_TOO_LARGE',
        message: `Review submission contains ${candidate.files.length} files, exceeding the limit of ${REVIEW_PAYLOAD_LIMITS.MAX_FILES} files per review.`,
        technicalDetail: `Submitted ${candidate.files.length} files; MAX_FILES is ${REVIEW_PAYLOAD_LIMITS.MAX_FILES}.`,
        remediationStep: `Submit at most ${REVIEW_PAYLOAD_LIMITS.MAX_FILES} source files per review.`,
        requestId,
        timestamp: now,
        retryable: false,
        httpStatus: 413,
      },
    };
  }

  if (
    candidate.title &&
    typeof candidate.title === 'string' &&
    candidate.title.trim().length > REVIEW_PAYLOAD_LIMITS.MAX_TITLE_LENGTH
  ) {
    return {
      ok: false,
      httpStatus: 400,
      error: {
        category: 'INVALID_REQUEST',
        message: `Review title exceeds ${REVIEW_PAYLOAD_LIMITS.MAX_TITLE_LENGTH} characters.`,
        technicalDetail: `title length=${candidate.title.trim().length}.`,
        remediationStep: 'Shorten the review title to 240 characters or fewer.',
        requestId,
        timestamp: now,
        retryable: false,
        httpStatus: 400,
      },
    };
  }

  for (let i = 0; i < candidate.files.length; i++) {
    const file = candidate.files[i];
    const filename = typeof file?.filename === 'string' ? file.filename.trim() : '';
    const content = typeof file?.content === 'string' ? file.content : '';

    if (!filename || filename.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(filename)) {
      return {
        ok: false,
        httpStatus: 400,
        error: {
          category: 'INVALID_REQUEST',
          message: `File #${i + 1} has an invalid or unsafe filename ("${filename || 'empty'}").`,
          technicalDetail:
            'Filenames must be non-empty relative repository paths and must not contain path-traversal ("..") segments or null bytes.',
          remediationStep: 'Provide a clean relative path such as src/services/ledger.ts.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 400,
        },
      };
    }

    if (!content.trim()) {
      return {
        ok: false,
        httpStatus: 400,
        error: {
          category: 'INVALID_REQUEST',
          message: `Source file "${filename}" cannot be empty.`,
          technicalDetail: `File "${filename}" contained 0 non-whitespace characters.`,
          remediationStep: 'Provide non-empty source code for every file in the review.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 400,
        },
      };
    }

    const fileBytes = new TextEncoder().encode(content).length;
    if (fileBytes > REVIEW_PAYLOAD_LIMITS.MAX_SINGLE_FILE_BYTES) {
      return {
        ok: false,
        httpStatus: 413,
        error: {
          category: 'PAYLOAD_TOO_LARGE',
          message: `Source file "${filename}" exceeds the ${Math.round(
            REVIEW_PAYLOAD_LIMITS.MAX_SINGLE_FILE_BYTES / 1024
          )} KB per-file size limit.`,
          technicalDetail: `File "${filename}" is ${fileBytes} bytes; MAX_SINGLE_FILE_BYTES is ${REVIEW_PAYLOAD_LIMITS.MAX_SINGLE_FILE_BYTES}.`,
          remediationStep: 'Scope the submission to the modified module or diff hunks.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 413,
        },
      };
    }

    if (file.language && !SUPPORTED_LANGUAGES.has(file.language)) {
      return {
        ok: false,
        httpStatus: 400,
        error: {
          category: 'INVALID_REQUEST',
          message: `Unsupported language "${String(file.language)}" for file "${filename}".`,
          technicalDetail: `Supported languages are: ${Array.from(SUPPORTED_LANGUAGES).join(', ')}.`,
          remediationStep: 'Select TypeScript, JavaScript, Python, Java, or SQL.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 400,
        },
      };
    }
  }

  return {
    ok: true,
    validatedPayload: candidate,
    computedBytes: serializedBytes,
  };
}

// ============================================================================
// Database Row Types (Matches /supabase/migrations/20261028000001_patchguard_phase1.sql)
// ============================================================================

export interface DbProjectRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  repository: string;
  default_branch: string;
  retention_mode: SourceRetentionMode;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DbReviewRow {
  id: string;
  project_id: string;
  owner_id: string;
  client_review_id: string;
  request_id: string;
  title: string;
  objective: string;
  status: ReviewExecutionStatus;
  analysis_mode: 'hybrid' | 'static-only' | 'ai-only';
  model_used: string;
  duration_ms: number;
  focus_areas: FindingCategory[];
  summary: string;
  warning_message: string | null;
  error_details: StructuredApiError | null;
  stages: AnalysisStageReport[];
  files_manifest: SourceFileRecord[];
  retention_policy: SourceRetentionMetadata;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbFindingRow {
  id: string;
  review_id: string;
  project_id: string;
  owner_id: string;
  client_finding_id: string;
  title: string;
  severity: SeverityLevel;
  confidence: 'high' | 'medium' | 'low';
  category: FindingCategory;
  status: FindingStatus;
  analysis_source: 'ai-gemini' | 'static-pattern' | 'corroborated';
  rule_id: string | null;
  uncertainty_note: string | null;
  file_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  is_valid_location: boolean;
  location_reason: LocationValidationReason;
  validation_note: string | null;
  code_snippet: string;
  content_hash: string | null;
  explanation: string;
  potential_impact: string;
  suggested_remediation: string;
  remediation_code: string | null;
  static_corroboration: ReviewFinding['staticCorroboration'] | null;
  created_at: string;
  updated_at: string;
}

function deterministicUuidFromSeed(seed: string): string {
  // If already a UUID, preserve it
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      seed
    )
  ) {
    return seed.toLowerCase();
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x12345678;
  let h4 = 0x9abcdef0;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35);
    h4 = Math.imul(h4 ^ c, 0x27d4eb2f);
  }
  const hex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, '0').slice(0, len);
  const p1 = hex(h1, 8);
  const p2 = hex(h2, 4);
  const p3 = '4' + hex(h3, 3);
  const p4 = 'a' + hex(h4, 3);
  const p5 = hex(h1 ^ h3, 6) + hex(h2 ^ h4, 6);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export function mapProjectRowToRecord(row: DbProjectRow): ProjectRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    repository: row.repository || '',
    defaultBranch: row.default_branch || 'main',
    retentionMode: row.retention_mode || 'redacted_snippets_only',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapReviewToDatabaseRows(
  review: ReviewRecord,
  ownerId: string,
  projectId: string,
  analysisMode: 'hybrid' | 'static-only' | 'ai-only' = 'hybrid'
): { reviewRow: DbReviewRow; findingRows: DbFindingRow[] } {
  const reviewUuid = deterministicUuidFromSeed(`${ownerId}:${review.id}`);
  const now = review.createdAt || new Date().toISOString();
  const startedAt = review.startedAt || now;
  const isTerminal =
    review.status === 'completed' ||
    review.status === 'completed_static_only' ||
    review.status === 'completed_with_warnings' ||
    review.status === 'failed' ||
    review.status === 'cancelled';
  const completedAt = review.completedAt || (isTerminal ? new Date().toISOString() : null);

  const retentionPolicy: SourceRetentionMetadata = review.retentionPolicy || {
    mode: 'redacted_snippets_only',
    secretsRedacted: true,
    redactedCount: 0,
    rawSourcePurged: true,
    appliedAt: now,
  };

  const verifiedCount = review.findings.filter((f) => f.location.isValidLocation).length;
  const quarantinedCount = review.findings.length - verifiedCount;
  const summary =
    review.status === 'failed'
      ? `Review execution failed: ${review.warningMessage || 'all analysis stages failed'}.`
      : review.status === 'in_progress' || review.status === 'processing' || review.status === 'queued'
      ? `Review execution in progress across ${review.files.length} file(s).`
      : `Produced ${verifiedCount} verified finding(s)${
          quarantinedCount > 0 ? ` and quarantined ${quarantinedCount} unverified location(s)` : ''
        } across ${review.files.length} file(s).`;

  const reviewRow: DbReviewRow = {
    id: reviewUuid,
    project_id: projectId,
    owner_id: ownerId,
    client_review_id: review.id,
    request_id: review.requestId,
    title: review.title,
    objective: review.objective,
    status: review.status,
    analysis_mode: analysisMode,
    model_used: review.modelUsed,
    duration_ms: Math.max(0, Math.round(review.durationMs || 0)),
    focus_areas: review.focusAreas || [],
    summary,
    warning_message: review.warningMessage || null,
    error_details: review.errorDetails || null,
    stages: review.stages || [],
    files_manifest: review.files || [],
    retention_policy: retentionPolicy,
    metadata: {
      verifiedFindingsCount: verifiedCount,
      quarantinedFindingsCount: quarantinedCount,
    },
    started_at: startedAt,
    completed_at: completedAt,
    created_at: now,
    updated_at: completedAt || now,
  };

  const findingRows: DbFindingRow[] = review.findings.map((f, index) => {
    const isValid = Boolean(f.location.isValidLocation);
    const startLine = isValid ? Math.max(1, f.location.startLine) : f.location.startLine;
    const endLine = isValid
      ? Math.max(startLine, f.location.endLine)
      : f.location.endLine;

    return {
      id: deterministicUuidFromSeed(`${reviewUuid}:${f.id}:${index}`),
      review_id: reviewUuid,
      project_id: projectId,
      owner_id: ownerId,
      client_finding_id: f.id,
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
      category: f.category,
      status: f.status,
      analysis_source: f.analysisSource,
      rule_id: f.staticCorroboration?.ruleId || null,
      uncertainty_note: f.uncertaintyNote || null,
      file_id: f.location.fileId,
      file_path: f.location.filename,
      start_line: startLine,
      end_line: endLine,
      is_valid_location: isValid,
      location_reason: f.location.locationReason || (isValid ? 'verified' : 'out_of_bounds'),
      validation_note: f.location.validationNote || null,
      code_snippet: f.location.rawSnippet || '',
      content_hash: f.location.contentHash || null,
      explanation: f.explanation,
      potential_impact: f.potentialImpact,
      suggested_remediation: f.suggestedRemediation,
      remediation_code: f.remediationCode || null,
      static_corroboration: f.staticCorroboration || null,
      created_at: f.createdAt || now,
      updated_at: f.updatedAt || now,
    };
  });

  return { reviewRow, findingRows };
}

export function mapDatabaseRowsToReviewRecord(
  reviewRow: DbReviewRow,
  findingRows: DbFindingRow[],
  projectName?: string
): ReviewRecord {
  const files: SourceFileRecord[] = Array.isArray(reviewRow.files_manifest)
    ? reviewRow.files_manifest
    : [];

  const rawFindings: ReviewFinding[] = findingRows.map((row) => ({
    id: row.client_finding_id || row.id,
    title: row.title,
    severity: row.severity,
    category: row.category,
    status: row.status,
    analysisSource: row.analysis_source,
    confidence: row.confidence,
    uncertaintyNote: row.uncertainty_note || undefined,
    location: {
      fileId: row.file_id,
      filename: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      isValidLocation: row.is_valid_location,
      rawSnippet: row.code_snippet || '',
      contentHash: row.content_hash || undefined,
      locationReason: row.location_reason,
      validationNote: row.validation_note || undefined,
    },
    explanation: row.explanation,
    potentialImpact: row.potential_impact,
    suggestedRemediation: row.suggested_remediation,
    remediationCode: row.remediation_code || undefined,
    staticCorroboration: row.static_corroboration || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  // If full source was retained, run full finding integrity verification;
  // if snippets-only retention was applied, preserve verified status when snippet & hash are present.
  const isSnippetsOnly =
    reviewRow.retention_policy?.mode === 'redacted_snippets_only' &&
    reviewRow.retention_policy?.rawSourcePurged === true;

  const verifiedFindings = isSnippetsOnly
    ? rawFindings
    : verifyReviewFindingsIntegrity(rawFindings, files);

  return {
    id: reviewRow.client_review_id || reviewRow.id,
    projectId: reviewRow.project_id,
    projectName,
    ownerId: reviewRow.owner_id,
    title: reviewRow.title,
    createdAt: reviewRow.created_at,
    startedAt: reviewRow.started_at || reviewRow.created_at,
    completedAt: reviewRow.completed_at || undefined,
    durationMs: reviewRow.duration_ms,
    status: reviewRow.status,
    objective: reviewRow.objective,
    focusAreas: reviewRow.focus_areas || [],
    files,
    findings: verifiedFindings,
    stages: Array.isArray(reviewRow.stages) ? reviewRow.stages : [],
    requestId: reviewRow.request_id,
    modelUsed: reviewRow.model_used,
    warningMessage: reviewRow.warning_message || undefined,
    errorDetails: reviewRow.error_details || undefined,
    retentionPolicy: reviewRow.retention_policy,
  };
}

// ============================================================================
// Proportionate Rate Limiter & Duplicate In-Flight Submission Guard
// Note: In-memory sliding-window controls protect single-instance Node/Edge
// processes against burst abuse and accidental double-clicks. For multi-region
// horizontal scaling, pair with Supabase API Gateway / Cloudflare / Upstash.
// ============================================================================

export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 20, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public checkAndRecord(
    subjectKey: string,
    nowMs: number = Date.now()
  ): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const key = (subjectKey || 'anonymous').trim();
    const cutoff = nowMs - this.windowMs;
    const history = (this.windows.get(key) || []).filter((ts) => ts > cutoff);

    if (history.length >= this.maxRequests) {
      const oldestInWindow = history[0] || nowMs;
      const retryAfterMs = Math.max(1000, oldestInWindow + this.windowMs - nowMs);
      this.windows.set(key, history);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    history.push(nowMs);
    this.windows.set(key, history);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - history.length),
      retryAfterSeconds: 0,
    };
  }

  public reset(): void {
    this.windows.clear();
  }
}

export class InFlightReviewDeduplicator {
  private activeKeys = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 45_000) {
    this.ttlMs = ttlMs;
  }

  public static computeSubmissionFingerprint(
    userId: string,
    payload: ReviewRequestPayload
  ): string {
    const fileParts = (payload.files || [])
      .map((f) => `${f.filename.trim()}:${f.language}:${(f.content || '').length}`)
      .join('|');
    return `${userId}::${payload.projectId || 'default'}::${(payload.title || '').trim()}::${
      payload.analysisMode || 'hybrid'
    }::${fileParts}`;
  }

  public tryAcquire(fingerprint: string, nowMs: number = Date.now()): boolean {
    const existingStart = this.activeKeys.get(fingerprint);
    if (existingStart !== undefined && nowMs - existingStart < this.ttlMs) {
      return false;
    }
    this.activeKeys.set(fingerprint, nowMs);
    return true;
  }

  public release(fingerprint: string): void {
    this.activeKeys.delete(fingerprint);
  }
}

// ============================================================================
// RLS-Enforced Relational Database Adapter
// Mirrors the exact PostgreSQL schema, foreign keys, CHECK constraints, and
// Row Level Security policies from 20261028000001_patchguard_phase1.sql.
// ============================================================================

export class RlsPolicyViolationError extends Error {
  public readonly code = '42501';
  public readonly httpStatus = 403;
  constructor(table: string, operation: string, detail: string) {
    super(
      `new row violates row-level security policy for table "${table}" (${operation}): ${detail}`
    );
    this.name = 'RlsPolicyViolationError';
  }
}

export class RlsEnforcedPostgresMirror {
  private projects = new Map<string, DbProjectRow>();
  private reviews = new Map<string, DbReviewRow>();
  private findings = new Map<string, DbFindingRow>();

  private assertAuthenticated(authUid: string | null | undefined, table: string, op: string): string {
    if (!authUid || typeof authUid !== 'string' || !authUid.trim()) {
      throw new RlsPolicyViolationError(table, op, 'auth.uid() is null (unauthenticated role)');
    }
    return authUid.trim();
  }

  public listProjects(authUid: string | null | undefined): ProjectRecord[] {
    if (!authUid) return [];
    const rows = Array.from(this.projects.values())
      .filter((p) => p.owner_id === authUid)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return rows.map(mapProjectRowToRecord);
  }

  public getProjectById(
    authUid: string | null | undefined,
    projectId: string
  ): ProjectRecord | null {
    if (!authUid) return null;
    const row = this.projects.get(projectId);
    if (!row || row.owner_id !== authUid) {
      return null; // Filtered out by RLS `projects_select_own` (auth.uid() = owner_id)
    }
    return mapProjectRowToRecord(row);
  }

  public projectExistsIgnoreRls(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  public reviewExistsIgnoreRls(clientOrDbReviewId: string): boolean {
    return Array.from(this.reviews.values()).some(
      (r) => r.client_review_id === clientOrDbReviewId || r.id === clientOrDbReviewId
    );
  }

  public createProject(
    authUid: string | null | undefined,
    input: {
      id?: string;
      ownerId?: string;
      name: string;
      repository?: string;
      defaultBranch?: string;
      retentionMode?: SourceRetentionMode;
    }
  ): ProjectRecord {
    const uid = this.assertAuthenticated(authUid, 'projects', 'INSERT');
    const rowOwnerId = input.ownerId ?? uid;

    // RLS policy `projects_insert_own`: with check (auth.uid() = owner_id)
    if (rowOwnerId !== uid) {
      throw new RlsPolicyViolationError(
        'projects',
        'INSERT',
        `owner_id (${rowOwnerId}) does not match auth.uid() (${uid})`
      );
    }

    const cleanName = (input.name || '').trim();
    if (cleanName.length < 1 || cleanName.length > 120) {
      throw new Error('CHECK constraint failed: projects_name_length_chk');
    }

    const baseSlug =
      cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'workspace';

    // Ensure unique (owner_id, slug)
    const existingSlugs = new Set(
      Array.from(this.projects.values())
        .filter((p) => p.owner_id === uid)
        .map((p) => p.slug)
    );
    let slug = baseSlug;
    let counter = 2;
    while (existingSlugs.has(slug)) {
      slug = `${baseSlug}-${counter++}`;
    }

    const now = new Date().toISOString();
    const id =
      input.id || deterministicUuidFromSeed(`proj:${uid}:${slug}:${Date.now()}:${Math.random()}`);

    const row: DbProjectRow = {
      id,
      owner_id: uid,
      name: cleanName,
      slug,
      repository: (input.repository || '').trim(),
      default_branch: (input.defaultBranch || 'main').trim() || 'main',
      retention_mode: input.retentionMode || 'redacted_snippets_only',
      metadata: {},
      created_at: now,
      updated_at: now,
    };

    this.projects.set(id, row);
    return mapProjectRowToRecord(row);
  }

  public updateProject(
    authUid: string | null | undefined,
    projectId: string,
    updates: {
      ownerId?: string;
      name?: string;
      repository?: string;
      defaultBranch?: string;
      retentionMode?: SourceRetentionMode;
    }
  ): ProjectRecord {
    const uid = this.assertAuthenticated(authUid, 'projects', 'UPDATE');
    const existing = this.projects.get(projectId);
    if (!existing || existing.owner_id !== uid) {
      throw new RlsPolicyViolationError(
        'projects',
        'UPDATE',
        `Project ${projectId} is not owned by auth.uid() (${uid})`
      );
    }

    // RLS WITH CHECK (auth.uid() = owner_id): forbid reassigning project ownership
    if (updates.ownerId !== undefined && updates.ownerId !== uid) {
      throw new RlsPolicyViolationError(
        'projects',
        'UPDATE',
        `Cannot reassign project owner_id to ${updates.ownerId}`
      );
    }

    const nextName = updates.name !== undefined ? updates.name.trim() : existing.name;
    if (nextName.length < 1 || nextName.length > 120) {
      throw new Error('CHECK constraint failed: projects_name_length_chk');
    }

    const nextRetention: SourceRetentionMode =
      updates.retentionMode !== undefined
        ? updates.retentionMode === 'redacted_full_source'
          ? 'redacted_full_source'
          : 'redacted_snippets_only'
        : existing.retention_mode;

    const updated: DbProjectRow = {
      ...existing,
      name: nextName,
      repository:
        updates.repository !== undefined ? updates.repository.trim() : existing.repository,
      default_branch:
        updates.defaultBranch !== undefined
          ? updates.defaultBranch.trim() || 'main'
          : existing.default_branch,
      retention_mode: nextRetention,
      updated_at: new Date().toISOString(),
    };
    this.projects.set(projectId, updated);
    return mapProjectRowToRecord(updated);
  }

  public updateProjectRetentionMode(
    authUid: string | null | undefined,
    projectId: string,
    retentionMode: SourceRetentionMode
  ): ProjectRecord {
    return this.updateProject(authUid, projectId, { retentionMode });
  }

  public deleteProject(
    authUid: string | null | undefined,
    projectId: string
  ): boolean {
    const uid = this.assertAuthenticated(authUid, 'projects', 'DELETE');
    const existing = this.projects.get(projectId);
    if (!existing) return false;

    if (existing.owner_id !== uid) {
      throw new RlsPolicyViolationError(
        'projects',
        'DELETE',
        `Cannot delete project ${projectId} owned by another user`
      );
    }

    this.projects.delete(projectId);

    // ON DELETE CASCADE for child reviews and findings
    for (const [revId, revRow] of this.reviews.entries()) {
      if (revRow.project_id === projectId) {
        this.reviews.delete(revId);
      }
    }
    for (const [fId, fRow] of this.findings.entries()) {
      if (fRow.project_id === projectId) {
        this.findings.delete(fId);
      }
    }

    return true;
  }

  public ensureDefaultProject(authUid: string): ProjectRecord {
    const existing = this.listProjects(authUid);
    if (existing.length > 0) {
      return existing[0];
    }
    return this.createProject(authUid, {
      name: 'Core Engineering Repository',
      repository: 'github.com/org/core-services',
      defaultBranch: 'main',
      retentionMode: 'redacted_snippets_only',
    });
  }

  public insertReviewAndFindings(
    authUid: string | null | undefined,
    reviewRow: DbReviewRow,
    findingRows: DbFindingRow[]
  ): ReviewRecord {
    const uid = this.assertAuthenticated(authUid, 'reviews', 'INSERT');

    // Enforce RLS `reviews_insert_own`:
    // auth.uid() = owner_id AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
    const parentProject = this.projects.get(reviewRow.project_id);
    if (
      reviewRow.owner_id !== uid ||
      !parentProject ||
      parentProject.owner_id !== uid
    ) {
      throw new RlsPolicyViolationError(
        'reviews',
        'INSERT',
        `Review owner_id (${reviewRow.owner_id}) or parent project (${reviewRow.project_id}) is not owned by auth.uid() (${uid})`
      );
    }

    // Validate finding rows against RLS `findings_insert_own` and CHECK constraints
    for (const fRow of findingRows) {
      if (
        fRow.owner_id !== uid ||
        fRow.review_id !== reviewRow.id ||
        fRow.project_id !== reviewRow.project_id
      ) {
        throw new RlsPolicyViolationError(
          'findings',
          'INSERT',
          `Finding (${fRow.client_finding_id}) ownership or parent review/project linkage mismatch for auth.uid() (${uid})`
        );
      }
      if (
        fRow.is_valid_location &&
        (fRow.start_line < 1 || fRow.end_line < fRow.start_line)
      ) {
        throw new Error(
          `CHECK constraint failed: findings_line_bounds_chk (start_line=${fRow.start_line}, end_line=${fRow.end_line})`
        );
      }
    }

    this.reviews.set(reviewRow.id, reviewRow);
    // Remove any previous findings for this review_id before inserting
    for (const [fId, existingFinding] of this.findings.entries()) {
      if (existingFinding.review_id === reviewRow.id) {
        this.findings.delete(fId);
      }
    }
    for (const fRow of findingRows) {
      this.findings.set(fRow.id, fRow);
    }

    // Touch parent project updated_at
    this.projects.set(parentProject.id, {
      ...parentProject,
      updated_at: new Date().toISOString(),
    });

    return mapDatabaseRowsToReviewRecord(reviewRow, findingRows, parentProject.name);
  }

  public getReviewById(
    authUid: string | null | undefined,
    clientOrDbReviewId: string
  ): ReviewRecord | null {
    if (!authUid) return null;
    const rRow = Array.from(this.reviews.values()).find(
      (r) => r.client_review_id === clientOrDbReviewId || r.id === clientOrDbReviewId
    );
    if (!rRow || rRow.owner_id !== authUid) return null;
    const proj = this.projects.get(rRow.project_id);
    if (!proj || proj.owner_id !== authUid) return null;

    const fRows = Array.from(this.findings.values()).filter(
      (f) =>
        f.review_id === rRow.id &&
        f.owner_id === authUid &&
        f.project_id === rRow.project_id
    );
    return mapDatabaseRowsToReviewRecord(rRow, fRows, proj.name);
  }

  public getFindingsByReviewId(
    authUid: string | null | undefined,
    clientOrDbReviewId: string
  ): ReviewFinding[] | null {
    const rev = this.getReviewById(authUid, clientOrDbReviewId);
    if (!rev) return null;
    return rev.findings;
  }

  public listReviews(
    authUid: string | null | undefined,
    projectId?: string
  ): ReviewRecord[] {
    if (!authUid) return [];

    // RLS `reviews_select_own`: only rows where owner_id = auth.uid() AND parent project is owned by auth.uid()
    const ownedReviewRows = Array.from(this.reviews.values())
      .filter((r) => {
        if (r.owner_id !== authUid) return false;
        if (projectId && r.project_id !== projectId) return false;
        const proj = this.projects.get(r.project_id);
        return Boolean(proj && proj.owner_id === authUid);
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return ownedReviewRows.map((rRow) => {
      const proj = this.projects.get(rRow.project_id);
      const fRows = Array.from(this.findings.values()).filter(
        (f) =>
          f.review_id === rRow.id &&
          f.owner_id === authUid &&
          f.project_id === rRow.project_id
      );
      return mapDatabaseRowsToReviewRecord(rRow, fRows, proj?.name);
    });
  }

  public updateFindingStatus(
    authUid: string | null | undefined,
    clientReviewId: string,
    clientFindingId: string,
    nextStatus: FindingStatus
  ): ReviewRecord | null {
    const uid = this.assertAuthenticated(authUid, 'findings', 'UPDATE');

    const reviewRow = Array.from(this.reviews.values()).find(
      (r) => r.client_review_id === clientReviewId || r.id === clientReviewId
    );
    if (!reviewRow) return null;

    const parentProject = this.projects.get(reviewRow.project_id);
    if (reviewRow.owner_id !== uid || !parentProject || parentProject.owner_id !== uid) {
      throw new RlsPolicyViolationError(
        'findings',
        'UPDATE',
        `Cannot update finding on review ${clientReviewId} owned by another user`
      );
    }

    const findingRow = Array.from(this.findings.values()).find(
      (f) =>
        f.review_id === reviewRow.id &&
        (f.client_finding_id === clientFindingId || f.id === clientFindingId)
    );
    if (!findingRow) return null;

    if (findingRow.owner_id !== uid) {
      throw new RlsPolicyViolationError(
        'findings',
        'UPDATE',
        `Finding ${clientFindingId} is not owned by auth.uid() (${uid})`
      );
    }

    const now = new Date().toISOString();
    const updatedFinding: DbFindingRow = {
      ...findingRow,
      status: nextStatus,
      updated_at: now,
    };
    this.findings.set(findingRow.id, updatedFinding);

    const allReviewFindings = Array.from(this.findings.values()).filter(
      (f) => f.review_id === reviewRow.id && f.owner_id === uid
    );
    return mapDatabaseRowsToReviewRecord(reviewRow, allReviewFindings, parentProject.name);
  }

  public deleteReview(
    authUid: string | null | undefined,
    clientReviewId: string
  ): boolean {
    const uid = this.assertAuthenticated(authUid, 'reviews', 'DELETE');
    const reviewRow = Array.from(this.reviews.values()).find(
      (r) => r.client_review_id === clientReviewId || r.id === clientReviewId
    );
    if (!reviewRow) return false;

    const parentProject = this.projects.get(reviewRow.project_id);
    if (reviewRow.owner_id !== uid || !parentProject || parentProject.owner_id !== uid) {
      throw new RlsPolicyViolationError(
        'reviews',
        'DELETE',
        `Cannot delete review ${clientReviewId} owned by another user`
      );
    }

    this.reviews.delete(reviewRow.id);
    // ON DELETE CASCADE for findings
    for (const [fId, fRow] of this.findings.entries()) {
      if (fRow.review_id === reviewRow.id) {
        this.findings.delete(fId);
      }
    }
    return true;
  }
}

export interface ExecuteAuthenticatedReviewFlowOptions extends ExecuteReviewPipelineOptions {
  authorizationHeader: string | undefined | null;
  rawByteLength?: number;
  verifyAccessTokenFn: (
    accessToken: string
  ) => Promise<AuthenticatedUser | null>;
  database: RlsEnforcedPostgresMirror;
  rateLimiter?: SlidingWindowRateLimiter;
  deduplicator?: InFlightReviewDeduplicator;
  onStatusTransition?: (status: ReviewExecutionStatus, reviewId: string) => void;
  simulatePersistenceFailure?: boolean;
}

export type ExecuteAuthenticatedReviewFlowOutcome =
  | {
      ok: true;
      httpStatus: 200;
      review: ReviewRecord;
      project: ProjectRecord;
      requestId: string;
    }
  | {
      ok: false;
      httpStatus: number;
      error: StructuredApiError;
      requestId: string;
      failedReview?: ReviewRecord;
    };

/**
 * Complete authenticated server-side review pipeline used by both the Express server
 * and the Supabase Edge Function architecture:
 * 1. Validates the caller's Bearer JWT token (`401 AUTH_REQUIRED`).
 * 2. Enforces rate limits (`429 RATE_LIMIT_EXCEEDED`) and request body-size bounds (`400 INVALID_REQUEST` / `413 PAYLOAD_TOO_LARGE`).
 * 3. Verifies user ownership of the target `project_id` (`403 FORBIDDEN_PROJECT`).
 * 4. Rejects concurrent duplicate in-flight submissions (`409 DUPLICATE_IN_FLIGHT`).
 * 5. Initializes review record with truthful `in_progress` status and `startedAt` timestamp.
 * 6. Runs deterministic static analysis + server-side Gemini semantic analysis + line-bound verification.
 * 7. Applies the project's Source-Code Retention Policy & secret redaction.
 * 8. Updates the review and findings in the RLS-enforced database with final status and `completedAt` timestamp.
 */
export async function executeAuthenticatedReviewFlow(
  rawPayload: unknown,
  options: ExecuteAuthenticatedReviewFlowOptions
): Promise<ExecuteAuthenticatedReviewFlowOutcome> {
  const {
    requestId,
    authorizationHeader,
    rawByteLength,
    verifyAccessTokenFn,
    database,
    rateLimiter,
    deduplicator,
    onStatusTransition,
    simulatePersistenceFailure,
    ...pipelineOptions
  } = options;
  const startedAtIso = new Date().toISOString();

  // 1. Require and validate user authentication token
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return {
      ok: false,
      httpStatus: 401,
      requestId,
      error: {
        category: 'AUTH_REQUIRED',
        message: 'Authentication required: missing Bearer access token.',
        technicalDetail:
          'Endpoint requires a valid Authorization: Bearer <access_token> header.',
        remediationStep: 'Sign in to your PatchGuard AI account and retry the review.',
        requestId,
        timestamp: startedAtIso,
        retryable: false,
        httpStatus: 401,
      },
    };
  }

  const authenticatedUser = await verifyAccessTokenFn(token);
  if (!authenticatedUser) {
    return {
      ok: false,
      httpStatus: 401,
      requestId,
      error: {
        category: 'AUTH_REQUIRED',
        message: 'Authentication failed: access token is invalid or expired.',
        technicalDetail:
          'Token verification rejected the provided Bearer token.',
        remediationStep: 'Sign in again to refresh your session token and retry.',
        requestId,
        timestamp: startedAtIso,
        retryable: false,
        httpStatus: 401,
      },
    };
  }

  // 2. Proportionate per-user rate limit check (if configured)
  if (rateLimiter) {
    const rl = rateLimiter.checkAndRecord(authenticatedUser.id);
    if (!rl.allowed) {
      return {
        ok: false,
        httpStatus: 429,
        requestId,
        error: {
          category: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded for review executions. Retry in ${rl.retryAfterSeconds}s.`,
          technicalDetail: `Authenticated user ${authenticatedUser.id} exceeded the sliding-window review request quota.`,
          remediationStep: `Wait ${rl.retryAfterSeconds} seconds before submitting another code review.`,
          requestId,
          timestamp: startedAtIso,
          retryable: true,
          httpStatus: 429,
        },
      };
    }
  }

  // 3. Enforce request schema and body-size limits
  const validation = validateReviewRequestWithLimits(rawPayload, rawByteLength, requestId);
  if (!validation.ok) {
    return {
      ok: false,
      httpStatus: validation.httpStatus,
      error: validation.error,
      requestId,
    };
  }

  const payload = validation.validatedPayload;

  // 3b. Reject forged ownerId / owner_id fields in request body
  if (rawPayload && typeof rawPayload === 'object') {
    const rawObj = rawPayload as Record<string, unknown>;
    const candidateOwnerId =
      typeof rawObj.ownerId === 'string'
        ? rawObj.ownerId.trim()
        : typeof rawObj.owner_id === 'string'
        ? rawObj.owner_id.trim()
        : undefined;
    if (candidateOwnerId && candidateOwnerId !== authenticatedUser.id) {
      return {
        ok: false,
        httpStatus: 403,
        requestId,
        error: {
          category: 'FORBIDDEN_PROJECT',
          message: 'Access denied: cannot forge owner_id for another user account.',
          technicalDetail: `Request payload attempted to set owner_id=${candidateOwnerId} for authenticated user ${authenticatedUser.id}.`,
          remediationStep: 'Omit ownerId from the request body; ownership is derived strictly from your verified Bearer JWT.',
          requestId,
          timestamp: startedAtIso,
          retryable: false,
          httpStatus: 403,
        },
      };
    }
  }

  // 4. Confirm user owns or is authorized to access the target project before running or saving
  let targetProject: ProjectRecord | null = null;
  if (payload.projectId) {
    targetProject = database.getProjectById(authenticatedUser.id, payload.projectId);
    if (!targetProject) {
      const existsForAnotherTenant = database.projectExistsIgnoreRls(payload.projectId);
      return {
        ok: false,
        httpStatus: 403,
        requestId,
        error: {
          category: 'FORBIDDEN_PROJECT',
          message: existsForAnotherTenant
            ? 'Access denied: you do not have permission to access or save reviews to this project.'
            : `Target project "${payload.projectId}" does not exist or is not accessible to your account.`,
          technicalDetail: `RLS ownership check failed for user ${authenticatedUser.id} on project_id=${payload.projectId}.`,
          remediationStep:
            'Select an authorized project owned by your account in the New Review workspace.',
          requestId,
          timestamp: startedAtIso,
          retryable: false,
          httpStatus: 403,
        },
      };
    }
  } else {
    targetProject = database.ensureDefaultProject(authenticatedUser.id);
  }

  // 5. Duplicate in-flight submission protection
  const submissionFingerprint = deduplicator
    ? InFlightReviewDeduplicator.computeSubmissionFingerprint(authenticatedUser.id, {
        ...payload,
        projectId: targetProject.id,
      })
    : null;

  if (deduplicator && submissionFingerprint) {
    if (!deduplicator.tryAcquire(submissionFingerprint)) {
      return {
        ok: false,
        httpStatus: 409,
        requestId,
        error: {
          category: 'DUPLICATE_IN_FLIGHT',
          message: 'An identical review submission for this project is already in progress.',
          technicalDetail: 'Duplicate concurrent submission rejected while active pipeline is running.',
          remediationStep: 'Wait for the active review to finish before submitting the same files again.',
          requestId,
          timestamp: startedAtIso,
          retryable: false,
          httpStatus: 409,
        },
      };
    }
  }

  try {
    const effectiveRetentionMode: SourceRetentionMode =
      payload.retentionMode || targetProject.retentionMode || 'redacted_snippets_only';

    // 6. Create initial review record in truthful `in_progress` state prior to running analysis
    const provisionalReviewId = `rev-${Date.now().toString(36)}-${requestId.slice(-4)}`;
    const initialInProgressRecord: ReviewRecord = applySourceRetentionPolicy(
      {
        id: provisionalReviewId,
        projectId: targetProject.id,
        projectName: targetProject.name,
        ownerId: authenticatedUser.id,
        title: (payload.title || 'Untitled Code Review').trim(),
        objective: (payload.objective || 'General defect and security investigation').trim(),
        createdAt: startedAtIso,
        startedAt: startedAtIso,
        durationMs: 0,
        status: 'in_progress',
        focusAreas: payload.focusAreas || [],
        files: payload.files.map((f, idx) => ({
          id: f.id || `file-${idx + 1}`,
          filename: f.filename.trim(),
          language: f.language || 'typescript',
          content: f.content,
          lineCount: f.content.split('\n').length,
          changeStatus: f.changeStatus || 'modified',
        })),
        findings: [],
        stages: [],
        requestId,
        modelUsed: 'pg-static-ast-1.4.2',
      },
      effectiveRetentionMode
    );

    const initialMapped = mapReviewToDatabaseRows(
      initialInProgressRecord,
      authenticatedUser.id,
      targetProject.id,
      payload.analysisMode || 'hybrid'
    );
    database.insertReviewAndFindings(
      authenticatedUser.id,
      initialMapped.reviewRow,
      []
    );
    onStatusTransition?.('in_progress', provisionalReviewId);

    // 7. Execute static analysis + Gemini semantic analysis + line verification
    const outcome = await executeReviewPipeline(payload, {
      ...pipelineOptions,
      requestId,
    });

    if (simulatePersistenceFailure) {
      // Remove provisional row to simulate transaction rollback
      database.deleteReview(authenticatedUser.id, provisionalReviewId);
      return {
        ok: false,
        httpStatus: 500,
        requestId,
        error: {
          category: 'PERSISTENCE_FAILURE',
          message: 'Failed to persist review record to Supabase database.',
          technicalDetail: 'Database transaction rolled back while writing review and findings rows.',
          remediationStep: 'Verify Supabase database connectivity and RLS permissions, then retry.',
          requestId,
          timestamp: new Date().toISOString(),
          retryable: true,
          httpStatus: 500,
        },
      };
    }

    const completedAtIso = new Date().toISOString();

    // 8. Persist outcome reliably (updating the provisional `in_progress` review record)
    if (!outcome.ok) {
      if (outcome.failedReview) {
        try {
          const sanitizedFailed = applySourceRetentionPolicy(
            {
              ...outcome.failedReview,
              id: provisionalReviewId,
              projectId: targetProject.id,
              projectName: targetProject.name,
              ownerId: authenticatedUser.id,
              createdAt: startedAtIso,
              startedAt: startedAtIso,
              completedAt: completedAtIso,
            },
            effectiveRetentionMode
          );
          const { reviewRow, findingRows } = mapReviewToDatabaseRows(
            sanitizedFailed,
            authenticatedUser.id,
            targetProject.id,
            payload.analysisMode || 'hybrid'
          );
          const persistedFailed = database.insertReviewAndFindings(
            authenticatedUser.id,
            reviewRow,
            findingRows
          );
          onStatusTransition?.('failed', persistedFailed.id);
          return {
            ok: false,
            httpStatus: outcome.httpStatus,
            error: outcome.error,
            requestId,
            failedReview: persistedFailed,
          };
        } catch {
          // Fall through
        }
      } else {
        // Clean up provisional row if error did not produce a failedReview record
        database.deleteReview(authenticatedUser.id, provisionalReviewId);
      }

      return {
        ok: false,
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        requestId,
        failedReview: outcome.failedReview,
      };
    }

    const sanitizedReview = applySourceRetentionPolicy(
      {
        ...outcome.review,
        id: provisionalReviewId,
        projectId: targetProject.id,
        projectName: targetProject.name,
        ownerId: authenticatedUser.id,
        createdAt: startedAtIso,
        startedAt: startedAtIso,
        completedAt: completedAtIso,
      },
      effectiveRetentionMode
    );

    const { reviewRow, findingRows } = mapReviewToDatabaseRows(
      sanitizedReview,
      authenticatedUser.id,
      targetProject.id,
      payload.analysisMode || 'hybrid'
    );

    const persistedReview = database.insertReviewAndFindings(
      authenticatedUser.id,
      reviewRow,
      findingRows
    );
    onStatusTransition?.(persistedReview.status, persistedReview.id);

    return {
      ok: true,
      httpStatus: 200,
      review: persistedReview,
      project: targetProject,
      requestId,
    };
  } catch (persistErr: any) {
    const isRls = persistErr instanceof RlsPolicyViolationError;
    return {
      ok: false,
      httpStatus: isRls ? 403 : 500,
      requestId,
      error: {
        category: isRls ? 'FORBIDDEN_PROJECT' : 'PERSISTENCE_FAILURE',
        message: isRls
          ? 'Row Level Security policy rejected review persistence.'
          : 'Failed to save review and findings to database.',
        technicalDetail: String(persistErr?.message || 'Unknown persistence error'),
        remediationStep:
          'Verify project ownership and database schema migration status.',
        requestId,
        timestamp: new Date().toISOString(),
        retryable: !isRls,
        httpStatus: isRls ? 403 : 500,
      },
    };
  } finally {
    if (deduplicator && submissionFingerprint) {
      deduplicator.release(submissionFingerprint);
    }
  }
}
