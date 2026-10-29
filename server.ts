import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  ApiErrorCategory,
  AuthenticatedUser,
  FindingStatus,
  ReviewRequestPayload,
  SourceRetentionMode,
  StructuredApiError,
} from './src/types/patchguard.ts';
import { STATIC_ANALYZER_VERSION } from './src/lib/staticAnalyzer.ts';
import {
  AI_MODEL_ID,
  callAiWithRetry,
  isConfiguredGeminiApiKey,
  resolveServerPort,
} from './src/lib/reviewOrchestrator.ts';
import {
  assertNoClientSideSecretLeakage,
  assertProductionAuthConfiguration,
  executeAuthenticatedReviewFlow,
  extractBearerToken,
  InFlightReviewDeduplicator,
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
  isLocalDevAuthAllowed,
  REVIEW_PAYLOAD_LIMITS,
  RlsEnforcedPostgresMirror,
  RlsPolicyViolationError,
  SlidingWindowRateLimiter,
} from './src/lib/supabaseBackendCore.ts';
import {
  IsolatedLocalDevAuthStore,
  LocalDevAuthForbiddenInProductionError,
} from './src/lib/localAuthSecurity.ts';

dotenv.config({ quiet: true });

const PORT = resolveServerPort(process.env.PORT, 3000);

let lastAiConnectivityState: 'unverified' | 'verified' | 'failed' = 'unverified';
let lastAiConnectivityMessage = '';

// Local RLS-enforced relational database & isolated dev-only account store
// (Active ONLY when NODE_ENV !== 'production' and live Supabase env vars are unset)
const serverRlsDatabase = new RlsEnforcedPostgresMirror();
const localDevAuthStore = new IsolatedLocalDevAuthStore(() => process.env);
const reviewRateLimiter = new SlidingWindowRateLimiter(30, 60_000);
const reviewDeduplicator = new InFlightReviewDeduplicator(45_000);

function getOrGenerateRequestId(req: express.Request, prefix = 'req'): string {
  const fromHeader = req.headers['x-request-id'];
  if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) {
    return fromHeader.trim().slice(0, 80);
  }
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function sendStructuredError(
  res: express.Response,
  httpStatus: number,
  category: ApiErrorCategory,
  message: string,
  technicalDetail: string,
  remediationStep: string,
  requestId: string,
  retryable = false
): void {
  const errorObj: StructuredApiError = {
    category,
    message,
    technicalDetail,
    remediationStep,
    requestId,
    timestamp: new Date().toISOString(),
    retryable,
    httpStatus,
  };
  res.setHeader('X-Request-Id', requestId);
  res.status(httpStatus).json({
    requestId,
    error: errorObj,
    message,
  });
}

function isSupabaseServerConfigured(): boolean {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  return isConfiguredSupabaseUrl(url) && isConfiguredSupabaseAnonKey(anonKey);
}

async function verifyRequestAccessToken(
  accessToken: string
): Promise<AuthenticatedUser | null> {
  if (!accessToken || typeof accessToken !== 'string') return null;
  const trimmedToken = accessToken.trim();
  if (!trimmedToken) return null;

  // 1. Verify against live Supabase Auth when configured
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const isLocalTokenPrefix =
    trimmedToken.startsWith('pg_dev_jwt_') || trimmedToken.startsWith('pg_jwt_');

  if (
    !isLocalTokenPrefix &&
    isConfiguredSupabaseUrl(supabaseUrl) &&
    isConfiguredSupabaseAnonKey(supabaseAnonKey)
  ) {
    try {
      const supabase = createClient(supabaseUrl!.trim(), supabaseAnonKey!.trim(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(trimmedToken);
      if (!error && user) {
        serverRlsDatabase.ensureDefaultProject(user.id);
        return {
          id: user.id,
          email: user.email || 'authenticated@supabase.user',
          accessToken: trimmedToken,
          authProvider: 'supabase-jwt',
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  // 2. Verify isolated development-only session token ONLY when local dev auth is allowed
  // (Strictly refused when NODE_ENV === 'production' or when live Supabase Auth is configured)
  const devAuthCheck = isLocalDevAuthAllowed(process.env);
  if (!devAuthCheck.allowed) {
    return null;
  }

  const session = localDevAuthStore.verifySessionToken(trimmedToken);
  if (!session) return null;

  return {
    id: session.userId,
    email: session.email,
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    authProvider: 'local-session-jwt',
  };
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isConfiguredGeminiApiKey(apiKey)) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: apiKey!.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function invokeGeminiReviewModel(
  ai: GoogleGenAI,
  prompt: string
): Promise<string> {
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
              description: 'critical, high, medium, low, or info',
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
              description:
                'security, concurrency, boundary, error-handling, performance, correctness, data-integrity, or maintainability',
            },
            filename: { type: Type.STRING },
            startLine: { type: Type.INTEGER },
            endLine: { type: Type.INTEGER },
            confidence: {
              type: Type.STRING,
              enum: ['high', 'medium', 'low'],
              description: 'high, medium, or low',
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

async function startServer() {
  // 1. Startup secret-leakage & production authentication safety verification
  const secretLeakCheck = assertNoClientSideSecretLeakage(
    process.env as Record<string, string | undefined>
  );
  if (!secretLeakCheck.safe) {
    console.error(
      '[PatchGuard Security Audit] Refusing to start due to client-side secret exposure in VITE_* environment variables:',
      secretLeakCheck.violations
    );
    process.exit(1);
  }

  const prodAuthCheck = assertProductionAuthConfiguration(
    process.env as Record<string, string | undefined>
  );
  if (
    !prodAuthCheck.valid &&
    (process.env.ALLOW_LOCAL_DEV_AUTH || '').trim().toLowerCase() === 'true'
  ) {
    console.error(`[PatchGuard Security Audit] ${prodAuthCheck.error}`);
    process.exit(1);
  }

  const app = express();

  // 2. Explicit origin-checked CORS policy (never combines wildcard '*' with credentials)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const configuredOrigins = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0 && o !== 'MY_APP_URL');

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');

    if (origin) {
      const isLocalhostDev =
        process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
      const isExplicitlyAllowed = configuredOrigins.includes(origin);

      if (isExplicitlyAllowed || isLocalhostDev) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, X-Request-Id, apikey, x-client-info'
        );
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PATCH, DELETE, OPTIONS'
        );
      }
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Enforce strict request size limit matching REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES (256 KB)
  app.use(
    express.json({
      limit: REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES,
      verify: (req: any, _res, buf) => {
        req.rawByteLength = buf.length;
      },
    })
  );

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const requestId = getOrGenerateRequestId(req, 'req-err');

    if (err && err.type === 'entity.too.large') {
      sendStructuredError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `Request body exceeds maximum allowed size (${Math.round(
          REVIEW_PAYLOAD_LIMITS.MAX_BODY_BYTES / 1024
        )} KB).`,
        'Express body-parser rejected oversized JSON payload.',
        'Reduce the number or size of submitted source files.',
        requestId,
        false
      );
      return;
    }

    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        'Request body is not valid JSON.',
        'Express JSON parser rejected malformed request payload.',
        'Ensure request payload is valid JSON with Content-Type: application/json.',
        requestId,
        false
      );
      return;
    }
    next(err);
  });

  // ==========================================================================
  // Operational Endpoints: Health & AI Connectivity Probe
  // ==========================================================================
  const handleHealthCheck = (req: express.Request, res: express.Response) => {
    const requestId = getOrGenerateRequestId(req, 'health');
    const aiConfigured = isConfiguredGeminiApiKey(process.env.GEMINI_API_KEY);
    const supabaseLive = isSupabaseServerConfigured();
    const devAuth = isLocalDevAuthAllowed(process.env as Record<string, string | undefined>);
    res.setHeader('X-Request-Id', requestId);
    res.json({
      status: 'ok',
      requestId,
      timestamp: new Date().toISOString(),
      aiProviderConfigured: aiConfigured,
      aiConnectivityState: lastAiConnectivityState,
      aiConnectivityMessage:
        lastAiConnectivityMessage ||
        (aiConfigured
          ? 'GEMINI_API_KEY is configured on server. Run "Probe AI Connectivity" in Diagnostics to verify live model reachability.'
          : 'GEMINI_API_KEY is not set. Deterministic static analysis (pg-static-ast-1.4.2) is active; AI pass will report a transparent warning.'),
      aiModelId: AI_MODEL_ID,
      staticEngineAvailable: true,
      staticEngineVersion: STATIC_ANALYZER_VERSION,
      supabaseConfigured: supabaseLive,
      supabaseMode: supabaseLive
        ? 'live-supabase'
        : devAuth.allowed
        ? 'local-rls-mirror'
        : 'unconfigured-production',
      localDevAuthAllowed: devAuth.allowed,
    });
  };

  app.get('/api/health', handleHealthCheck);
  app.get('/functions/v1/health', handleHealthCheck);

  app.post('/api/health/probe-ai', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'probe');
    res.setHeader('X-Request-Id', requestId);
    const ai = getAiClient();
    if (!ai) {
      lastAiConnectivityState = 'failed';
      lastAiConnectivityMessage =
        'Probe skipped: GEMINI_API_KEY is not present in the server environment.';
      res.status(200).json({
        verified: false,
        requestId,
        message: lastAiConnectivityMessage,
      });
      return;
    }

    const probeResult = await callAiWithRetry(
      async () => {
        const response = await ai.models.generateContent({
          model: AI_MODEL_ID,
          contents: 'Respond with the single word READY.',
        });
        return (response.text || '').trim();
      },
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 3000,
        perAttemptTimeoutMs: 12000,
      }
    );

    if (probeResult.ok) {
      const text = probeResult.value || '';
      const retryNote =
        probeResult.retriedCount > 0
          ? ` after ${probeResult.retriedCount} transient retry`
          : '';
      lastAiConnectivityState = 'verified';
      lastAiConnectivityMessage = `Live connectivity to ${AI_MODEL_ID} verified${retryNote} (${
        text.slice(0, 24) || 'OK'
      }).`;
      res.json({
        verified: true,
        requestId,
        message: lastAiConnectivityMessage,
      });
    } else {
      const errInfo = probeResult.error!;
      lastAiConnectivityState = 'failed';
      lastAiConnectivityMessage = `Live probe to ${AI_MODEL_ID} failed (${errInfo.errorCode} after ${probeResult.attemptsMade} attempt(s)): ${errInfo.sanitizedMessage.slice(
        0,
        140
      )}`;
      res.status(200).json({
        verified: false,
        requestId,
        message: lastAiConnectivityMessage,
      });
    }
  });

  // ==========================================================================
  // Isolated Development-Only Local Auth Endpoints
  // Strictly disabled in production (NODE_ENV=production) and whenever live
  // Supabase Auth is configured. Uses per-user random-salted scrypt + timingSafeEqual.
  // ==========================================================================
  app.post('/api/auth/signup', (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'auth');
    res.setHeader('X-Request-Id', requestId);

    const devAuthCheck = isLocalDevAuthAllowed(
      process.env as Record<string, string | undefined>
    );
    if (!devAuthCheck.allowed) {
      sendStructuredError(
        res,
        503,
        'MISSING_SERVER_CONFIG',
        devAuthCheck.reason,
        'Local development authentication fallback is disabled in this environment.',
        'Authenticate directly via Supabase Auth using VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
        requestId
      );
      return;
    }

    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        'Enter a valid email address (e.g., engineer@company.com).',
        'Invalid email format on POST /api/auth/signup.',
        'Provide a valid email address.',
        requestId
      );
      return;
    }
    if (password.length < 8) {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        'Password must be at least 8 characters long.',
        'Password shorter than minimum 8-character policy.',
        'Choose a password with at least 8 characters.',
        requestId
      );
      return;
    }

    try {
      const { account, session } = localDevAuthStore.registerAccount(email, password);
      serverRlsDatabase.ensureDefaultProject(account.id);
      const projects = serverRlsDatabase.listProjects(account.id);
      const user: AuthenticatedUser = {
        id: account.id,
        email: account.email,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        authProvider: 'local-session-jwt',
      };
      res.status(201).json({
        requestId,
        user,
        projects,
      });
    } catch (err: any) {
      if (err instanceof LocalDevAuthForbiddenInProductionError) {
        sendStructuredError(
          res,
          503,
          'MISSING_SERVER_CONFIG',
          err.message,
          'Local dev auth refused in production.',
          'Configure Supabase Auth.',
          requestId
        );
        return;
      }
      const status = err?.status === 409 ? 409 : 400;
      sendStructuredError(
        res,
        status,
        'INVALID_REQUEST',
        err?.message || 'Unable to register local development account.',
        'Account registration check failed.',
        'Sign in with your existing password or use a different email address.',
        requestId
      );
    }
  });

  app.post('/api/auth/signin', (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'auth');
    res.setHeader('X-Request-Id', requestId);

    const devAuthCheck = isLocalDevAuthAllowed(
      process.env as Record<string, string | undefined>
    );
    if (!devAuthCheck.allowed) {
      sendStructuredError(
        res,
        503,
        'MISSING_SERVER_CONFIG',
        devAuthCheck.reason,
        'Local development authentication fallback is disabled in this environment.',
        'Authenticate directly via Supabase Auth using VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
        requestId
      );
      return;
    }

    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');

    try {
      const authResult = localDevAuthStore.authenticateSignIn(email, password);
      if (!authResult) {
        sendStructuredError(
          res,
          401,
          'AUTH_REQUIRED',
          'Invalid email or password.',
          'Scrypt credential verification failed or account does not exist in the local development sandbox.',
          'Verify your email and password, or select Create Account to register a local development account.',
          requestId
        );
        return;
      }

      const { account, session } = authResult;
      serverRlsDatabase.ensureDefaultProject(account.id);
      const projects = serverRlsDatabase.listProjects(account.id);
      const user: AuthenticatedUser = {
        id: account.id,
        email: account.email,
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        authProvider: 'local-session-jwt',
      };
      res.json({
        requestId,
        user,
        projects,
      });
    } catch (err: any) {
      sendStructuredError(
        res,
        503,
        'MISSING_SERVER_CONFIG',
        err?.message || 'Local development authentication is disabled.',
        'Local dev auth refused.',
        'Configure Supabase Auth.',
        requestId
      );
    }
  });

  app.post('/api/auth/signout', (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'auth');
    res.setHeader('X-Request-Id', requestId);
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
      localDevAuthStore.revokeSessionToken(token);
    }
    res.json({ ok: true, requestId });
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'auth');
    res.setHeader('X-Request-Id', requestId);

    const devAuthCheck = isLocalDevAuthAllowed(
      process.env as Record<string, string | undefined>
    );
    if (!devAuthCheck.allowed) {
      sendStructuredError(
        res,
        503,
        'MISSING_SERVER_CONFIG',
        devAuthCheck.reason,
        'Local password reset fallback is disabled in this environment.',
        'Use Supabase Auth resetPasswordForEmail with your configured Supabase project.',
        requestId
      );
      return;
    }

    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        'Enter a valid email address to request a password reset.',
        'email parameter was missing or malformed.',
        'Provide a valid email address.',
        requestId
      );
      return;
    }
    res.json({
      ok: true,
      requestId,
      message: `Development sandbox notice for ${email}: Local in-memory accounts do not send outbound emails. Connect your live Supabase project in .env.local to send real password recovery links via Supabase Auth.`,
    });
  });

  app.get('/api/auth/session', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'auth');
    res.setHeader('X-Request-Id', requestId);
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'No active session token.',
        'Missing Authorization: Bearer header on GET /api/auth/session.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const user = await verifyRequestAccessToken(token);
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Session expired or invalid. Please sign in again.',
        'Access token verification failed or local dev auth is disabled.',
        'Sign in again to obtain a valid session token.',
        requestId
      );
      return;
    }
    const projects = serverRlsDatabase.listProjects(user.id);
    res.json({ requestId, user, projects });
  });

  // ==========================================================================
  // Authenticated Projects CRUD (Enforces RLS by user.id)
  // ==========================================================================
  app.get('/api/projects', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'proj');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to list projects.',
        'Missing or invalid Bearer token on GET /api/projects.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    serverRlsDatabase.ensureDefaultProject(user.id);
    const projects = serverRlsDatabase.listProjects(user.id);
    res.setHeader('X-Request-Id', requestId);
    res.json({ requestId, projects });
  });

  app.get('/api/projects/:projectId', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'proj');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to retrieve project details.',
        'Missing or invalid Bearer token on GET /api/projects/:projectId.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const project = serverRlsDatabase.getProjectById(user.id, req.params.projectId);
    if (!project) {
      const existsForOther = serverRlsDatabase.projectExistsIgnoreRls(req.params.projectId);
      sendStructuredError(
        res,
        existsForOther ? 403 : 404,
        existsForOther ? 'FORBIDDEN_PROJECT' : 'NOT_FOUND',
        existsForOther
          ? 'Access denied: you do not own this project.'
          : 'Project not found.',
        `RLS lookup for project ${req.params.projectId} by user ${user.id} returned null.`,
        'Select a project owned by your authenticated account.',
        requestId
      );
      return;
    }
    res.setHeader('X-Request-Id', requestId);
    res.json({ requestId, project });
  });

  app.post('/api/projects', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'proj');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to create a project.',
        'Missing or invalid Bearer token on POST /api/projects.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    try {
      const candidateOwnerId =
        req.body?.ownerId !== undefined
          ? String(req.body.ownerId)
          : req.body?.owner_id !== undefined
          ? String(req.body.owner_id)
          : undefined;
      const project = serverRlsDatabase.createProject(user.id, {
        ownerId: candidateOwnerId,
        name: String(req.body?.name || '').trim(),
        repository: String(req.body?.repository || '').trim(),
        defaultBranch: String(req.body?.defaultBranch || 'main').trim(),
        retentionMode:
          req.body?.retentionMode === 'redacted_full_source'
            ? 'redacted_full_source'
            : 'redacted_snippets_only',
      });
      res.setHeader('X-Request-Id', requestId);
      res.status(201).json({ requestId, project });
    } catch (err: any) {
      const isRls = err instanceof RlsPolicyViolationError;
      sendStructuredError(
        res,
        isRls ? 403 : 400,
        isRls ? 'FORBIDDEN_PROJECT' : 'INVALID_REQUEST',
        err?.message || 'Failed to create project.',
        'Project validation or RLS check failed on POST /api/projects.',
        'Provide a non-empty project name (1–120 characters) under your own account.',
        requestId
      );
    }
  });

  const handleUpdateProject = async (req: express.Request, res: express.Response) => {
    const requestId = getOrGenerateRequestId(req, 'proj');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to update project.',
        'Missing or invalid Bearer token.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    if (
      !serverRlsDatabase.getProjectById(user.id, req.params.projectId) &&
      !serverRlsDatabase.projectExistsIgnoreRls(req.params.projectId)
    ) {
      sendStructuredError(
        res,
        404,
        'NOT_FOUND',
        'Project not found.',
        `Project ${req.params.projectId} does not exist.`,
        'Verify the project ID and try again.',
        requestId
      );
      return;
    }
    try {
      const retentionMode: SourceRetentionMode | undefined =
        req.body?.retentionMode !== undefined
          ? req.body.retentionMode === 'redacted_full_source'
            ? 'redacted_full_source'
            : 'redacted_snippets_only'
          : undefined;
      const candidateOwnerId =
        req.body?.ownerId !== undefined
          ? String(req.body.ownerId)
          : req.body?.owner_id !== undefined
          ? String(req.body.owner_id)
          : undefined;
      const project = serverRlsDatabase.updateProject(user.id, req.params.projectId, {
        ownerId: candidateOwnerId,
        name: req.body?.name !== undefined ? String(req.body.name) : undefined,
        repository:
          req.body?.repository !== undefined ? String(req.body.repository) : undefined,
        defaultBranch:
          req.body?.defaultBranch !== undefined ? String(req.body.defaultBranch) : undefined,
        retentionMode,
      });
      res.setHeader('X-Request-Id', requestId);
      res.json({ requestId, project });
    } catch (err: any) {
      const isRls = err instanceof RlsPolicyViolationError;
      sendStructuredError(
        res,
        isRls ? 403 : 400,
        isRls ? 'FORBIDDEN_PROJECT' : 'INVALID_REQUEST',
        err?.message || 'Failed to update project.',
        'Project update rejected by validation or RLS policy.',
        'Ensure you own the target project and provide valid metadata.',
        requestId
      );
    }
  };

  app.patch('/api/projects/:projectId', handleUpdateProject);
  app.patch('/api/projects/:projectId/retention', handleUpdateProject);

  app.delete('/api/projects/:projectId', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'proj');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to delete project.',
        'Missing or invalid Bearer token on DELETE /api/projects/:projectId.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    try {
      const deleted = serverRlsDatabase.deleteProject(user.id, req.params.projectId);
      if (!deleted) {
        sendStructuredError(
          res,
          404,
          'NOT_FOUND',
          'Project not found.',
          `Project ${req.params.projectId} does not exist.`,
          'Verify the project ID and try again.',
          requestId
        );
        return;
      }
      const projects = serverRlsDatabase.listProjects(user.id);
      res.setHeader('X-Request-Id', requestId);
      res.json({ ok: true, requestId, projects });
    } catch (err: any) {
      const isRls = err instanceof RlsPolicyViolationError;
      sendStructuredError(
        res,
        isRls ? 403 : 400,
        isRls ? 'FORBIDDEN_PROJECT' : 'INVALID_REQUEST',
        err?.message || 'Failed to delete project.',
        'RLS policy rejected project deletion.',
        'You can only delete projects owned by your authenticated account.',
        requestId
      );
    }
  });

  // ==========================================================================
  // Authenticated Reviews & Findings CRUD (Enforces RLS by user.id)
  // ==========================================================================
  app.get('/api/reviews', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'rev');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to load review history.',
        'Missing or invalid Bearer token on GET /api/reviews.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : undefined;
    if (
      projectId &&
      !serverRlsDatabase.getProjectById(user.id, projectId) &&
      serverRlsDatabase.projectExistsIgnoreRls(projectId)
    ) {
      sendStructuredError(
        res,
        403,
        'FORBIDDEN_PROJECT',
        'Access denied: you do not have permission to list reviews for another user project.',
        `RLS ownership check rejected projectId=${projectId} for user ${user.id}.`,
        'Filter by a project owned by your authenticated account.',
        requestId
      );
      return;
    }
    const reviews = serverRlsDatabase.listReviews(user.id, projectId);
    res.setHeader('X-Request-Id', requestId);
    res.json({ requestId, reviews });
  });

  app.get('/api/reviews/:reviewId', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'rev');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to retrieve review.',
        'Missing or invalid Bearer token on GET /api/reviews/:reviewId.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const review = serverRlsDatabase.getReviewById(user.id, req.params.reviewId);
    if (!review) {
      const ownedByOther = serverRlsDatabase.reviewExistsIgnoreRls(req.params.reviewId);
      sendStructuredError(
        res,
        ownedByOther ? 403 : 404,
        ownedByOther ? 'FORBIDDEN_PROJECT' : 'NOT_FOUND',
        ownedByOther ? 'Access denied: you do not own this review.' : 'Review not found.',
        `No review ${req.params.reviewId} visible to user ${user.id} under RLS.`,
        'Verify the review ID belongs to your account.',
        requestId
      );
      return;
    }
    res.setHeader('X-Request-Id', requestId);
    res.json({ requestId, review });
  });

  app.get('/api/reviews/:reviewId/status', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'rev');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to retrieve review status.',
        'Missing or invalid Bearer token on GET /api/reviews/:reviewId/status.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const review = serverRlsDatabase.getReviewById(user.id, req.params.reviewId);
    if (!review) {
      const ownedByOther = serverRlsDatabase.reviewExistsIgnoreRls(req.params.reviewId);
      sendStructuredError(
        res,
        ownedByOther ? 403 : 404,
        ownedByOther ? 'FORBIDDEN_PROJECT' : 'NOT_FOUND',
        ownedByOther ? 'Access denied: you do not own this review.' : 'Review not found.',
        `No review ${req.params.reviewId} visible to user ${user.id} under RLS.`,
        'Verify the review ID belongs to your account.',
        requestId
      );
      return;
    }
    res.setHeader('X-Request-Id', requestId);
    res.json({
      requestId,
      reviewId: review.id,
      projectId: review.projectId,
      status: review.status,
      startedAt: review.startedAt || review.createdAt,
      completedAt: review.completedAt || null,
      durationMs: review.durationMs,
      findingsCount: review.findings.length,
      stages: review.stages,
      warningMessage: review.warningMessage || null,
    });
  });

  app.get('/api/reviews/:reviewId/findings', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'rev');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to retrieve findings.',
        'Missing or invalid Bearer token on GET /api/reviews/:reviewId/findings.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const findings = serverRlsDatabase.getFindingsByReviewId(user.id, req.params.reviewId);
    if (!findings) {
      const ownedByOther = serverRlsDatabase.reviewExistsIgnoreRls(req.params.reviewId);
      sendStructuredError(
        res,
        ownedByOther ? 403 : 404,
        ownedByOther ? 'FORBIDDEN_PROJECT' : 'NOT_FOUND',
        ownedByOther ? 'Access denied: you do not own this review.' : 'Review not found.',
        `No findings found for review ${req.params.reviewId} under user ${user.id}.`,
        'Verify the review ID belongs to your account.',
        requestId
      );
      return;
    }
    res.setHeader('X-Request-Id', requestId);
    res.json({ requestId, reviewId: req.params.reviewId, findings });
  });

  app.post('/api/reviews/:reviewId/retry', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'retry');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to retry a review.',
        'Missing or invalid Bearer token on POST /api/reviews/:reviewId/retry.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }

    const existing = serverRlsDatabase.getReviewById(user.id, req.params.reviewId);
    if (!existing) {
      const ownedByOther = serverRlsDatabase.reviewExistsIgnoreRls(req.params.reviewId);
      sendStructuredError(
        res,
        ownedByOther ? 403 : 404,
        ownedByOther ? 'FORBIDDEN_PROJECT' : 'NOT_FOUND',
        ownedByOther ? 'Access denied: you do not own this review.' : 'Review not found.',
        `Review ${req.params.reviewId} is not accessible to user ${user.id}.`,
        'Select an existing review owned by your account.',
        requestId
      );
      return;
    }

    // Explicit safe retry rule: only allow retrying failed or completed_with_warnings reviews
    // when non-empty source files are available.
    if (existing.status !== 'failed' && existing.status !== 'completed_with_warnings') {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        `Review "${existing.title}" has status "${existing.status}" and does not require a retry.`,
        'Only failed or partially degraded (completed_with_warnings) reviews can be retried via this endpoint.',
        'Start a new review from the New Review workspace if you wish to re-analyze modified code.',
        requestId
      );
      return;
    }

    const retryPayload: ReviewRequestPayload = {
      projectId: existing.projectId,
      retentionMode: existing.retentionPolicy?.mode,
      title: existing.title,
      objective: existing.objective,
      focusAreas: existing.focusAreas,
      files: existing.files.map((f) => ({
        id: f.id,
        filename: f.filename,
        language: f.language,
        content: f.content,
        changeStatus: f.changeStatus,
      })),
      analysisMode: req.body?.analysisMode || 'hybrid',
    };

    const ai = getAiClient();
    const outcome = await executeAuthenticatedReviewFlow(retryPayload, {
      requestId,
      authorizationHeader: req.headers.authorization,
      verifyAccessTokenFn: verifyRequestAccessToken,
      database: serverRlsDatabase,
      rateLimiter: reviewRateLimiter,
      deduplicator: reviewDeduplicator,
      invokeAiModel: ai ? (prompt) => invokeGeminiReviewModel(ai, prompt) : null,
      onAiConnectivityUpdate: (state, message) => {
        lastAiConnectivityState = state;
        lastAiConnectivityMessage = message;
      },
    });

    res.setHeader('X-Request-Id', requestId);
    if (!outcome.ok) {
      res.status(outcome.httpStatus).json({
        error: outcome.error,
        requestId: outcome.requestId,
        failedReview: outcome.failedReview,
      });
      return;
    }

    res.json({
      review: outcome.review,
      project: outcome.project,
      requestId: outcome.requestId,
    });
  });

  app.patch('/api/reviews/:reviewId/findings/:findingId', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'fnd');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to update finding status.',
        'Missing or invalid Bearer token.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    const status = req.body?.status as FindingStatus;
    if (!['unreviewed', 'reviewed', 'dismissed', 'reopened'].includes(status)) {
      sendStructuredError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid finding workflow status.',
        `Status "${String(status)}" is not one of unreviewed, reviewed, dismissed, reopened.`,
        'Provide a valid FindingStatus value.',
        requestId
      );
      return;
    }
    try {
      const updated = serverRlsDatabase.updateFindingStatus(
        user.id,
        req.params.reviewId,
        req.params.findingId,
        status
      );
      if (!updated) {
        sendStructuredError(
          res,
          404,
          'NOT_FOUND',
          'Review or finding not found.',
          `Could not locate finding ${req.params.findingId} on review ${req.params.reviewId}.`,
          'Verify the review and finding IDs.',
          requestId
        );
        return;
      }
      res.setHeader('X-Request-Id', requestId);
      res.json({ requestId, review: updated });
    } catch (err: any) {
      const isRls = err instanceof RlsPolicyViolationError;
      sendStructuredError(
        res,
        isRls ? 403 : 400,
        isRls ? 'FORBIDDEN_PROJECT' : 'INVALID_REQUEST',
        err?.message || 'Failed to update finding status.',
        'RLS ownership check failed on finding update.',
        'You can only update findings belonging to your own reviews.',
        requestId
      );
    }
  });

  app.delete('/api/reviews/:reviewId', async (req, res) => {
    const requestId = getOrGenerateRequestId(req, 'rev');
    const token = extractBearerToken(req.headers.authorization);
    const user = token ? await verifyRequestAccessToken(token) : null;
    if (!user) {
      sendStructuredError(
        res,
        401,
        'AUTH_REQUIRED',
        'Authentication required to delete review.',
        'Missing or invalid Bearer token on DELETE /api/reviews/:reviewId.',
        'Sign in with a valid account session.',
        requestId
      );
      return;
    }
    try {
      const deleted = serverRlsDatabase.deleteReview(user.id, req.params.reviewId);
      if (!deleted) {
        sendStructuredError(
          res,
          404,
          'NOT_FOUND',
          'Review not found.',
          `Review ${req.params.reviewId} was not found.`,
          'Verify the review ID and try again.',
          requestId
        );
        return;
      }
      const reviews = serverRlsDatabase.listReviews(user.id);
      res.setHeader('X-Request-Id', requestId);
      res.json({ ok: true, requestId, reviews });
    } catch (err: any) {
      const isRls = err instanceof RlsPolicyViolationError;
      sendStructuredError(
        res,
        isRls ? 403 : 400,
        isRls ? 'FORBIDDEN_PROJECT' : 'INVALID_REQUEST',
        err?.message || 'Failed to delete review.',
        'RLS policy rejected review deletion.',
        'You can only delete reviews owned by your authenticated account.',
        requestId
      );
    }
  });

  // ==========================================================================
  // Authenticated Server-Side Review Execution (/api/review & Edge Function routes)
  // ==========================================================================
  const handleReviewEndpoint = async (req: express.Request, res: express.Response) => {
    const requestId = getOrGenerateRequestId(req, 'req');
    res.setHeader('X-Request-Id', requestId);
    const ai = getAiClient();
    const rawByteLength = (req as any).rawByteLength as number | undefined;

    const outcome = await executeAuthenticatedReviewFlow(req.body, {
      requestId,
      authorizationHeader: req.headers.authorization,
      rawByteLength,
      verifyAccessTokenFn: verifyRequestAccessToken,
      database: serverRlsDatabase,
      rateLimiter: reviewRateLimiter,
      deduplicator: reviewDeduplicator,
      invokeAiModel: ai ? (prompt) => invokeGeminiReviewModel(ai, prompt) : null,
      onAiConnectivityUpdate: (state, message) => {
        lastAiConnectivityState = state;
        lastAiConnectivityMessage = message;
      },
    });

    if (!outcome.ok) {
      res.status(outcome.httpStatus).json({
        error: outcome.error,
        requestId: outcome.requestId,
        failedReview: outcome.failedReview,
      });
      return;
    }

    res.json({
      review: outcome.review,
      project: outcome.project,
      requestId: outcome.requestId,
    });
  };

  app.post('/api/review', handleReviewEndpoint);
  app.post('/functions/v1/analyze-review', handleReviewEndpoint);
  app.post('/functions/v1/review-code', handleReviewEndpoint);

  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PatchGuard AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

