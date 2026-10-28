import {
  DiagnosticEvent,
  ReviewRecord,
  ReviewRequestPayload,
  StructuredApiError,
  SystemHealthStatus,
} from '../types/patchguard';
import { persistence } from './persistence';
import {
  getActiveAccessToken,
  getReviewAnalysisEndpoint,
  isLiveSupabaseClientConfigured,
} from './supabaseClient';

export interface ApiReviewResponse {
  review: ReviewRecord;
  diagnostic: DiagnosticEvent;
}

function generateClientRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function fetchSystemHealth(): Promise<SystemHealthStatus> {
  const start = performance.now();
  const storageHealthy = persistence.isLocalStorageAvailable();
  try {
    const res = await fetch('/api/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const latency = Math.round(performance.now() - start);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const supabaseConfigured = Boolean(
      data.supabaseConfigured || isLiveSupabaseClientConfigured
    );
    return {
      checkedAt: new Date().toISOString(),
      backendReachable: true,
      backendLatencyMs: latency,
      aiProviderConfigured: Boolean(data.aiProviderConfigured),
      aiConnectivityState: data.aiConnectivityState || 'unverified',
      aiConnectivityMessage:
        data.aiConnectivityMessage ||
        (data.aiProviderConfigured
          ? 'API key present in server environment; live model connectivity not yet probed in this session.'
          : 'GEMINI_API_KEY not detected in server environment; reviews default to deterministic static analyzer or Completed with Warnings.'),
      aiModelId: data.aiModelId || 'gemini-3.1-flash-lite',
      staticEngineAvailable: Boolean(data.staticEngineAvailable),
      staticEngineVersion: data.staticEngineVersion || 'pg-static-ast-1.4.2',
      supabaseConfigured,
      supabaseMode: supabaseConfigured ? 'live-supabase' : 'local-rls-mirror',
      persistenceMode: 'supabase-postgres-rls',
      persistenceHealthy: true,
    };
  } catch {
    return {
      checkedAt: new Date().toISOString(),
      backendReachable: false,
      backendLatencyMs: null,
      aiProviderConfigured: false,
      aiConnectivityState: 'failed',
      aiConnectivityMessage: 'Backend server unreachable on /api/health.',
      aiModelId: 'gemini-3.1-flash-lite',
      staticEngineAvailable: false,
      staticEngineVersion: 'pg-static-ast-1.4.2',
      supabaseConfigured: isLiveSupabaseClientConfigured,
      supabaseMode: isLiveSupabaseClientConfigured ? 'live-supabase' : 'local-rls-mirror',
      persistenceMode: storageHealthy ? 'browser-local-storage' : 'memory-fallback',
      persistenceHealthy: storageHealthy,
    };
  }
}

export async function probeAiConnectivity(): Promise<{
  verified: boolean;
  latencyMs: number;
  message: string;
  requestId: string;
}> {
  const requestId = generateClientRequestId();
  const start = performance.now();
  try {
    const res = await fetch('/api/health/probe-ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
    });
    const latencyMs = Math.round(performance.now() - start);
    const data = await res.json();

    persistence.appendDiagnostic({
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      requestId: data.requestId || requestId,
      endpoint: 'POST /api/health/probe-ai',
      durationMs: latencyMs,
      stage: 'ai-connectivity-probe',
      status: res.ok && data.verified ? 'succeeded' : 'warning',
      statusCode: res.status,
      message: data.message || 'AI connectivity probe completed.',
      retryAvailable: true,
    });

    return {
      verified: Boolean(res.ok && data.verified),
      latencyMs,
      message: data.message || 'Probe finished.',
      requestId: data.requestId || requestId,
    };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      verified: false,
      latencyMs,
      message: err?.message || 'Network failure probing /api/health/probe-ai.',
      requestId,
    };
  }
}

export async function executeCodeReview(
  payload: ReviewRequestPayload,
  accessTokenOverride?: string | null
): Promise<
  | { ok: true; review: ReviewRecord }
  | { ok: false; error: StructuredApiError; failedReview?: ReviewRecord }
> {
  const clientRequestId = generateClientRequestId();
  const start = performance.now();
  const endpoint = getReviewAnalysisEndpoint();

  try {
    const token =
      accessTokenOverride !== undefined
        ? accessTokenOverride
        : await getActiveAccessToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': clientRequestId,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Math.round(performance.now() - start);
    const body = await response.json().catch(() => null);

    if (!response.ok || !body || body.error) {
      const defaultCategory =
        response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
          ? 'FORBIDDEN_PROJECT'
          : response.status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : response.status === 429
          ? 'AI_RATE_LIMIT'
          : 'INVALID_REQUEST';

      const apiErr: StructuredApiError = body?.error || {
        category: defaultCategory,
        message: body?.message || `Review analysis failed with HTTP ${response.status}`,
        technicalDetail:
          body?.technicalDetail || `Endpoint POST ${endpoint} returned status ${response.status}.`,
        remediationStep:
          response.status === 401
            ? 'Sign in with an active account session before running code reviews.'
            : response.status === 403
            ? 'Select a project owned by your authenticated user account.'
            : 'Verify input source code and backend status in Diagnostics, or retry with Static Analysis mode.',
        requestId: body?.requestId || clientRequestId,
        timestamp: new Date().toISOString(),
        retryable: response.status >= 500 || response.status === 429,
        httpStatus: response.status,
      };

      persistence.appendDiagnostic({
        id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        requestId: apiErr.requestId,
        endpoint: `POST ${endpoint}`,
        durationMs,
        stage: 'review-execution',
        status: 'failed',
        errorCategory: apiErr.category,
        statusCode: response.status,
        message: `${apiErr.category}: ${apiErr.message}`,
        retryAvailable: apiErr.retryable,
      });

      return { ok: false, error: apiErr, failedReview: body?.failedReview };
    }

    const review: ReviewRecord = body.review;

    persistence.appendDiagnostic({
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      requestId: review.requestId || clientRequestId,
      reviewId: review.id,
      endpoint: `POST ${endpoint}`,
      durationMs: review.durationMs || durationMs,
      stage: 'complete-pipeline',
      status: review.status === 'completed_with_warnings' ? 'warning' : 'succeeded',
      statusCode: response.status,
      message:
        review.warningMessage ||
        `Completed review ${review.id} with ${review.findings.length} finding(s) across ${review.files.length} file(s).`,
      retryAvailable: false,
    });

    return { ok: true, review };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - start);
    const isAbort = err?.name === 'AbortError';
    const apiErr: StructuredApiError = {
      category: isAbort ? 'AI_TIMEOUT' : 'BACKEND_UNAVAILABLE',
      message: isAbort
        ? 'Analysis request timed out after 35,000ms.'
        : 'Unable to reach PatchGuard backend analysis service.',
      technicalDetail: isAbort
        ? `Client AbortController triggered at 35s deadline while waiting for ${endpoint}.`
        : `Fetch to POST ${endpoint} failed (${err?.message || 'network error'}).`,
      remediationStep: isAbort
        ? 'Reduce the size of the submitted file or retry using Deterministic Static Analysis mode.'
        : 'Confirm the backend server or Supabase Edge Function is reachable and check System Diagnostics.',
      requestId: clientRequestId,
      timestamp: new Date().toISOString(),
      retryable: true,
    };

    persistence.appendDiagnostic({
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      requestId: clientRequestId,
      endpoint: `POST ${endpoint}`,
      durationMs,
      stage: 'network-transport',
      status: 'failed',
      errorCategory: apiErr.category,
      statusCode: 0,
      message: `${apiErr.category}: ${apiErr.message}`,
      retryAvailable: true,
    });

    return { ok: false, error: apiErr };
  }
}
