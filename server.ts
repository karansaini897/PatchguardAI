import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { ReviewRequestPayload } from './src/types/patchguard';
import { STATIC_ANALYZER_VERSION } from './src/lib/staticAnalyzer';
import {
  AI_MODEL_ID,
  callAiWithRetry,
  executeReviewPipeline,
} from './src/lib/reviewOrchestrator';

dotenv.config();

const PORT = 3000;

let lastAiConnectivityState: 'unverified' | 'verified' | 'failed' = 'unverified';
let lastAiConnectivityMessage = '';

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
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
              description: 'critical, high, medium, low, or info',
            },
            category: {
              type: Type.STRING,
              description:
                'security, concurrency, boundary, error-handling, performance, correctness, data-integrity, or maintainability',
            },
            filename: { type: Type.STRING },
            startLine: { type: Type.INTEGER },
            endLine: { type: Type.INTEGER },
            confidence: {
              type: Type.STRING,
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
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    const aiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    res.json({
      status: 'ok',
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
    });
  });

  app.post('/api/health/probe-ai', async (req, res) => {
    const requestId =
      (req.headers['x-request-id'] as string) || `probe-${Date.now().toString(36)}`;
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
      lastAiConnectivityMessage = `Live connectivity to ${AI_MODEL_ID} verified${retryNote} (${text.slice(0, 24) || 'OK'}).`;
      res.json({
        verified: true,
        requestId,
        message: lastAiConnectivityMessage,
      });
    } else {
      const errInfo = probeResult.error!;
      lastAiConnectivityState = 'failed';
      lastAiConnectivityMessage = `Live probe to ${AI_MODEL_ID} failed (${errInfo.errorCode} after ${probeResult.attemptsMade} attempt(s)): ${errInfo.sanitizedMessage.slice(0, 140)}`;
      res.status(200).json({
        verified: false,
        requestId,
        message: lastAiConnectivityMessage,
      });
    }
  });

  app.post('/api/review', async (req, res) => {
    const requestId =
      (req.headers['x-request-id'] as string) ||
      `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = req.body as ReviewRequestPayload;
    const ai = getAiClient();

    const outcome = await executeReviewPipeline(payload, {
      requestId,
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
      });
      return;
    }

    res.json({
      review: outcome.review,
      requestId: outcome.requestId,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
