import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AnalysisStageReport,
  ApiErrorCategory,
  FindingCategory,
  ReviewFinding,
  ReviewRecord,
  ReviewRequestPayload,
  SeverityLevel,
  SourceFileRecord,
  StructuredApiError,
} from './src/types/patchguard';
import {
  mergeAndCorroborateFindings,
  runStaticAnalysisOnFiles,
  STATIC_ANALYZER_VERSION,
  validateAndNormalizeFindingLocation,
} from './src/lib/staticAnalyzer';

dotenv.config();

const PORT = 3000;
const AI_MODEL_ID = 'gemini-3.8-flash';

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

function buildSimulatedError(
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
          retryable: true,
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
        },
      };
  }
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

    try {
      const response = await ai.models.generateContent({
        model: AI_MODEL_ID,
        contents: 'Respond with the single word READY.',
      });
      const text = (response.text || '').trim();
      lastAiConnectivityState = 'verified';
      lastAiConnectivityMessage = `Live connectivity to ${AI_MODEL_ID} verified (${text.slice(0, 24) || 'OK'}).`;
      res.json({
        verified: true,
        requestId,
        message: lastAiConnectivityMessage,
      });
    } catch (err: any) {
      lastAiConnectivityState = 'failed';
      const sanitizedMsg = (err?.message || 'Model connectivity check failed').replace(
        /AIza[0-9A-Za-z-_]{35}/g,
        '[REDACTED]'
      );
      lastAiConnectivityMessage = `Live probe to ${AI_MODEL_ID} failed: ${sanitizedMsg.slice(0, 140)}`;
      res.status(200).json({
        verified: false,
        requestId,
        message: lastAiConnectivityMessage,
      });
    }
  });

  app.post('/api/review', async (req, res) => {
    const requestStart = Date.now();
    const requestId =
      (req.headers['x-request-id'] as string) ||
      `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = req.body as ReviewRequestPayload;

    if (payload?.simulateFailureMode) {
      const sim = buildSimulatedError(payload.simulateFailureMode, requestId);
      res.status(sim.status).json({ error: sim.error, requestId });
      return;
    }

    if (
      !payload ||
      !Array.isArray(payload.files) ||
      payload.files.length === 0 ||
      payload.files.some((f) => !f.content || !f.content.trim() || !f.filename || !f.filename.trim())
    ) {
      const errResp = buildSimulatedError('INVALID_REQUEST', requestId);
      res.status(errResp.status).json({ error: errResp.error, requestId });
      return;
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
      };
    });

    const analysisMode = payload.analysisMode || 'hybrid';
    const stages: AnalysisStageReport[] = [];
    let staticFindings: ReviewFinding[] = [];
    let aiFindings: ReviewFinding[] = [];
    let warningMessage: string | undefined;

    // Stage 1: Deterministic Static Analysis
    if (analysisMode === 'hybrid' || analysisMode === 'static-only') {
      const stgStart = Date.now();
      staticFindings = runStaticAnalysisOnFiles(normalizedFiles, payload.focusAreas);
      stages.push({
        stageId: 'stage-static',
        name: 'Deterministic Pattern & Structural Analysis',
        engine: STATIC_ANALYZER_VERSION,
        status: 'succeeded',
        durationMs: Math.max(4, Date.now() - stgStart),
        findingsProduced: staticFindings.length,
      });
    } else {
      stages.push({
        stageId: 'stage-static',
        name: 'Deterministic Pattern & Structural Analysis',
        engine: STATIC_ANALYZER_VERSION,
        status: 'skipped',
        durationMs: 0,
        findingsProduced: 0,
      });
    }

    // Stage 2: Gemini AI Semantic Analysis
    if (analysisMode === 'hybrid' || analysisMode === 'ai-only') {
      const aiStart = Date.now();
      const ai = getAiClient();

      if (!ai) {
        if (analysisMode === 'ai-only') {
          const errResp = buildSimulatedError('MISSING_SERVER_CONFIG', requestId);
          res.status(errResp.status).json({ error: errResp.error, requestId });
          return;
        }
        stages.push({
          stageId: 'stage-ai',
          name: 'Gemini Semantic Code Reasoning',
          engine: AI_MODEL_ID,
          status: 'warning',
          durationMs: 0,
          findingsProduced: 0,
          errorCode: 'MISSING_SERVER_CONFIG',
          errorMessage:
            'GEMINI_API_KEY is not configured on the server; semantic AI stage was skipped and review completed with deterministic static analysis.',
        });
        warningMessage =
          'AI semantic stage skipped (GEMINI_API_KEY not configured on server). Showing verified findings from PatchGuard Static Analyzer.';
      } else {
        try {
          const numberedFilesPrompt = normalizedFiles
            .map((file) => {
              const numberedLines = file.content
                .split('\n')
                .map((line, i) => `${i + 1}: ${line}`)
                .join('\n');
              return `=== FILE: ${file.filename} (Language: ${file.language}, Total Lines: ${file.lineCount}) ===\n${numberedLines}`;
            })
            .join('\n\n');

          const prompt = `You are PatchGuard AI, a principal-level software defect and security investigation engine.
Analyze the following source files for concrete defects, security risks, concurrency hazards, boundary bugs, error-handling flaws, and performance bottlenecks.

Review Title: ${payload.title || 'Untitled Code Review'}
Review Objective: ${payload.objective || 'General defect and security investigation'}
Focus Categories: ${(payload.focusAreas || []).join(', ') || 'all categories'}

Strict Rules:
1. Only report substantive, evidence-backed technical findings grounded in specific line numbers from the provided source code.
2. Do NOT invent hypothetical issues for lines that do not exist.
3. For each finding, provide exact 1-indexed startLine and endLine matching the numbered source lines.

Source Files:
${numberedFilesPrompt}`;

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

          const rawText = (response.text || '[]').trim();
          const parsedItems = JSON.parse(rawText);
          if (!Array.isArray(parsedItems)) {
            throw new Error('Model response root is not a JSON array.');
          }

          const now = new Date().toISOString();
          let invalidLineCount = 0;

          aiFindings = parsedItems.map((item: any, idx: number): ReviewFinding => {
            const matchedFile =
              normalizedFiles.find((f) => f.filename === item.filename) || normalizedFiles[0];
            const loc = validateAndNormalizeFindingLocation(
              matchedFile,
              Number(item.startLine),
              Number(item.endLine)
            );
            if (!loc.isValidLocation) {
              invalidLineCount++;
            }

            const validSeverities: SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info'];
            const sev: SeverityLevel = validSeverities.includes(item.severity)
              ? item.severity
              : 'medium';

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
            const cat: FindingCategory = validCategories.includes(item.category)
              ? item.category
              : 'correctness';

            return {
              id: `fnd-ai-${Date.now().toString(36)}-${idx}`,
              title: String(item.title || 'Unnamed finding'),
              severity: sev,
              category: cat,
              status: 'unreviewed',
              analysisSource: 'ai-gemini',
              confidence: ['high', 'medium', 'low'].includes(item.confidence)
                ? item.confidence
                : 'medium',
              uncertaintyNote:
                item.uncertaintyNote ||
                'Generated by Gemini 3.8 Flash semantic reasoning; verify call-site invariants before applying remediation.',
              location: loc,
              explanation: String(item.explanation || ''),
              potentialImpact: String(item.potentialImpact || ''),
              suggestedRemediation: String(item.suggestedRemediation || ''),
              remediationCode: item.remediationCode ? String(item.remediationCode) : undefined,
              createdAt: now,
              updatedAt: now,
            };
          });

          lastAiConnectivityState = 'verified';
          lastAiConnectivityMessage = `Latest review request succeeded via ${AI_MODEL_ID}.`;

          stages.push({
            stageId: 'stage-ai',
            name: 'Gemini Semantic Code Reasoning',
            engine: AI_MODEL_ID,
            status: invalidLineCount > 0 ? 'warning' : 'succeeded',
            durationMs: Math.max(10, Date.now() - aiStart),
            findingsProduced: aiFindings.length,
            errorMessage:
              invalidLineCount > 0
                ? `${invalidLineCount} finding(s) cited line numbers outside file bounds and were flagged by the location verifier.`
                : undefined,
          });

          if (invalidLineCount > 0) {
            warningMessage = `${invalidLineCount} AI finding(s) referenced out-of-bounds line numbers and were marked with unavailable source locations.`;
          }
        } catch (err: any) {
          lastAiConnectivityState = 'failed';
          const cleanErr = (err?.message || 'AI model execution failed').replace(
            /AIza[0-9A-Za-z-_]{35}/g,
            '[REDACTED]'
          );
          lastAiConnectivityMessage = `AI stage error: ${cleanErr.slice(0, 120)}`;

          if (analysisMode === 'ai-only') {
            res.status(502).json({
              requestId,
              error: {
                category: 'INCOMPLETE_ANALYSIS',
                message: 'AI semantic analysis stage failed during AI-only review.',
                technicalDetail: cleanErr.slice(0, 220),
                remediationStep:
                  'Switch to Hybrid mode so deterministic static analysis can run, or verify AI provider quota/connectivity in Diagnostics.',
                requestId,
                timestamp: new Date().toISOString(),
                retryable: true,
              },
            });
            return;
          }

          stages.push({
            stageId: 'stage-ai',
            name: 'Gemini Semantic Code Reasoning',
            engine: AI_MODEL_ID,
            status: 'failed',
            durationMs: Math.max(10, Date.now() - aiStart),
            findingsProduced: 0,
            errorCode: 'AI_STAGE_FAILED',
            errorMessage: `AI model stage failed (${cleanErr.slice(0, 120)}); falling back to verified Static Analyzer findings.`,
          });
          warningMessage = `AI semantic stage encountered an error (${cleanErr.slice(0, 90)}). Review completed with warnings using deterministic static analysis.`;
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
      });
    }

    const mergedFindings = mergeAndCorroborateFindings(staticFindings, aiFindings);
    const hasStageWarningOrFailure = stages.some(
      (s) => s.status === 'warning' || s.status === 'failed'
    );

    const reviewRecord: ReviewRecord = {
      id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: payload.title?.trim() || `Review of ${normalizedFiles[0].filename}`,
      createdAt: new Date().toISOString(),
      durationMs: Math.max(8, Date.now() - requestStart),
      status: hasStageWarningOrFailure ? 'completed_with_warnings' : 'completed',
      objective:
        payload.objective?.trim() ||
        'Investigate code changes for security, concurrency, boundary, and error-handling risks.',
      focusAreas: payload.focusAreas || [],
      files: normalizedFiles,
      findings: mergedFindings,
      stages,
      requestId,
      modelUsed:
        analysisMode === 'static-only'
          ? STATIC_ANALYZER_VERSION
          : `${AI_MODEL_ID} + ${STATIC_ANALYZER_VERSION}`,
      warningMessage,
    };

    res.json({ review: reviewRecord, requestId });
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
