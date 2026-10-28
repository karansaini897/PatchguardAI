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
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
  mapDatabaseRowsToReviewRecord,
  mapProjectRowToRecord,
  mapReviewToDatabaseRows,
  REVIEW_PAYLOAD_LIMITS,
  validateReviewRequestWithLimits,
} from '../../../src/lib/supabaseBackendCore.ts';
import type { ProjectRecord, SourceRetentionMode } from '../../../src/types/patchguard.ts';

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

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const requestId =
    req.headers.get('x-request-id') ||
    `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  if (req.method !== 'POST') {
    return jsonResponse(
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
      405
    );
  }

  // 1. Validate Supabase server environment
  const supabaseUrl = readServerEnv('SUPABASE_URL');
  const supabaseAnonKey = readServerEnv('SUPABASE_ANON_KEY');
  if (!isConfiguredSupabaseUrl(supabaseUrl) || !isConfiguredSupabaseAnonKey(supabaseAnonKey)) {
    return jsonResponse(
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
      503
    );
  }

  // 2. Require and validate the caller's Bearer JWT token
  const authHeader = req.headers.get('Authorization');
  const accessToken = extractBearerToken(authHeader);
  if (!accessToken) {
    return jsonResponse(
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
      401
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
      401
    );
  }

  // 3. Enforce request body-size limits and parse JSON safely
  let rawText = '';
  try {
    rawText = await req.text();
  } catch {
    return jsonResponse(
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
      400
    );
  }

  const rawBytes = new TextEncoder().encode(rawText).length;
  if (rawBytes > REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES) {
    return jsonResponse(
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
      413
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return jsonResponse(
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
      400
    );
  }

  const validation = validateReviewRequestWithLimits(parsedBody, rawBytes, requestId);
  if (!validation.ok) {
    return jsonResponse(
      {
        requestId,
        error: validation.error,
      },
      validation.httpStatus
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
        403
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
          500
        );
      }
      targetProject = mapProjectRowToRecord(createdProject as DbProjectRow);
    }
  }

  const effectiveRetentionMode: SourceRetentionMode =
    payload.retentionMode || targetProject.retentionMode || 'redacted_snippets_only';

  // 5. Execute Static Analysis + Server-Side Gemini Semantic Analysis + Line Verification
  const geminiKey = readServerEnv('GEMINI_API_KEY');
  const hasGeminiKey = isConfiguredGeminiApiKey(geminiKey);

  const outcome = await executeReviewPipeline(payload, {
    requestId,
    invokeAiModel: hasGeminiKey
      ? (prompt) => invokeGeminiFromEdge(geminiKey!, prompt)
      : null,
  });

  // 6. Save review status and findings reliably in Supabase (including safe failed state)
  if (!outcome.ok) {
    if (outcome.failedReview) {
      const sanitizedFailed = applySourceRetentionPolicy(
        {
          ...outcome.failedReview,
          projectId: targetProject.id,
          projectName: targetProject.name,
          ownerId: user.id,
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
    }

    return jsonResponse(
      {
        requestId,
        error: outcome.error,
      },
      outcome.httpStatus
    );
  }

  const sanitizedReview = applySourceRetentionPolicy(
    {
      ...outcome.review,
      projectId: targetProject.id,
      projectName: targetProject.name,
      ownerId: user.id,
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
      500
    );
  }

  if (findingRows.length > 0) {
    const { error: findingsInsertErr } = await supabase
      .from('findings')
      .upsert(findingRows);
    if (findingsInsertErr) {
      return jsonResponse(
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
        500
      );
    }
  }

  const persistedRecord = mapDatabaseRowsToReviewRecord(
    reviewRow,
    findingRows,
    targetProject.name
  );

  return jsonResponse({
    review: persistedRecord,
    project: targetProject,
    requestId,
  });
}

if (typeof Deno !== 'undefined' && typeof Deno?.serve === 'function') {
  Deno.serve(handleAnalyzeReviewEdgeRequest);
}
