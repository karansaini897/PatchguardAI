import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AI_MODEL_ID,
  executeReviewPipeline,
  isConfiguredGeminiApiKey,
} from '../../../src/lib/reviewOrchestrator.ts';
import {
  applySourceRetentionPolicy,
  DbProjectRow,
  extractBearerToken,
  InFlightReviewDeduplicator,
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
  mapDatabaseRowsToReviewRecord,
  mapProjectRowToRecord,
  mapReviewToDatabaseRows,
  REVIEW_PAYLOAD_LIMITS,
  SlidingWindowRateLimiter,
  validateReviewRequestWithLimits,
} from '../../../src/lib/supabaseBackendCore.ts';
import type {
  ProjectRecord,
  ReviewRecord,
  SourceRetentionMode,
} from '../../../src/types/patchguard.ts';

declare const Deno:
  | {
      env: { get(key: string): string | undefined };
      serve: (handler: (req: Request) => Response | Promise<Response>) => void;
    }
  | undefined;

function readServerEnv(name: string): string | undefined {
  if (typeof Deno !== 'undefined' && Deno?.env) {
    return Deno.env.get(name);
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  return undefined;
}

const edgeRateLimiter = new SlidingWindowRateLimiter(30, 60_000);
const edgeDeduplicator = new InFlightReviewDeduplicator(45_000);

function buildCorsHeaders(req: Request, requestId?: string): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const configuredOrigins = (readServerEnv('ALLOWED_ORIGINS') || readServerEnv('APP_URL') || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== 'MY_APP_URL');

  let allowOrigin = '*';
  if (configuredOrigins.length > 0) {
    allowOrigin = configuredOrigins.includes(origin) ? origin : configuredOrigins[0];
  } else if (origin) {
    allowOrigin = origin;
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-request-id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
    Vary: 'Origin',
  };
  if (requestId) {
    headers['X-Request-Id'] = requestId;
  }
  return headers;
}

function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
  requestId?: string
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(req, requestId),
      'Content-Type': 'application/json',
    },
  });
}

async function invokeGeminiFromEdge(apiKey: string, prompt: string): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  const response = await ai.models.generateContent({
    model: AI_MODEL_ID,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            severity: {
              type: Type.STRING,
              enum: ['critical', 'high', 'medium', 'low', 'info'],
            },
            category: {
              type: Type.STRING,
              enum: [
                'security',
                'concurrency',
                'boundary',
                'error-handling',
                'performance',
                'correctness',
                'data-integrity',
                'maintainability',
              ],
            },
            filename: { type: Type.STRING },
            startLine: { type: Type.INTEGER },
            endLine: { type: Type.INTEGER },
            confidence: {
              type: Type.STRING,
              enum: ['high', 'medium', 'low'],
            },
            uncertaintyNote: { type: Type.STRING },
            explanation: { type: Type.STRING },
            potentialImpact: { type: Type.STRING },
            suggestedRemediation: { type: Type.STRING },
            remediationCode: { type: Type.STRING },
          },
          required: [
            'title',
            'severity',
            'category',
            'filename',
            'startLine',
            'endLine',
            'confidence',
            'explanation',
            'potentialImpact',
            'suggestedRemediation',
          ],
        },
      },
    },
  });

  return (response.text || '[]').trim();
}

export async function handleAnalyzeReviewEdgeRequest(req: Request): Promise<Response> {
  const requestId =
    req.headers.get('x-request-id') ||
    `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: buildCorsHeaders(req, requestId) });
  }

  const now = new Date().toISOString();

  if (req.method !== 'POST') {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'INVALID_REQUEST',
          message: `HTTP method ${req.method} is not supported on analyze-review.`,
          technicalDetail: 'Use POST with Content-Type: application/json.',
          remediationStep: 'Send a POST request with a valid ReviewRequestPayload.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 405,
        },
      },
      405,
      requestId
    );
  }

  // 1. Validate Supabase server environment (uses ANON_KEY + user Bearer JWT under RLS)
  const supabaseUrl = readServerEnv('SUPABASE_URL');
  const supabaseAnonKey = readServerEnv('SUPABASE_ANON_KEY');
  if (!isConfiguredSupabaseUrl(supabaseUrl) || !isConfiguredSupabaseAnonKey(supabaseAnonKey)) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'MISSING_SERVER_CONFIG',
          message: 'Supabase Edge Function environment is missing SUPABASE_URL or SUPABASE_ANON_KEY.',
          technicalDetail: 'Edge runtime could not initialize RLS-scoped Supabase client.',
          remediationStep:
            'Configure SUPABASE_URL and SUPABASE_ANON_KEY in Supabase Edge Function secrets.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 503,
        },
      },
      503,
      requestId
    );
  }

  // 2. Require and validate the caller's Bearer JWT token
  const authHeader = req.headers.get('Authorization');
  const accessToken = extractBearerToken(authHeader);
  if (!accessToken) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'AUTH_REQUIRED',
          message: 'Authentication required: missing Bearer access token.',
          technicalDetail: 'Authorization header was absent or malformed.',
          remediationStep: 'Sign in with Supabase Auth and include Authorization: Bearer <token>.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 401,
        },
      },
      401,
      requestId
    );
  }

  const supabase = createClient(supabaseUrl!, supabaseAnonKey!, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);

  if (authError || !user) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'AUTH_REQUIRED',
          message: 'Authentication failed: session token is invalid or expired.',
          technicalDetail: authError?.message || 'supabase.auth.getUser returned null user.',
          remediationStep: 'Sign in again to obtain a fresh access token.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 401,
        },
      },
      401,
      requestId
    );
  }

  // 2b. Per-user sliding-window rate limiting
  const rl = edgeRateLimiter.checkAndRecord(user.id);
  if (!rl.allowed) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded for review executions. Retry in ${rl.retryAfterSeconds}s.`,
          technicalDetail: `Authenticated user ${user.id} exceeded the sliding-window review request quota.`,
          remediationStep: `Wait ${rl.retryAfterSeconds} seconds before submitting another code review.`,
          requestId,
          timestamp: now,
          retryable: true,
          httpStatus: 429,
        },
      },
      429,
      requestId
    );
  }

  // 3. Enforce request body-size limits and parse JSON safely
  let rawText = '';
  try {
    rawText = await req.text();
  } catch {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'INVALID_REQUEST',
          message: 'Unable to read request body stream.',
          technicalDetail: 'Request body stream read failed.',
          remediationStep: 'Send a valid UTF-8 JSON body.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 400,
        },
      },
      400,
      requestId
    );
  }

  const rawBytes = new TextEncoder().encode(rawText).length;
  if (rawBytes > REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds maximum size (${Math.round(
            REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES / 1024
          )} KB).`,
          technicalDetail: `Body byte length ${rawBytes} exceeds ${REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES}.`,
          remediationStep: 'Reduce the number or size of submitted source files.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 413,
        },
      },
      413,
      requestId
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'INVALID_REQUEST',
          message: 'Request body is not valid JSON.',
          technicalDetail: 'JSON.parse failed on request payload.',
          remediationStep: 'Ensure Content-Type is application/json and body is valid JSON.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 400,
        },
      },
      400,
      requestId
    );
  }

  // 3b. Reject forged ownerId / owner_id in request body
  if (parsedBody && typeof parsedBody === 'object') {
    const rawObj = parsedBody as Record<string, unknown>;
    const candidateOwnerId =
      typeof rawObj.ownerId === 'string'
        ? rawObj.ownerId.trim()
        : typeof rawObj.owner_id === 'string'
        ? rawObj.owner_id.trim()
        : undefined;
    if (candidateOwnerId && candidateOwnerId !== user.id) {
      return jsonResponse(
        req,
        {
          requestId,
          error: {
            category: 'FORBIDDEN_PROJECT',
            message: 'Access denied: cannot forge owner_id for another user account.',
            technicalDetail: `Request payload attempted to set owner_id=${candidateOwnerId} for authenticated user ${user.id}.`,
            remediationStep:
              'Omit ownerId from the request body; ownership is derived strictly from your verified Bearer JWT.',
            requestId,
            timestamp: now,
            retryable: false,
            httpStatus: 403,
          },
        },
        403,
        requestId
      );
    }
  }

  const validation = validateReviewRequestWithLimits(parsedBody, rawBytes, requestId);
  if (!validation.ok) {
    return jsonResponse(
      req,
      {
        requestId,
        error: validation.error,
      },
      validation.httpStatus,
      requestId
    );
  }

  const payload = validation.validatedPayload;

  // 4. Confirm the user owns or is authorized to access the target project
  let targetProject: ProjectRecord | null = null;

  if (payload.projectId) {
    const { data: projectRow, error: projErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', payload.projectId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (projErr || !projectRow) {
      return jsonResponse(
        req,
        {
          requestId,
          error: {
            category: 'FORBIDDEN_PROJECT',
            message:
              'Access denied: you do not own or have permission to save reviews to the specified project.',
            technicalDetail:
              projErr?.message ||
              `Project ${payload.projectId} not found or not owned by user ${user.id}.`,
            remediationStep: 'Select a valid project owned by your account.',
            requestId,
            timestamp: now,
            retryable: false,
            httpStatus: 403,
          },
        },
        403,
        requestId
      );
    }
    targetProject = mapProjectRowToRecord(projectRow as DbProjectRow);
  } else {
    // Resolve or provision the user's default project
    const { data: existingProjects } = await supabase
      .from('projects')
      .select('*')
      .eq('owner_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (existingProjects && existingProjects.length > 0) {
      targetProject = mapProjectRowToRecord(existingProjects[0] as DbProjectRow);
    } else {
      const { data: createdProject, error: createProjErr } = await supabase
        .from('projects')
        .insert({
          owner_id: user.id,
          name: 'Core Engineering Repository',
          slug: `core-engineering-${Date.now().toString(36)}`,
          repository: 'github.com/org/core-services',
          default_branch: 'main',
          retention_mode: payload.retentionMode || 'redacted_snippets_only',
        })
        .select('*')
        .single();

      if (createProjErr || !createdProject) {
        return jsonResponse(
          req,
          {
            requestId,
            error: {
              category: 'PERSISTENCE_FAILURE',
              message: 'Failed to initialize default project in Supabase.',
              technicalDetail: createProjErr?.message || 'Insert into public.projects returned null.',
              remediationStep:
                'Verify that migration 20261028000001_patchguard_phase1.sql has been applied.',
              requestId,
              timestamp: now,
              retryable: true,
              httpStatus: 500,
            },
          },
          500,
          requestId
        );
      }
      targetProject = mapProjectRowToRecord(createdProject as DbProjectRow);
    }
  }

  // 4b. Duplicate in-flight submission protection
  const submissionFingerprint = InFlightReviewDeduplicator.computeSubmissionFingerprint(
    user.id,
    {
      ...payload,
      projectId: targetProject.id,
    }
  );
  if (!edgeDeduplicator.tryAcquire(submissionFingerprint)) {
    return jsonResponse(
      req,
      {
        requestId,
        error: {
          category: 'DUPLICATE_IN_FLIGHT',
          message: 'An identical review submission for this project is already in progress.',
          technicalDetail: 'Duplicate concurrent submission rejected while active pipeline is running.',
          remediationStep: 'Wait for the active review to finish before submitting the same files again.',
          requestId,
          timestamp: now,
          retryable: false,
          httpStatus: 409,
        },
      },
      409,
      requestId
    );
  }

  try {
    const effectiveRetentionMode: SourceRetentionMode =
      payload.retentionMode || targetProject.retentionMode || 'redacted_snippets_only';

    // 5. Persist initial `in_progress` review record prior to analysis
    const provisionalReviewId = `rev-${Date.now().toString(36)}-${requestId.slice(-4)}`;
    const initialInProgressRecord: ReviewRecord = applySourceRetentionPolicy(
      {
        id: provisionalReviewId,
        projectId: targetProject.id,
        projectName: targetProject.name,
        ownerId: user.id,
        title: (payload.title || 'Untitled Code Review').trim(),
        objective: (payload.objective || 'General defect and security investigation').trim(),
        createdAt: now,
        startedAt: now,
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
      user.id,
      targetProject.id,
      payload.analysisMode || 'hybrid'
    );
    await supabase.from('reviews').upsert(initialMapped.reviewRow);

    // 6. Execute Static Analysis + Server-Side Gemini Semantic Analysis + Line Verification
    const geminiKey = readServerEnv('GEMINI_API_KEY');
    const hasGeminiKey = isConfiguredGeminiApiKey(geminiKey);

    const outcome = await executeReviewPipeline(payload, {
      requestId,
      invokeAiModel: hasGeminiKey
        ? (prompt) => invokeGeminiFromEdge(geminiKey!, prompt)
        : null,
    });

    const completedAtIso = new Date().toISOString();

    // 7. Save review status and findings reliably in Supabase (including safe failed state)
    if (!outcome.ok) {
      if (outcome.failedReview) {
        const sanitizedFailed = applySourceRetentionPolicy(
          {
            ...outcome.failedReview,
            id: provisionalReviewId,
            projectId: targetProject.id,
            projectName: targetProject.name,
            ownerId: user.id,
            createdAt: now,
            startedAt: now,
            completedAt: completedAtIso,
          },
          effectiveRetentionMode
        );
        const { reviewRow } = mapReviewToDatabaseRows(
          sanitizedFailed,
          user.id,
          targetProject.id,
          payload.analysisMode || 'hybrid'
        );
        await supabase.from('reviews').upsert(reviewRow);
      } else {
        await supabase
          .from('reviews')
          .delete()
          .eq('id', initialMapped.reviewRow.id)
          .eq('owner_id', user.id);
      }

      return jsonResponse(
        req,
        {
          requestId,
          error: outcome.error,
        },
        outcome.httpStatus,
        requestId
      );
    }

    const sanitizedReview = applySourceRetentionPolicy(
      {
        ...outcome.review,
        id: provisionalReviewId,
        projectId: targetProject.id,
        projectName: targetProject.name,
        ownerId: user.id,
        createdAt: now,
        startedAt: now,
        completedAt: completedAtIso,
      },
      effectiveRetentionMode
    );

    const { reviewRow, findingRows } = mapReviewToDatabaseRows(
      sanitizedReview,
      user.id,
      targetProject.id,
      payload.analysisMode || 'hybrid'
    );

    const { error: reviewInsertErr } = await supabase.from('reviews').upsert(reviewRow);
    if (reviewInsertErr) {
      return jsonResponse(
        req,
        {
          requestId,
          error: {
            category: 'PERSISTENCE_FAILURE',
            message: 'Failed to save review record to Supabase Postgres.',
            technicalDetail: reviewInsertErr.message,
            remediationStep:
              'Verify public.reviews schema and RLS policies in your Supabase project.',
            requestId,
            timestamp: new Date().toISOString(),
            retryable: true,
            httpStatus: 500,
          },
        },
        500,
        requestId
      );
    }

    if (findingRows.length > 0) {
      const { error: findingsInsertErr } = await supabase
        .from('findings')
        .upsert(findingRows);
      if (findingsInsertErr) {
        return jsonResponse(
          req,
          {
            requestId,
            error: {
              category: 'PERSISTENCE_FAILURE',
              message: 'Failed to save verified findings to Supabase Postgres.',
              technicalDetail: findingsInsertErr.message,
              remediationStep:
                'Verify public.findings schema and RLS policies in your Supabase project.',
              requestId,
              timestamp: new Date().toISOString(),
              retryable: true,
              httpStatus: 500,
            },
          },
          500,
          requestId
        );
      }
    }

    const persistedRecord = mapDatabaseRowsToReviewRecord(
      reviewRow,
      findingRows,
      targetProject.name
    );

    return jsonResponse(
      req,
      {
        review: persistedRecord,
        project: targetProject,
        requestId,
      },
      200,
      requestId
    );
  } finally {
    edgeDeduplicator.release(submissionFingerprint);
  }
}

if (typeof Deno !== 'undefined' && typeof Deno?.serve === 'function') {
  Deno.serve(handleAnalyzeReviewEdgeRequest);
}
