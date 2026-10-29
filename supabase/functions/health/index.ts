import {
  AI_MODEL_ID,
  isConfiguredGeminiApiKey,
} from '../../../src/lib/reviewOrchestrator.ts';
import { STATIC_ANALYZER_VERSION } from '../../../src/lib/staticAnalyzer.ts';
import {
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
} from '../../../src/lib/supabaseBackendCore.ts';

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Request-Id',
    Vary: 'Origin',
  };
  if (requestId) {
    headers['X-Request-Id'] = requestId;
  }
  return headers;
}

export async function handleHealthEdgeRequest(req: Request): Promise<Response> {
  const requestId =
    req.headers.get('x-request-id') ||
    `edge-health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: buildCorsHeaders(req, requestId) });
  }

  const supabaseUrl = readServerEnv('SUPABASE_URL');
  const supabaseAnonKey = readServerEnv('SUPABASE_ANON_KEY');
  const geminiKey = readServerEnv('GEMINI_API_KEY');

  const supabaseConfigured =
    isConfiguredSupabaseUrl(supabaseUrl) && isConfiguredSupabaseAnonKey(supabaseAnonKey);
  const aiConfigured = isConfiguredGeminiApiKey(geminiKey);

  return new Response(
    JSON.stringify({
      status: 'ok',
      requestId,
      timestamp: new Date().toISOString(),
      aiProviderConfigured: aiConfigured,
      aiModelId: AI_MODEL_ID,
      staticEngineAvailable: true,
      staticEngineVersion: STATIC_ANALYZER_VERSION,
      supabaseConfigured,
      supabaseMode: supabaseConfigured ? 'live-supabase' : 'local-rls-mirror',
    }),
    {
      status: 200,
      headers: {
        ...buildCorsHeaders(req, requestId),
        'Content-Type': 'application/json',
      },
    }
  );
}

if (typeof Deno !== 'undefined' && typeof Deno?.serve === 'function') {
  Deno.serve(handleHealthEdgeRequest);
}

