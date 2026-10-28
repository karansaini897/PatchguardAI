import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSourceContentHash,
  mergeAndCorroborateFindings,
  resolveTargetSourceFile,
  runStaticAnalysisOnFiles,
  STATIC_ANALYZER_VERSION,
  validateAndNormalizeFindingLocation,
  verifyFindingLocationIntegrity,
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
  parseAndValidateAiFindings,
  parseRetryAfterMs,
} from './reviewOrchestrator';
import { INITIAL_EVALUATION_TEST_CASES, ISOLATED_DEMO_REVIEW } from './curatedData';
import { ReviewFinding, SourceFileRecord } from '../types/patchguard';

const sampleVulnFile: SourceFileRecord = {
  id: 'file-1',
  filename: 'src/services/ledgerService.ts',
  language: 'typescript',
  changeStatus: 'modified',
  lineCount: 15,
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
  contentHash: computeSourceContentHash(
    [
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
    ].join('\n')
  ),
};

const secondaryFile: SourceFileRecord = {
  id: 'file-2',
  filename: 'src/services/adminAudit.ts',
  language: 'typescript',
  changeStatus: 'added',
  lineCount: 5,
  content: [
    'export async function deleteAuditEntry(db: any, entryId: string) {',
    '  await db.deleteById("audit_entries", entryId);',
    '  return { purged: entryId };',
    '}',
  ].join('\n'),
  contentHash: computeSourceContentHash(
    [
      'export async function deleteAuditEntry(db: any, entryId: string) {',
      '  await db.deleteById("audit_entries", entryId);',
      '  return { purged: entryId };',
      '}',
    ].join('\n')
  ),
};

test('1. Valid finding referencing an existing line validates line bounds, extracts verbatim snippet, and binds contentHash', () => {
  const loc = validateAndNormalizeFindingLocation(sampleVulnFile, 3, 4);
  assert.equal(loc.isValidLocation, true);
  assert.equal(loc.locationReason, 'verified');
  assert.equal(loc.fileId, sampleVulnFile.id);
  assert.equal(loc.filename, sampleVulnFile.filename);
  assert.equal(loc.startLine, 3);
  assert.equal(loc.endLine, 4);
  assert.ok(loc.rawSnippet.includes('SELECT * FROM accounts'));
  assert.equal(loc.contentHash, sampleVulnFile.contentHash);
});

test('2. Out-of-bounds line reference is quarantined without clamping to nearest valid line', () => {
  const outOfBoundsHigh = validateAndNormalizeFindingLocation(sampleVulnFile, 84, 88);
  assert.equal(outOfBoundsHigh.isValidLocation, false);
  assert.equal(outOfBoundsHigh.locationReason, 'out_of_bounds');
  assert.equal(outOfBoundsHigh.startLine, 84, 'Must not clamp startLine 84 to file length');
  assert.equal(outOfBoundsHigh.endLine, 88, 'Must not clamp endLine 88 to file length');
  assert.equal(outOfBoundsHigh.rawSnippet, '');
  assert.ok(outOfBoundsHigh.validationNote?.includes('outside valid bounds'));

  const invertedRange = validateAndNormalizeFindingLocation(sampleVulnFile, 8, 5);
  assert.equal(invertedRange.isValidLocation, false);
  assert.equal(invertedRange.locationReason, 'out_of_bounds');
  assert.equal(invertedRange.startLine, 8);
  assert.equal(invertedRange.endLine, 5, 'Must not silently overwrite inverted endLine');
});

test('3. Finding associated with the wrong file is quarantined as wrong_file instead of falling back to files[0]', () => {
  const resolvedUnknown = resolveTargetSourceFile(
    [sampleVulnFile, secondaryFile],
    undefined,
    'db/migrations/004_idempotency_index.sql'
  );
  assert.equal(resolvedUnknown, null, 'Unknown filename must not resolve to files[0]');

  const parsed = parseAndValidateAiFindings(
    JSON.stringify([
      {
        title: 'Missing TTL index in schema migration',
        severity: 'critical',
        category: 'maintainability',
        filename: 'db/migrations/004_idempotency_index.sql',
        startLine: 84,
        endLine: 88,
        confidence: 'high',
        explanation: 'Table lacks an expiration index on idempotency_keys.',
        potentialImpact: 'Unbounded table growth.',
        suggestedRemediation: 'Create a partial TTL index.',
      },
    ]),
    [sampleVulnFile, secondaryFile]
  );

  assert.equal(parsed.quarantinedCount, 1);
  assert.equal(parsed.findings.length, 1);
  const wrongFileFinding = parsed.findings[0];
  assert.equal(wrongFileFinding.location.isValidLocation, false);
  assert.equal(wrongFileFinding.location.locationReason, 'wrong_file');
  assert.notEqual(
    wrongFileFinding.location.fileId,
    sampleVulnFile.id,
    'Must NOT associate a wrong-file finding with sampleVulnFile (files[0])'
  );
  assert.equal(
    wrongFileFinding.severity,
    'low',
    'Unverified wrong-file finding must not retain critical severity'
  );
  assert.equal(wrongFileFinding.confidence, 'low');
});

test('4. File whose source changes after analysis is detected via contentHash mismatch and quarantined', () => {
  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const sqlFinding = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001')!;
  assert.ok(sqlFinding);
  assert.equal(sqlFinding.location.isValidLocation, true);

  // Verify against unmodified file
  const intactLoc = verifyFindingLocationIntegrity(sqlFinding, [sampleVulnFile]);
  assert.equal(intactLoc.isValidLocation, true);
  assert.equal(intactLoc.locationReason, 'verified');

  // Mutate the file content after analysis
  const mutatedFile: SourceFileRecord = {
    ...sampleVulnFile,
    content: '// Header comment added after analysis\n' + sampleVulnFile.content,
    lineCount: sampleVulnFile.lineCount + 1,
    contentHash: computeSourceContentHash(
      '// Header comment added after analysis\n' + sampleVulnFile.content
    ),
  };

  const postMutationLoc = verifyFindingLocationIntegrity(sqlFinding, [mutatedFile]);
  assert.equal(postMutationLoc.isValidLocation, false);
  assert.equal(postMutationLoc.locationReason, 'source_changed');
  assert.equal(postMutationLoc.rawSnippet, '');
  assert.ok(postMutationLoc.validationNote?.includes('changed after this finding was generated'));
});

test('5. Finding with no reliable line reference (missing, null, NaN, or 0) is quarantined and downgraded', () => {
  const parsed = parseAndValidateAiFindings(
    JSON.stringify([
      {
        title: 'General architectural concern without line reference',
        severity: 'high',
        category: 'security',
        filename: sampleVulnFile.filename,
        startLine: null,
        endLine: null,
        confidence: 'high',
        explanation: 'Module does not enforce rate limiting at the controller boundary.',
        potentialImpact: 'Potential credential stuffing or brute-force attempts.',
        suggestedRemediation: 'Apply rate-limiting middleware.',
      },
      {
        title: 'Zero line number finding',
        severity: 'critical',
        category: 'security',
        filename: sampleVulnFile.filename,
        startLine: 0,
        endLine: 0,
        confidence: 'high',
        explanation: 'Invalid 0-indexed line number returned by model.',
        potentialImpact: 'Unknown impact.',
        suggestedRemediation: 'Check line bounds.',
      },
    ]),
    [sampleVulnFile]
  );

  assert.equal(parsed.quarantinedCount, 2);
  for (const f of parsed.findings) {
    assert.equal(f.location.isValidLocation, false);
    assert.equal(f.location.locationReason, 'missing_line');
    assert.equal(f.location.rawSnippet, '');
    assert.equal(f.severity, 'low', 'Severity must be downgraded when line reference is missing');
    assert.equal(f.confidence, 'low');
  }
});

test('6. Valid finding alongside an invalid finding preserves the valid finding and reports completed_with_warnings', async () => {
  const outcome = await executeReviewPipeline(
    {
      title: 'Mixed Valid and Invalid Findings Test',
      objective: 'Ensure valid findings are preserved when another finding is quarantined',
      focusAreas: ['security', 'data-integrity'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-test-mixed-validity',
      invokeAiModel: async () =>
        JSON.stringify([
          {
            title: 'Unchecked negative balance deduction on line 9',
            severity: 'high',
            category: 'data-integrity',
            filename: sampleVulnFile.filename,
            startLine: 9,
            endLine: 9,
            confidence: 'high',
            explanation: 'account.balance - amount is written without verifying sufficient funds.',
            potentialImpact: 'Negative account ledger balance.',
            suggestedRemediation: 'Check account.balance >= amount inside a transaction.',
          },
          {
            title: 'Hallucinated finding at line 95',
            severity: 'critical',
            category: 'security',
            filename: sampleVulnFile.filename,
            startLine: 95,
            endLine: 99,
            confidence: 'high',
            explanation: 'References lines 95-99 which do not exist in the 14-line file.',
            potentialImpact: 'Unverified.',
            suggestedRemediation: 'N/A',
          },
        ]),
    }
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(
    outcome.review.status,
    'completed_with_warnings',
    'Review with a quarantined finding must report completed_with_warnings, not completed'
  );
  assert.ok(outcome.review.warningMessage?.includes('quarantined'));

  const validAiFinding = outcome.review.findings.find((f) =>
    f.title.includes('Unchecked negative balance deduction')
  );
  const quarantinedAiFinding = outcome.review.findings.find((f) =>
    f.title.includes('Hallucinated finding at line 95')
  );

  assert.ok(validAiFinding, 'Valid AI finding must be preserved');
  assert.equal(validAiFinding.location.isValidLocation, true);
  assert.equal(validAiFinding.severity, 'high');

  assert.ok(quarantinedAiFinding, 'Quarantined finding is retained with quarantine metadata');
  assert.equal(quarantinedAiFinding.location.isValidLocation, false);
  assert.equal(quarantinedAiFinding.location.locationReason, 'out_of_bounds');
  assert.equal(
    quarantinedAiFinding.severity,
    'low',
    'Quarantined finding severity must be downgraded from critical to low'
  );
});

test('7. Source-engine attribution and ISOLATED_DEMO_REVIEW integrity (no fabricated L84 findings)', () => {
  // Verify ISOLATED_DEMO_REVIEW has zero fabricated out-of-bounds findings
  assert.equal(ISOLATED_DEMO_REVIEW.status, 'completed_static_only');
  assert.ok(ISOLATED_DEMO_REVIEW.findings.length >= 6);
  for (const f of ISOLATED_DEMO_REVIEW.findings) {
    const verifiedLoc = verifyFindingLocationIntegrity(f, ISOLATED_DEMO_REVIEW.files);
    assert.equal(
      verifiedLoc.isValidLocation,
      true,
      `Every demo finding must have a verified location; failed on ${f.id} (${f.location.filename}:L${f.location.startLine})`
    );
    assert.equal(f.analysisSource, 'static-pattern');
    assert.ok(f.staticCorroboration?.ruleId, 'Every demo finding must map to an implemented ruleId');
  }

  // Verify mergeAndCorroborateFindings preserves static-pattern, ai-gemini, and corroborated
  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const sqlStatic = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001')!;
  const secretStatic = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-005')!;

  const mockAiOverlapping: ReviewFinding = {
    id: 'ai-1',
    title: 'SQL injection in settleAccount',
    severity: 'critical',
    category: 'security',
    status: 'unreviewed',
    analysisSource: 'ai-gemini',
    confidence: 'high',
    location: validateAndNormalizeFindingLocation(sampleVulnFile, 3, 3),
    explanation: 'Direct interpolation of tenantId into SQL query string.',
    potentialImpact: 'Cross-tenant data access.',
    suggestedRemediation: 'Use parameterized queries.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockAiDistinct: ReviewFinding = {
    id: 'ai-2',
    title: 'Negative balance deduction on line 9',
    severity: 'high',
    category: 'data-integrity',
    status: 'unreviewed',
    analysisSource: 'ai-gemini',
    confidence: 'high',
    location: validateAndNormalizeFindingLocation(sampleVulnFile, 9, 9),
    explanation: 'Balance updated without checking overdraft invariant.',
    potentialImpact: 'Negative ledger balance.',
    suggestedRemediation: 'Enforce balance >= amount check.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const merged = mergeAndCorroborateFindings(
    [sqlStatic, secretStatic],
    [mockAiOverlapping, mockAiDistinct]
  );

  assert.equal(merged.length, 3);
  assert.equal(
    merged.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001')?.analysisSource,
    'corroborated'
  );
  assert.equal(
    merged.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-005')?.analysisSource,
    'static-pattern'
  );
  assert.equal(merged.find((f) => f.id === 'ai-2')?.analysisSource, 'ai-gemini');
});

test('8. Correct review status and retry handling when AI fails (HTTP 503/429/401) but static analysis succeeds', async () => {
  // 8a. HTTP 503 followed by successful retry on attempt 2
  let retryAttempts = 0;
  const recoveredOutcome = await executeReviewPipeline(
    {
      title: '503 Retry Recovery',
      objective: 'Test bounded exponential backoff retry',
      focusAreas: ['security'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-503-recover',
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 50,
        sleepFn: async () => {},
      },
      invokeAiModel: async (_prompt, attempt) => {
        retryAttempts = attempt;
        if (attempt === 1) {
          const err = new Error('HTTP 503 Service Unavailable') as Error & { status?: number };
          err.status = 503;
          throw err;
        }
        return JSON.stringify([
          {
            title: 'SQL injection on line 3',
            severity: 'critical',
            category: 'security',
            filename: sampleVulnFile.filename,
            startLine: 3,
            endLine: 3,
            confidence: 'high',
            explanation: 'Template literal interpolates tenantId directly into SQL query.',
            potentialImpact: 'Arbitrary query execution.',
            suggestedRemediation: 'Use bound parameters.',
          },
        ]);
      },
    }
  );
  assert.equal(retryAttempts, 2);
  assert.equal(recoveredOutcome.ok, true);
  if (recoveredOutcome.ok) {
    assert.equal(recoveredOutcome.review.status, 'completed');
  }

  // 8b. HTTP 503 exhausted across all 3 attempts -> Hybrid falls back to static analysis with completed_with_warnings
  let exhaustedAttempts = 0;
  const hybridFallbackOutcome = await executeReviewPipeline(
    {
      title: '503 Exhausted Hybrid Fallback',
      objective: 'Test static fallback when AI fails after retries',
      focusAreas: ['security', 'boundary'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-503-fallback',
      retryOptions: {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: async () => {},
      },
      invokeAiModel: async (_prompt, attempt) => {
        exhaustedAttempts = attempt;
        const err = new Error('HTTP 503 Service Unavailable: high demand') as Error & {
          status?: number;
        };
        err.status = 503;
        throw err;
      },
    }
  );

  assert.equal(exhaustedAttempts, 3);
  assert.equal(hybridFallbackOutcome.ok, true);
  if (hybridFallbackOutcome.ok) {
    assert.equal(hybridFallbackOutcome.review.status, 'completed_with_warnings');
    assert.ok(
      hybridFallbackOutcome.review.modelUsed.includes(STATIC_ANALYZER_VERSION) &&
        hybridFallbackOutcome.review.modelUsed.includes(`${AI_MODEL_ID} failed`)
    );
    assert.ok(hybridFallbackOutcome.review.findings.length >= 4);
    assert.ok(
      hybridFallbackOutcome.review.findings.every((f) => f.analysisSource === 'static-pattern'),
      'No AI findings may be fabricated when AI fails'
    );
  }

  // 8c. HTTP 429 Retry-After parsing and permanent HTTP 401 non-retry
  assert.equal(parseRetryAfterMs({ headers: { 'Retry-After': '2' } }, 1000, 8000), 2000);
  let authCalls = 0;
  const authRes = await callAiWithRetry(
    async (attempt) => {
      authCalls = attempt;
      const err = new Error('HTTP 401 Unauthorized') as Error & { status?: number };
      err.status = 401;
      throw err;
    },
    { maxAttempts: 3, sleepFn: async () => {} }
  );
  assert.equal(authRes.ok, false);
  assert.equal(authCalls, 1, 'Permanent 401 error must not be retried');
});

test('9. Correct behavior when all analysis engines fail (returns structured error and failed review status)', async () => {
  // Case A: Hybrid mode where both static engine and AI engine fail
  const bothFailedOutcome = await executeReviewPipeline(
    {
      title: 'All Engines Failure Test',
      objective: 'Verify failed status when both static and AI engines fail',
      focusAreas: ['security'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    {
      requestId: 'req-all-failed',
      retryOptions: {
        maxAttempts: 2,
        baseDelayMs: 10,
        sleepFn: async () => {},
      },
      runStaticAnalysisFn: () => {
        throw new Error('AST parser internal fault');
      },
      invokeAiModel: async () => {
        const err = new Error('HTTP 503 Service Unavailable') as Error & { status?: number };
        err.status = 503;
        throw err;
      },
    }
  );

  assert.equal(bothFailedOutcome.ok, false);
  if (!bothFailedOutcome.ok) {
    assert.equal(bothFailedOutcome.httpStatus, 503);
    assert.equal(bothFailedOutcome.error.category, 'AI_SERVICE_UNAVAILABLE');
    assert.ok(bothFailedOutcome.failedReview);
    assert.equal(bothFailedOutcome.failedReview.status, 'failed');
    assert.equal(bothFailedOutcome.failedReview.findings.length, 0);
    assert.ok(
      bothFailedOutcome.failedReview.stages.every((s) => s.status === 'failed'),
      'Both static and AI stages must be recorded as failed'
    );
  }

  // Case B: Evaluation metrics and filter helpers remain deterministic
  const normal = computePrecisionRecall(3, 1, 1);
  assert.equal(normal.precision, 0.75);
  assert.equal(normal.recall, 0.75);
  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const dist = computeSeverityDistribution(staticFindings);
  assert.equal(dist.total, staticFindings.length);
  const filtered = filterFindings(staticFindings, {
    severity: 'critical',
    category: 'all',
    filename: 'all',
    status: 'all',
    source: 'all',
    searchQuery: '',
  });
  assert.ok(filtered.length >= 2);
});

test('10. Static analysis rules accuracy, SQL injection CWE-89 classification, and negative control verification', async () => {
  // 10a. Verify PG-SEC-001 accurately classifies SQL Injection (CWE-89) and never conflates with command injection
  const demoFindings = ISOLATED_DEMO_REVIEW.findings;
  assert.equal(demoFindings.length, 8, 'PR #418 demo must produce exactly 8 verified static findings across 2 files');

  const sqlFindings = demoFindings.filter((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001');
  assert.equal(sqlFindings.length, 2, 'PR #418 must trigger PG-SEC-001 on L12-13 and L22 of payoutController.ts');
  for (const sf of sqlFindings) {
    assert.equal(
      sf.title,
      'Unsanitized SQL query interpolation enables SQL injection (CWE-89)',
      'PG-SEC-001 title must accurately name SQL injection (CWE-89)'
    );
    assert.ok(
      !sf.title.toLowerCase().includes('command injection'),
      'PG-SEC-001 must not misclassify SQL injection as command injection'
    );
    assert.ok(sf.potentialImpact.includes('CWE-89'));
    assert.equal(sf.severity, 'critical');
    assert.equal(sf.confidence, 'high');
  }

  // 10b. Verify PG-SEC-001 negative cases: prose log strings and error messages with SQL words must NOT trigger false positives
  const negativeLogAndPlaceholderFile: SourceFileRecord = {
    id: 'file-neg-log',
    filename: 'src/services/auditLogger.ts',
    language: 'typescript',
    changeStatus: 'modified',
    lineCount: 8,
    content: [
      'export function logAccountUpdate(accountId: string, tenantId: string) {',
      '  const placeholderKey = "YOUR_API_KEY_HERE";',
      '  console.error(`Failed to UPDATE account ${accountId} or DELETE FROM cache for ${tenantId}`);',
      '  throw new Error(`Cannot SELECT record FROM ledger where id = ${accountId}`);',
      '}',
    ].join('\n'),
    contentHash: computeSourceContentHash(
      [
        'export function logAccountUpdate(accountId: string, tenantId: string) {',
        '  const placeholderKey = "YOUR_API_KEY_HERE";',
        '  console.error(`Failed to UPDATE account ${accountId} or DELETE FROM cache for ${tenantId}`);',
        '  throw new Error(`Cannot SELECT record FROM ledger where id = ${accountId}`);',
        '}',
      ].join('\n')
    ),
  };

  const negFindings = runStaticAnalysisOnFiles([negativeLogAndPlaceholderFile]);
  assert.equal(
    negFindings.length,
    0,
    'Log statements, Error constructors, and placeholder keys must produce 0 false positives'
  );

  // 10c. Verify all 5 curated evaluation suite test cases (positive defect suites eval-tc-01..04 and clean control eval-tc-05)
  for (const tc of INITIAL_EVALUATION_TEST_CASES) {
    const fileRecord: SourceFileRecord = {
      id: `tc-${tc.id}`,
      filename: tc.filename,
      language: tc.language,
      changeStatus: 'modified',
      content: tc.sourceCode,
      lineCount: tc.sourceCode.split('\n').length,
      contentHash: computeSourceContentHash(tc.sourceCode),
    };
    const findings = runStaticAnalysisOnFiles([fileRecord]);
    const matchRes = matchFindingsToExpectedDefects(findings, tc.expectedDefects);

    if (tc.expectedDefects.length === 0) {
      // Negative control (eval-tc-05: Parameterized Query & Transactional Payout)
      assert.equal(
        findings.length,
        0,
        `Negative control ${tc.id} (${tc.title}) must produce 0 false positives`
      );
    } else {
      assert.equal(
        matchRes.falseNegatives,
        0,
        `Positive benchmark ${tc.id} (${tc.title}) must detect all expected ground-truth defects`
      );
    }
  }

  // 10d. Verify explicit stage status distinction: static-only ('skipped') vs hybrid missing key ('skipped' + 'completed_with_warnings')
  const staticOnlyRes = await executeReviewPipeline(
    {
      title: 'Static Only Mode Verification',
      objective: 'Verify static-only mode marks AI stage as skipped',
      focusAreas: ['security'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'static-only',
    },
    { requestId: 'req-static-only', invokeAiModel: null }
  );
  assert.equal(staticOnlyRes.ok, true);
  if (staticOnlyRes.ok) {
    assert.equal(staticOnlyRes.review.status, 'completed_static_only');
    const stgStatic = staticOnlyRes.review.stages.find((s) => s.stageId === 'stage-static')!;
    const stgAi = staticOnlyRes.review.stages.find((s) => s.stageId === 'stage-ai')!;
    assert.equal(stgStatic.status, 'succeeded');
    assert.equal(stgAi.status, 'skipped');
    assert.ok(stgAi.errorMessage?.includes('Static Analyzer Only'));
  }

  const hybridMissingKeyRes = await executeReviewPipeline(
    {
      title: 'Hybrid Missing Key Verification',
      objective: 'Verify hybrid mode with missing server key marks AI stage as skipped and review as completed_with_warnings',
      focusAreas: ['security'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'hybrid',
    },
    { requestId: 'req-hybrid-no-key', invokeAiModel: null }
  );
  assert.equal(hybridMissingKeyRes.ok, true);
  if (hybridMissingKeyRes.ok) {
    assert.equal(hybridMissingKeyRes.review.status, 'completed_with_warnings');
    const stgAi = hybridMissingKeyRes.review.stages.find((s) => s.stageId === 'stage-ai')!;
    assert.equal(stgAi.status, 'skipped');
    assert.equal(stgAi.errorCode, 'MISSING_SERVER_CONFIG');
  }
});

