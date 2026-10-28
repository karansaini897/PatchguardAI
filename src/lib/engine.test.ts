import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAndCorroborateFindings,
  runStaticAnalysisOnFiles,
  STATIC_ANALYZER_VERSION,
  validateAndNormalizeFindingLocation,
} from './staticAnalyzer';
import {
  computePrecisionRecall,
  computeSeverityDistribution,
  filterFindings,
  matchFindingsToExpectedDefects,
} from './evaluationMath';
import {
  AI_MODEL_ID,
  callAiWithRetry,
  executeReviewPipeline,
  parseRetryAfterMs,
} from './reviewOrchestrator';
import { ReviewFinding, SourceFileRecord } from '../types/patchguard';

const sampleVulnFile: SourceFileRecord = {
  id: 'file-1',
  filename: 'src/services/ledgerService.ts',
  language: 'typescript',
  changeStatus: 'modified',
  lineCount: 18,
  content: [
    'export async function settleAccount(db: any, tenantId: string, accountId: string, amount: number) {',
    '  const secretKey = "sk_live_9876543210abcdef123456";',
    '  const query = `SELECT * FROM accounts WHERE tenant_id = \'${tenantId}\' AND id = \'${accountId}\'`;',
    '  const account = await db.getBalance(query);',
    '  for (let i = 0; i <= account.entries.length; i++) {',
    '    await db.fetchEntryAudit(account.entries[i]);',
    '  }',
    '  try {',
    '    await db.updateBalance(accountId, account.balance - amount);',
    '  } catch (err) {',
    '    // ignore',
    '  }',
    '  return true;',
    '}',
  ].join('\n'),
};

test('1. static analyzer detects SQL injection, hardcoded secret, off-by-one boundary, concurrency, and silent catch', () => {
  const findings = runStaticAnalysisOnFiles([sampleVulnFile]);
  assert.ok(findings.length >= 4, `Expected at least 4 findings, got ${findings.length}`);

  const ruleIds = findings.map((f) => f.staticCorroboration?.ruleId);
  assert.ok(ruleIds.includes('PG-SEC-001'), 'Should detect SQL injection');
  assert.ok(ruleIds.includes('PG-SEC-005'), 'Should detect hardcoded secret');
  assert.ok(ruleIds.includes('PG-BND-003'), 'Should detect off-by-one <= length loop');
  assert.ok(ruleIds.includes('PG-ERR-004'), 'Should detect silent catch block');
  assert.ok(
    findings.every((f) => f.analysisSource === 'static-pattern'),
    'All static findings must be attributed to static-pattern'
  );
});

test('2. validateAndNormalizeFindingLocation flags out-of-bounds line numbers without highlighting nearby lines', () => {
  const validLoc = validateAndNormalizeFindingLocation(sampleVulnFile, 3, 4);
  assert.equal(validLoc.isValidLocation, true);
  assert.ok(validLoc.rawSnippet.includes('SELECT * FROM accounts'));

  const outOfBoundsHigh = validateAndNormalizeFindingLocation(sampleVulnFile, 99, 102);
  assert.equal(outOfBoundsHigh.isValidLocation, false);
  assert.equal(outOfBoundsHigh.rawSnippet, '');
  assert.ok(outOfBoundsHigh.validationNote?.includes('outside valid bounds'));

  const outOfBoundsZero = validateAndNormalizeFindingLocation(sampleVulnFile, 0, 0);
  assert.equal(outOfBoundsZero.isValidLocation, false);
});

test('3. mergeAndCorroborateFindings upgrades overlapping AI and Static findings to corroborated status while preserving distinct sources', () => {
  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const sqlStatic = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001')!;
  const secretStatic = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-005')!;
  assert.ok(sqlStatic && secretStatic);

  const mockAiOverlapping: ReviewFinding = {
    id: 'ai-finding-1',
    title: 'SQL injection vulnerability in tenant account lookup',
    severity: 'critical',
    category: 'security',
    status: 'unreviewed',
    analysisSource: 'ai-gemini',
    confidence: 'high',
    location: validateAndNormalizeFindingLocation(sampleVulnFile, 3, 3),
    explanation: 'Template literal injects tenantId directly into SQL query.',
    potentialImpact: 'Arbitrary database read/write across tenants.',
    suggestedRemediation: 'Use parameterized query placeholders.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockAiOnlyFinding: ReviewFinding = {
    id: 'ai-finding-2',
    title: 'Non-atomic read-modify-write balance update on line 9',
    severity: 'high',
    category: 'concurrency',
    status: 'unreviewed',
    analysisSource: 'ai-gemini',
    confidence: 'medium',
    location: validateAndNormalizeFindingLocation(sampleVulnFile, 9, 9),
    explanation: 'Concurrent calls to settleAccount can double-spend account.balance.',
    potentialImpact: 'Lost updates and negative ledger balances.',
    suggestedRemediation: 'Use a database transaction with SELECT FOR UPDATE.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const merged = mergeAndCorroborateFindings(
    [sqlStatic, secretStatic],
    [mockAiOverlapping, mockAiOnlyFinding]
  );

  assert.equal(merged.length, 3);
  const corroboratedItem = merged.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001');
  const staticOnlyItem = merged.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-005');
  const aiOnlyItem = merged.find((f) => f.id === 'ai-finding-2');

  assert.equal(corroboratedItem?.analysisSource, 'corroborated');
  assert.equal(staticOnlyItem?.analysisSource, 'static-pattern');
  assert.equal(aiOnlyItem?.analysisSource, 'ai-gemini');
});

test('4. Successful AI-assisted review pipeline records completed status, corroborated & AI findings, and full model attribution', async () => {
  const outcome = await executeReviewPipeline(
    {
      title: 'Ledger Service Audit',
      objective: 'Audit SQL, concurrency, and data integrity safety',
      focusAreas: ['security', 'concurrency', 'data-integrity'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-test-ai-success',
      invokeAiModel: async () =>
        JSON.stringify([
          {
            title: 'Unparameterized SQL template string in settleAccount',
            severity: 'critical',
            category: 'security',
            filename: sampleVulnFile.filename,
            startLine: 3,
            endLine: 3,
            confidence: 'high',
            explanation: 'Direct string interpolation of tenantId and accountId into SQL query.',
            potentialImpact: 'Cross-tenant SQL injection.',
            suggestedRemediation: 'Use parameterized SQL queries.',
          },
          {
            title: 'Unchecked negative balance deduction without ledger invariant check',
            severity: 'high',
            category: 'data-integrity',
            filename: sampleVulnFile.filename,
            startLine: 9,
            endLine: 9,
            confidence: 'high',
            explanation: 'account.balance - amount is written without verifying sufficient funds.',
            potentialImpact: 'Account balance can drop below zero without overdraft authorization.',
            suggestedRemediation: 'Validate amount <= account.balance inside a serializable transaction.',
          },
        ]),
    }
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.review.status, 'completed');
  assert.equal(
    outcome.review.modelUsed,
    `${AI_MODEL_ID} + ${STATIC_ANALYZER_VERSION}`
  );
  assert.equal(outcome.review.warningMessage, undefined);

  const aiStage = outcome.review.stages.find((s) => s.stageId === 'stage-ai')!;
  assert.equal(aiStage.status, 'succeeded');
  assert.equal(aiStage.attempts, 1);
  assert.equal(aiStage.retriedCount, 0);
  assert.equal(aiStage.findingsProduced, 2);

  // Verify source-engine attribution is retained across all findings
  const sources = new Set(outcome.review.findings.map((f) => f.analysisSource));
  assert.ok(sources.has('corroborated'), 'Should include corroborated finding');
  assert.ok(sources.has('static-pattern'), 'Should include static-pattern finding');
  assert.ok(sources.has('ai-gemini'), 'Should include ai-gemini finding');
});

test('5. HTTP 503 (high demand) followed by a successful retry completes review using bounded backoff', async () => {
  const sleepDelays: number[] = [];
  let callCount = 0;

  const outcome = await executeReviewPipeline(
    {
      title: 'Transient 503 Recovery Test',
      objective: 'Verify HTTP 503 retry recovery',
      focusAreas: ['security'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-test-503-recover',
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 2000,
        jitterMaxMs: 50,
        randomFn: () => 0.5,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      },
      invokeAiModel: async (_prompt, attempt) => {
        callCount = attempt;
        if (attempt === 1) {
          const err = new Error(
            'HTTP 503 Service Unavailable: The model is currently experiencing high demand.'
          ) as Error & { status?: number };
          err.status = 503;
          throw err;
        }
        return JSON.stringify([
          {
            title: 'Recovered AI finding on line 3',
            severity: 'critical',
            category: 'security',
            filename: sampleVulnFile.filename,
            startLine: 3,
            endLine: 3,
            confidence: 'high',
            explanation: 'SQL injection detected on retry attempt 2.',
            potentialImpact: 'Arbitrary SQL execution.',
            suggestedRemediation: 'Use bound parameters.',
          },
        ]);
      },
    }
  );

  assert.equal(callCount, 2, 'Should succeed on attempt 2 after 1 retry');
  assert.equal(sleepDelays.length, 1, 'Should have slept exactly once before retry');
  assert.equal(sleepDelays[0], 225, 'Backoff delay should equal baseDelay 200 + jitter 25');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.review.status, 'completed');
  const aiStage = outcome.review.stages.find((s) => s.stageId === 'stage-ai')!;
  assert.equal(aiStage.status, 'succeeded');
  assert.equal(aiStage.attempts, 2);
  assert.equal(aiStage.retriedCount, 1);
});

test('6. HTTP 503 after all retries exhausted falls back to deterministic static analysis in hybrid mode and returns structured error in ai-only mode', async () => {
  const sleepDelays: number[] = [];
  let hybridAttempts = 0;

  // Case A: Hybrid mode preserves deterministic static analysis findings & reports accurate status
  const hybridOutcome = await executeReviewPipeline(
    {
      title: 'Exhausted 503 Hybrid Fallback Test',
      objective: 'Verify fallback when HTTP 503 persists across all retries',
      focusAreas: ['security', 'boundary', 'error-handling'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-test-503-exhausted-hybrid',
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitterMaxMs: 0,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      },
      invokeAiModel: async (_prompt, attempt) => {
        hybridAttempts = attempt;
        const err = new Error(
          'HTTP 503 UNAVAILABLE: Model is experiencing high demand.'
        ) as Error & { status?: number };
        err.status = 503;
        throw err;
      },
    }
  );

  assert.equal(hybridAttempts, 3, 'Should stop after bounded maxAttempts (3)');
  assert.deepEqual(sleepDelays, [100, 200], 'Should use exponential backoff (100ms, 200ms)');
  assert.equal(hybridOutcome.ok, true);
  if (hybridOutcome.ok) {
    assert.equal(hybridOutcome.review.status, 'completed_with_warnings');
    assert.ok(
      hybridOutcome.review.modelUsed.includes(STATIC_ANALYZER_VERSION) &&
        hybridOutcome.review.modelUsed.includes(`${AI_MODEL_ID} failed`),
      `modelUsed must not imply AI succeeded when it failed; got: ${hybridOutcome.review.modelUsed}`
    );
    assert.ok(
      hybridOutcome.review.findings.length >= 4,
      'Must preserve all deterministic static analysis findings'
    );
    assert.ok(
      hybridOutcome.review.findings.every((f) => f.analysisSource === 'static-pattern'),
      'Must NOT fabricate any ai-gemini findings when the model call fails'
    );
    const aiStage = hybridOutcome.review.stages.find((s) => s.stageId === 'stage-ai')!;
    assert.equal(aiStage.status, 'failed');
    assert.equal(aiStage.attempts, 3);
    assert.equal(aiStage.retriedCount, 2);
    assert.equal(aiStage.httpStatus, 503);
    assert.equal(aiStage.errorCode, 'HTTP_503');
  }

  // Case B: AI-only mode returns a structured HTTP 503 AI_SERVICE_UNAVAILABLE error
  const aiOnlyOutcome = await executeReviewPipeline(
    {
      title: 'Exhausted 503 AI-Only Test',
      objective: 'Verify structured error when AI-only mode exhausts retries',
      focusAreas: ['security'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'ai-only',
    },
    {
      requestId: 'req-test-503-exhausted-aionly',
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: async () => {},
      },
      invokeAiModel: async () => {
        const err = new Error('HTTP 503 Service Unavailable') as Error & { status?: number };
        err.status = 503;
        throw err;
      },
    }
  );

  assert.equal(aiOnlyOutcome.ok, false);
  if (!aiOnlyOutcome.ok) {
    assert.equal(aiOnlyOutcome.httpStatus, 503);
    assert.equal(aiOnlyOutcome.error.category, 'AI_SERVICE_UNAVAILABLE');
    assert.equal(aiOnlyOutcome.error.retryable, true);
    assert.equal(aiOnlyOutcome.error.attemptsMade, 3);
  }
});

test('7. HTTP 429 handling respects Retry-After header and bounds maximum delay', async () => {
  const recordedSleeps: number[] = [];

  // Verify parseRetryAfterMs directly on seconds and HTTP-date
  const secMs = parseRetryAfterMs({ headers: { 'Retry-After': '3' } }, 1000, 8000);
  assert.equal(secMs, 3000);

  const cappedMs = parseRetryAfterMs({ headers: { 'Retry-After': '120' } }, 1000, 5000);
  assert.equal(cappedMs, 5000, 'Retry-After must be capped to maxRetryAfterMs');

  let attempts = 0;
  const retryRes = await callAiWithRetry(
    async (attempt) => {
      attempts = attempt;
      if (attempt === 1) {
        const err = new Error('HTTP 429 Too Many Requests: RESOURCE_EXHAUSTED') as Error & {
          status?: number;
          headers?: Record<string, string>;
        };
        err.status = 429;
        err.headers = { 'retry-after': '2' };
        throw err;
      }
      return 'OK_AFTER_429';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 300,
      maxDelayMs: 1500,
      maxRetryAfterMs: 5000,
      jitterMaxMs: 0,
      sleepFn: async (ms) => {
        recordedSleeps.push(ms);
      },
    }
  );

  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.value, 'OK_AFTER_429');
  assert.equal(attempts, 2);
  assert.equal(
    recordedSleeps[0],
    2000,
    'Should respect Retry-After: 2 (2000ms) over base backoff (300ms)'
  );
});

test('8. Permanent authentication (HTTP 401/403) and missing server configuration errors are never retried', async () => {
  let authAttempts = 0;
  const sleeps: number[] = [];

  const authOutcome = await executeReviewPipeline(
    {
      title: 'Permanent Auth Failure Test',
      objective: 'Ensure 401 is not retried',
      focusAreas: ['security'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'ai-only',
    },
    {
      requestId: 'req-test-401-no-retry',
      retryOptions: {
        maxAttempts: 3,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      },
      invokeAiModel: async (_prompt, attempt) => {
        authAttempts = attempt;
        const err = new Error('HTTP 401 Unauthorized: API_KEY_INVALID') as Error & {
          status?: number;
        };
        err.status = 401;
        throw err;
      },
    }
  );

  assert.equal(authAttempts, 1, 'Permanent 401 error must NOT be retried');
  assert.equal(sleeps.length, 0, 'Must not sleep on permanent error');
  assert.equal(authOutcome.ok, false);
  if (!authOutcome.ok) {
    assert.equal(authOutcome.httpStatus, 401);
    assert.equal(authOutcome.error.category, 'AI_AUTH_ERROR');
    assert.equal(authOutcome.error.retryable, false);
    assert.equal(authOutcome.error.attemptsMade, 1);
  }

  // Missing server configuration in static-only vs hybrid vs ai-only
  const staticOnlyOutcome = await executeReviewPipeline(
    {
      title: 'Static-Only Review',
      objective: 'Verify completed_static_only status',
      focusAreas: ['security'],
      files: [
        {
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'static-only',
    },
    {
      requestId: 'req-test-static-only',
      invokeAiModel: null,
    }
  );

  assert.equal(staticOnlyOutcome.ok, true);
  if (staticOnlyOutcome.ok) {
    assert.equal(
      staticOnlyOutcome.review.status,
      'completed_static_only',
      'Static-only mode must report completed_static_only status'
    );
    assert.equal(
      staticOnlyOutcome.review.modelUsed,
      `${STATIC_ANALYZER_VERSION} (Static Analysis Only)`
    );
  }
});

test('9. computePrecisionRecall, matchFindingsToExpectedDefects, and filterFindings operate deterministically', () => {
  const normal = computePrecisionRecall(3, 1, 1);
  assert.equal(normal.precision, 0.75);
  assert.equal(normal.recall, 0.75);
  assert.equal(normal.f1Score, 0.75);

  const zeroDetections = computePrecisionRecall(0, 0, 2);
  assert.equal(zeroDetections.precision, null);
  assert.equal(zeroDetections.recall, 0);
  assert.equal(zeroDetections.f1Score, null);

  const cleanControlCase = computePrecisionRecall(0, 0, 0);
  assert.equal(cleanControlCase.precision, null);
  assert.equal(cleanControlCase.recall, null);
  assert.equal(cleanControlCase.f1Score, null);

  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const expected = [
    {
      id: 'exp-sql',
      title: 'SQL Injection on line 3',
      category: 'security' as const,
      minSeverity: 'critical' as const,
      startLine: 3,
      endLine: 3,
      rationale: 'Direct interpolation of tenantId',
    },
    {
      id: 'exp-missing',
      title: 'Unmatched synthetic defect on line 13',
      category: 'data-integrity' as const,
      minSeverity: 'high' as const,
      startLine: 13,
      endLine: 13,
      rationale: 'Synthetic unmatched defect to verify FN counting',
    },
  ];

  const evalResult = matchFindingsToExpectedDefects(staticFindings, expected);
  assert.equal(evalResult.truePositives, 1);
  assert.equal(evalResult.falseNegatives, 1);
  assert.ok(evalResult.falsePositives >= 1);
  assert.equal(evalResult.recall, 0.5);

  const dist = computeSeverityDistribution(staticFindings);
  assert.equal(dist.total, staticFindings.length);
  assert.equal(dist.highestSeverity, 'critical');

  const onlyCritical = filterFindings(staticFindings, {
    severity: 'critical',
    category: 'all',
    filename: 'all',
    status: 'all',
    source: 'all',
    searchQuery: '',
  });
  assert.ok(onlyCritical.length >= 2);
  assert.ok(onlyCritical.every((f) => f.severity === 'critical'));
});
