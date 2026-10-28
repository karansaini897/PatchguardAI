import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSourceContentHash,
  deduplicateFindings,
  mergeAndCorroborateFindings,
  resolveTargetSourceFile,
  runStaticAnalysisOnFiles,
  STATIC_ANALYZER_VERSION,
  validateAndNormalizeFindingLocation,
  verifyFindingLocationIntegrity,
  verifyReviewFindingsIntegrity,
} from './staticAnalyzer.ts';
import {
  computePrecisionRecall,
  computeSeverityDistribution,
  filterFindings,
  matchFindingsToExpectedDefects,
} from './evaluationMath.ts';
import {
  AI_MODEL_ID,
  callAiWithRetry,
  executeReviewPipeline,
  isConfiguredGeminiApiKey,
  parseAndValidateAiFindings,
  parseRetryAfterMs,
  resolveServerPort,
  sanitizeErrorMessage,
} from './reviewOrchestrator.ts';
import { INITIAL_EVALUATION_TEST_CASES, ISOLATED_DEMO_REVIEW } from './curatedData.ts';
import type { ReviewFinding, SourceFileRecord } from '../types/patchguard.ts';

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

  // 10b. Verify PG-SEC-001 negative cases: unrelated English string interpolations, log strings, OS shell commands, and parameterized queries must NOT trigger false positives
  const negativeLogAndPlaceholderFile: SourceFileRecord = {
    id: 'file-neg-log',
    filename: 'src/services/auditLogger.ts',
    language: 'typescript',
    changeStatus: 'modified',
    lineCount: 12,
    content: [
      'export async function logAccountUpdate(db: any, exec: any, accountId: string, tenantId: string, userName: string) {',
      '  const placeholderKey = "YOUR_API_KEY_HERE";',
      '  const uiPrompt = `Please select an item from the menu for ${userName}`;',
      '  const uiBanner = `Update the set of active widgets for ${tenantId}`;',
      '  const shellCmd = `ls -la /var/log/payouts/${tenantId}`;',
      '  exec(shellCmd);',
      '  console.error(`Failed to UPDATE account ${accountId} or DELETE FROM cache for ${tenantId}`);',
      '  throw new Error(`Cannot SELECT record FROM ledger where id = ${accountId}`);',
      '}',
    ].join('\n'),
    contentHash: computeSourceContentHash(
      [
        'export async function logAccountUpdate(db: any, exec: any, accountId: string, tenantId: string, userName: string) {',
        '  const placeholderKey = "YOUR_API_KEY_HERE";',
        '  const uiPrompt = `Please select an item from the menu for ${userName}`;',
        '  const uiBanner = `Update the set of active widgets for ${tenantId}`;',
        '  const shellCmd = `ls -la /var/log/payouts/${tenantId}`;',
        '  exec(shellCmd);',
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
    'Unrelated English interpolations ("Please select...from..."), OS commands, log statements, Error constructors, and placeholder keys must produce 0 false positives'
  );

  // 10c. Verify multi-line unsafe SQL template literal triggers exactly 1 PG-SEC-001 finding (no duplicate per-line hits)
  const multilineUnsafeSqlFile: SourceFileRecord = {
    id: 'file-multiline-sql',
    filename: 'src/repos/multilineSql.ts',
    language: 'typescript',
    changeStatus: 'modified',
    lineCount: 8,
    content: [
      'export async function queryByTenant(db: any, tenantId: string) {',
      '  const sql = `',
      '    SELECT id, balance_cents',
      '    FROM merchant_accounts',
      "    WHERE tenant_id = '${tenantId}'",
      '  `;',
      '  return db.query(sql);',
      '}',
    ].join('\n'),
    contentHash: computeSourceContentHash(
      [
        'export async function queryByTenant(db: any, tenantId: string) {',
        '  const sql = `',
        '    SELECT id, balance_cents',
        '    FROM merchant_accounts',
        "    WHERE tenant_id = '${tenantId}'",
        '  `;',
        '  return db.query(sql);',
        '}',
      ].join('\n')
    ),
  };

  const multilineSqlFindings = runStaticAnalysisOnFiles([multilineUnsafeSqlFile]);
  assert.equal(multilineSqlFindings.length, 1, 'Multi-line SQL template literal must emit 1 finding without duplicate per-line hits');
  assert.equal(multilineSqlFindings[0].staticCorroboration?.ruleId, 'PG-SEC-001');
  assert.equal(multilineSqlFindings[0].location.startLine, 2);
  assert.equal(multilineSqlFindings[0].location.endLine, 6);

  // 10d. Verify all 5 curated evaluation suite test cases (positive defect suites eval-tc-01..04 and clean control eval-tc-05)
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

  // 10e. Verify explicit stage status distinction: static-only ('skipped') vs hybrid missing key ('skipped' + 'completed_with_warnings')
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

test('11. Deduplication removes genuinely redundant findings while preserving distinct rules and distinct locations', () => {
  const demoFindings = ISOLATED_DEMO_REVIEW.findings;
  // 11a. In PR #418, PG-SEC-001 triggers at L12-13 and L22 (non-overlapping locations) -> both preserved
  const sec001List = demoFindings.filter((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001');
  assert.equal(sec001List.length, 2);
  assert.equal(sec001List[0].location.startLine, 12);
  assert.equal(sec001List[1].location.startLine, 22);

  // 11b. In PR #418, L20-23 triggers both PG-BND-003 (boundary) and PG-PERF-007 (performance) -> both preserved
  const l20Findings = demoFindings.filter((f) => f.location.startLine === 20);
  assert.equal(l20Findings.length, 2);
  const l20Rules = l20Findings.map((f) => f.staticCorroboration?.ruleId).sort();
  assert.deepEqual(l20Rules, ['PG-BND-003', 'PG-PERF-007']);

  // 11c. Passing duplicate static findings for the same rule and overlapping lines deduplicates to 1
  const duplicateStatic = [sec001List[0], { ...sec001List[0], id: 'dup-sec-001' }];
  const dedupedStatic = deduplicateFindings(duplicateStatic);
  assert.equal(dedupedStatic.length, 1, 'Genuinely redundant static findings for same rule & line must be deduplicated');

  // 11d. Passing duplicate AI findings for the same file, category, and line range during corroboration consumes both duplicates
  const parsedDuplicateAi = parseAndValidateAiFindings(
    JSON.stringify([
      {
        title: 'SQL injection in lookupSql',
        severity: 'critical',
        category: 'security',
        filename: 'src/ledger/payoutController.ts',
        startLine: 12,
        endLine: 13,
        confidence: 'high',
        explanation: 'First AI detection of SQL injection on L12.',
        potentialImpact: 'Arbitrary database read.',
        suggestedRemediation: 'Parameterize query.',
      },
      {
        title: 'Redundant duplicate AI SQL injection on L12',
        severity: 'high',
        category: 'security',
        filename: 'src/ledger/payoutController.ts',
        startLine: 12,
        endLine: 13,
        confidence: 'medium',
        explanation: 'Duplicate AI detection on the exact same lines and category.',
        potentialImpact: 'Arbitrary database read.',
        suggestedRemediation: 'Parameterize query.',
      },
    ]),
    ISOLATED_DEMO_REVIEW.files
  );

  const merged = mergeAndCorroborateFindings([sec001List[0]], parsedDuplicateAi.findings);
  assert.equal(
    merged.length,
    1,
    'Duplicate AI findings on the same file, category, and line range must corroborate into a single finding'
  );
  assert.equal(merged[0].analysisSource, 'corroborated');
});

test('12. Phase 3 & 4 production readiness: API key placeholder rejection, secret redaction, malformed AI output handling, and enum normalization', async () => {
  // 12a. Verify placeholder API keys from .env.example are rejected
  assert.equal(isConfiguredGeminiApiKey(''), false);
  assert.equal(isConfiguredGeminiApiKey(null), false);
  assert.equal(isConfiguredGeminiApiKey('MY_GEMINI_API_KEY'), false);
  assert.equal(isConfiguredGeminiApiKey('YOUR_API_KEY_HERE'), false);
  assert.equal(isConfiguredGeminiApiKey('AIzaSyRealLookingTestCredentialKey99123456'), true);

  // 12b. Verify secret redaction in sanitizeErrorMessage
  assert.ok(
    !sanitizeErrorMessage('Request failed for key=AIzaSyRealLookingTestCredentialKey99123456').includes(
      'AIzaSyRealLookingTestCredentialKey99123456'
    )
  );

  // 12c. Verify capitalized model enum values ("Critical", "High", "Injection") are normalized accurately
  const parsedCapitalized = parseAndValidateAiFindings(
    JSON.stringify([
      {
        title: 'SQL Injection vulnerability',
        severity: 'Critical',
        category: 'Injection',
        filename: sampleVulnFile.filename,
        startLine: 3,
        endLine: 3,
        confidence: 'High',
        explanation: 'The code uses string interpolation to construct a SQL query with user-supplied input.',
        potentialImpact: 'Arbitrary database access.',
        suggestedRemediation: 'Use parameterized queries.',
      },
    ]),
    [sampleVulnFile]
  );
  assert.equal(parsedCapitalized.quarantinedCount, 0);
  assert.equal(parsedCapitalized.findings[0].severity, 'critical');
  assert.equal(parsedCapitalized.findings[0].confidence, 'high');
  assert.equal(parsedCapitalized.findings[0].category, 'security');

  // 12d. Verify malformed/unusable model output is not retried and falls back to static analysis in hybrid mode (or fails in ai-only mode)
  let malformedAttempts = 0;
  const malformedHybridRes = await executeReviewPipeline(
    {
      title: 'Malformed JSON Hybrid Test',
      objective: 'Verify malformed model response handling',
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
      requestId: 'req-malformed-hybrid',
      invokeAiModel: async (_prompt, attempt) => {
        malformedAttempts = attempt;
        return '{not_valid_json: [unclosed';
      },
    }
  );
  assert.equal(malformedAttempts, 1, 'Malformed JSON schema error is permanent and must not be retried');
  assert.equal(malformedHybridRes.ok, true);
  if (malformedHybridRes.ok) {
    assert.equal(malformedHybridRes.review.status, 'completed_with_warnings');
    const aiStage = malformedHybridRes.review.stages.find((s) => s.stageId === 'stage-ai')!;
    assert.equal(aiStage.status, 'failed');
    assert.equal(aiStage.errorCode, 'INVALID_MODEL_RESPONSE');
    assert.ok(malformedHybridRes.review.findings.every((f) => f.analysisSource === 'static-pattern'));
  }

  // 12e. Verify AI-only mode when Gemini is not configured returns HTTP 503 MISSING_SERVER_CONFIG
  const aiOnlyNoKeyRes = await executeReviewPipeline(
    {
      title: 'AI Only Unconfigured Test',
      objective: 'Verify AI-only mode without server key fails cleanly',
      focusAreas: ['security'],
      files: [
        {
          id: sampleVulnFile.id,
          filename: sampleVulnFile.filename,
          language: sampleVulnFile.language,
          content: sampleVulnFile.content,
        },
      ],
      analysisMode: 'ai-only',
    },
    {
      requestId: 'req-ai-only-no-key',
      invokeAiModel: null,
    }
  );
  assert.equal(aiOnlyNoKeyRes.ok, false);
  if (!aiOnlyNoKeyRes.ok) {
    assert.equal(aiOnlyNoKeyRes.httpStatus, 503);
    assert.equal(aiOnlyNoKeyRes.error.category, 'MISSING_SERVER_CONFIG');
  }
});

test('13. Defensive workspace location validation (verifyReviewFindingsIntegrity & resolveTargetSourceFile) protects rendering and navigation', () => {
  const [fileA, fileB] = ISOLATED_DEMO_REVIEW.files;
  const validFindingA = ISOLATED_DEMO_REVIEW.findings.find(
    (f) => f.location.fileId === fileA.id
  )!;
  const validFindingB = ISOLATED_DEMO_REVIEW.findings.find(
    (f) => f.location.fileId === fileB.id
  )!;

  // 13a. Finding for fileB must never resolve against [fileA] (prevents cross-file highlighting in SourceViewer)
  const resolvedAgainstWrongFile = resolveTargetSourceFile(
    [fileA],
    validFindingB.location.fileId,
    validFindingB.location.filename
  );
  assert.equal(
    resolvedAgainstWrongFile,
    null,
    'Finding belonging to fileB must not resolve when checked against [fileA]'
  );

  // 13b. Conflicting fileId vs filename must be rejected as null rather than guessing
  const conflictedResolution = resolveTargetSourceFile(
    [fileA, fileB],
    fileA.id,
    fileB.filename
  );
  assert.equal(
    conflictedResolution,
    null,
    'Conflicting fileId and filename must return null and never guess a target file'
  );

  // 13c. Mixed batch in verifyReviewFindingsIntegrity:
  // - validFindingA remains verified
  // - outOfBoundsFinding (claiming isValidLocation: true on L99 of a 33-line file) is quarantined without clamping
  // - staleSnippetFinding (claiming rawSnippet that does not match line 12) is quarantined as source_changed
  // - wrongFileFinding (referencing a non-existent file) is quarantined as wrong_file
  const outOfBoundsTampered: ReviewFinding = {
    ...validFindingA,
    id: 'tampered-oob',
    confidence: 'high',
    location: {
      ...validFindingA.location,
      startLine: 99,
      endLine: 102,
      isValidLocation: true, // Simulates corrupted/unverified stored state
    },
  };

  const staleSnippetTampered: ReviewFinding = {
    ...validFindingA,
    id: 'tampered-snippet',
    confidence: 'high',
    location: {
      ...validFindingA.location,
      rawSnippet: 'const completelyDifferentCode = true;',
      isValidLocation: true,
    },
  };

  const wrongFileTampered: ReviewFinding = {
    ...validFindingA,
    id: 'tampered-wrong-file',
    confidence: 'high',
    location: {
      ...validFindingA.location,
      fileId: 'file-nonexistent',
      filename: 'src/ledger/deletedModule.ts',
      isValidLocation: true,
    },
  };

  const batch = verifyReviewFindingsIntegrity(
    [validFindingA, outOfBoundsTampered, staleSnippetTampered, wrongFileTampered],
    [fileA, fileB]
  );

  assert.equal(batch.length, 4, 'All findings in the review are preserved');

  // Valid finding remains untouched and verified
  assert.equal(batch[0].id, validFindingA.id);
  assert.equal(batch[0].location.isValidLocation, true);
  assert.equal(batch[0].location.locationReason, 'verified');
  assert.equal(batch[0].location.startLine, validFindingA.location.startLine);

  // Out-of-bounds finding is quarantined without clamping startLine
  assert.equal(batch[1].location.isValidLocation, false);
  assert.equal(batch[1].location.locationReason, 'out_of_bounds');
  assert.equal(batch[1].location.startLine, 99, 'Invalid line number must not be clamped to 33');
  assert.equal(batch[1].location.rawSnippet, '');
  assert.equal(batch[1].confidence, 'low');

  // Stale snippet finding is quarantined as source_changed
  assert.equal(batch[2].location.isValidLocation, false);
  assert.equal(batch[2].location.locationReason, 'source_changed');
  assert.equal(batch[2].location.rawSnippet, '');
  assert.equal(batch[2].confidence, 'low');

  // Wrong-file finding is quarantined as wrong_file
  assert.equal(batch[3].location.isValidLocation, false);
  assert.equal(batch[3].location.locationReason, 'wrong_file');
  assert.equal(batch[3].location.rawSnippet, '');
  assert.equal(batch[3].confidence, 'low');
});

test('14. Controlled 5-case release-readiness sample: vulnerable SQL, safe parameterized SQL, OOB loop, weak error handling, and harmless file', async () => {
  // File 1: Contains cases 1..4 at deterministic line numbers (23 lines total)
  const controlledAuditFile: SourceFileRecord = {
    id: 'ctrl-file-1',
    filename: 'src/services/accountReconciliation.ts',
    language: 'typescript',
    changeStatus: 'modified',
    lineCount: 23,
    content: [
      'export async function reconcileAccounts(db: any, tenantId: string, batchIds: string[]) {', // L1
      '  // Case 1: Deliberately vulnerable SQL query (interpolation)',                         // L2
      '  const unsafeSql = `SELECT * FROM accounts WHERE tenant_id = \'${tenantId}\'`;',        // L3
      '  const unsafeRows = await db.query(unsafeSql);',                                        // L4
      '',                                                                                       // L5
      '  // Case 2: Safe parameterized SQL query (must NOT trigger PG-SEC-001)',                // L6
      '  const safeSql = "SELECT * FROM accounts WHERE tenant_id = $1 AND active = $2";',       // L7
      '  const safeRows = await db.query(safeSql, [tenantId, true]);',                          // L8
      '',                                                                                       // L9
      '  // Case 3: Out-of-bounds loop (i <= batchIds.length)',                                 // L10
      '  const inspected: string[] = [];',                                                      // L11
      '  for (let i = 0; i <= batchIds.length; i++) {',                                         // L12
      '    inspected.push(batchIds[i].trim());',                                                // L13
      '  }',                                                                                    // L14
      '',                                                                                       // L15
      '  // Case 4: Missing/weak error handling (silent catch swallowing)',                     // L16
      '  try {',                                                                                // L17
      '    await db.commitReconciliation(tenantId, inspected.length);',                         // L18
      '  } catch (err) {',                                                                      // L19
      '    // ignored',                                                                         // L20
      '  }',                                                                                    // L21
      '  return unsafeRows.length + safeRows.length;',                                          // L22
      '}',                                                                                      // L23
    ].join('\n'),
  };

  // File 2: Case 5 — Harmless utility file (11 lines total) that must generate 0 findings
  const harmlessUtilityFile: SourceFileRecord = {
    id: 'ctrl-file-2',
    filename: 'src/utils/currencyFormatter.ts',
    language: 'typescript',
    changeStatus: 'added',
    lineCount: 11,
    content: [
      'export function formatCentsToUsd(cents: number): string {',
      '  if (!Number.isFinite(cents)) {',
      '    return "$0.00";',
      '  }',
      '  const dollars = (cents / 100).toFixed(2);',
      '  return `$${dollars}`;',
      '}',
      '',
      'export function clampBasisPoints(bps: number): number {',
      '  return Math.max(0, Math.min(10000, Math.round(bps)));',
      '}',
    ].join('\n'),
  };

  const pipelineRes = await executeReviewPipeline(
    {
      title: 'Controlled 5-Case Verification Sample',
      objective: 'Verify vulnerable SQL, safe parameterized SQL, OOB loop, weak catch, and harmless file',
      focusAreas: ['security', 'correctness', 'error-handling', 'boundary'],
      files: [controlledAuditFile, harmlessUtilityFile],
      analysisMode: 'static-only',
    },
    { requestId: 'req-controlled-5-case', invokeAiModel: null }
  );

  assert.equal(pipelineRes.ok, true, 'Controlled review pipeline must succeed');
  if (!pipelineRes.ok) return;

  const findings = pipelineRes.review.findings;

  // Verify exact 3 true positives and 0 false positives
  assert.equal(
    findings.length,
    3,
    `Expected exactly 3 findings (vulnerable SQL on L3-4, OOB loop on L12-14, silent catch on L19-21), got ${findings.length}`
  );

  // Case 1: Vulnerable SQL query on Lines 3-4
  const sqlFinding = findings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001');
  assert.ok(sqlFinding, 'Must detect vulnerable SQL interpolation (PG-SEC-001)');
  assert.equal(sqlFinding.location.filename, 'src/services/accountReconciliation.ts');
  assert.equal(sqlFinding.location.startLine, 3);
  assert.equal(sqlFinding.location.endLine, 4);
  assert.equal(sqlFinding.location.isValidLocation, true);
  assert.equal(sqlFinding.location.locationReason, 'verified');

  // Case 2: Safe parameterized query on Lines 7-8 must NOT generate any finding
  const safeSqlFalsePositive = findings.find(
    (f) =>
      f.location.filename === 'src/services/accountReconciliation.ts' &&
      f.location.startLine <= 8 &&
      f.location.endLine >= 7
  );
  assert.equal(safeSqlFalsePositive, undefined, 'Safe parameterized SQL on L7-L8 must not generate a false positive');

  // Case 3: Out-of-bounds loop on Lines 12-14
  const oobFinding = findings.find((f) => f.staticCorroboration?.ruleId === 'PG-BND-003');
  assert.ok(oobFinding, 'Must detect off-by-one loop condition (PG-BND-003)');
  assert.equal(oobFinding.location.filename, 'src/services/accountReconciliation.ts');
  assert.equal(oobFinding.location.startLine, 12);
  assert.equal(oobFinding.location.endLine, 14);
  assert.equal(oobFinding.location.isValidLocation, true);
  assert.equal(oobFinding.location.locationReason, 'verified');

  // Case 4: Weak/silent error handling on Lines 19-21
  const catchFinding = findings.find((f) => f.staticCorroboration?.ruleId === 'PG-ERR-004');
  assert.ok(catchFinding, 'Must detect silent catch block (PG-ERR-004)');
  assert.equal(catchFinding.location.filename, 'src/services/accountReconciliation.ts');
  assert.equal(catchFinding.location.startLine, 19);
  assert.equal(catchFinding.location.endLine, 21);
  assert.equal(catchFinding.location.isValidLocation, true);
  assert.equal(catchFinding.location.locationReason, 'verified');

  // Case 5: Harmless utility file must have 0 findings
  const harmlessFindings = findings.filter(
    (f) => f.location.filename === 'src/utils/currencyFormatter.ts'
  );
  assert.equal(harmlessFindings.length, 0, 'Harmless utility file must generate 0 findings');
});

test('15. PG-ERR-004 error-handling rule accuracy (multiline JS/TS/Python, comments vs genuine logging/propagation) and resolveServerPort validation', () => {
  // 15a. TypeScript file with both silent catch blocks (must flag) and genuine logging/rethrowing catch blocks with comments (must NOT flag)
  const tsCatchFileContent = [
    'export async function processJobs(jobs: Array<() => Promise<void>>, logger: any) {', // L1
    '  // 1. Single-line empty catch (MUST FLAG L3-L3)',                                   // L2
    '  try { await jobs[0](); } catch (e) {}',                                             // L3
    '',                                                                                    // L4
    '  // 2. Multiline catch with multiple comments & block comment (MUST FLAG L6-L10)',   // L5
    '  try {',                                                                             // L6
    '    await jobs[1]();',                                                                // L7
    '  } catch {',                                                                         // L8
    '    // first comment line',                                                           // L9
    '    /* block comment line */',                                                        // L10
    '  }',                                                                                 // L11
    '',                                                                                    // L12
    '  // 3. Catch with comment AND genuine logger.error (MUST NOT FLAG)',                 // L13
    '  try {',                                                                             // L14
    '    await jobs[2]();',                                                                // L15
    '  } catch (err) {',                                                                   // L16
    '    // Record operational failure before continuing',                                 // L17
    '    logger.error("Job 2 failed", { err });',                                          // L18
    '  }',                                                                                 // L19
    '',                                                                                    // L20
    '  // 4. Catch with comment AND rethrow (MUST NOT FLAG)',                              // L21
    '  try {',                                                                             // L22
    '    await jobs[3]();',                                                                // L23
    '  } catch (err) {',                                                                   // L24
    '    // Propagate domain exception',                                                   // L25
    '    throw err;',                                                                      // L26
    '  }',                                                                                 // L27
    '}',                                                                                   // L28
  ].join('\n');

  const tsCatchFile: SourceFileRecord = {
    id: 'err-ts-1',
    filename: 'src/workers/jobRunner.ts',
    language: 'typescript',
    changeStatus: 'modified',
    lineCount: 28,
    content: tsCatchFileContent,
  };

  const tsFindings = runStaticAnalysisOnFiles([tsCatchFile]).filter(
    (f) => f.staticCorroboration?.ruleId === 'PG-ERR-004'
  );
  assert.equal(
    tsFindings.length,
    2,
    `Expected exactly 2 PG-ERR-004 findings in jobRunner.ts (L3 and L8-11), got ${tsFindings.length}`
  );
  assert.equal(tsFindings[0].location.startLine, 3);
  assert.equal(tsFindings[0].location.endLine, 3);
  assert.equal(tsFindings[1].location.startLine, 8);
  assert.equal(tsFindings[1].location.endLine, 11);

  // 15b. Python file with single-line pass, multiline commented pass (must flag), and genuine logging/raising handlers (must NOT flag)
  const pyExceptContent = [
    'def sync_records(cursor, logger):',                               // L1
    '    try:',                                                        // L2
    '        cursor.Ping()',                                           // L3
    '    except Exception: pass',                                      // L4 (MUST FLAG L4-L4)
    '',                                                                // L5
    '    try:',                                                        // L6
    '        cursor.Sync()',                                           // L7
    '    except (ValueError, RuntimeError) as err:',                   // L8 (MUST FLAG L8-L10)
    '        # intentionally ignored during warmup',                   // L9
    '        pass',                                                    // L10
    '',                                                                // L11
    '    try:',                                                        // L12
    '        cursor.Commit()',                                         // L13
    '    except Exception as err:',                                    // L14 (MUST NOT FLAG)
    '        # log and re-raise',                                      // L15
    '        logger.exception("Commit failed: %s", err)',              // L16
    '        raise',                                                   // L17
  ].join('\n');

  const pyExceptFile: SourceFileRecord = {
    id: 'err-py-1',
    filename: 'workers/sync_worker.py',
    language: 'python',
    changeStatus: 'modified',
    lineCount: 17,
    content: pyExceptContent,
  };

  const pyFindings = runStaticAnalysisOnFiles([pyExceptFile]).filter(
    (f) => f.staticCorroboration?.ruleId === 'PG-ERR-004'
  );
  assert.equal(
    pyFindings.length,
    2,
    `Expected exactly 2 PG-ERR-004 findings in sync_worker.py (L4 and L8-10), got ${pyFindings.length}`
  );
  assert.equal(pyFindings[0].location.startLine, 4);
  assert.equal(pyFindings[0].location.endLine, 4);
  assert.equal(pyFindings[1].location.startLine, 8);
  assert.equal(pyFindings[1].location.endLine, 10);

  // 15c. Verify resolveServerPort respects valid PORT and falls back to 3000 when absent or invalid
  assert.equal(resolveServerPort(undefined), 3000);
  assert.equal(resolveServerPort(''), 3000);
  assert.equal(resolveServerPort('   '), 3000);
  assert.equal(resolveServerPort('invalid'), 3000);
  assert.equal(resolveServerPort('0'), 3000);
  assert.equal(resolveServerPort('-3000'), 3000);
  assert.equal(resolveServerPort('65536'), 3000);
  assert.equal(resolveServerPort('3000.5'), 3000);
  assert.equal(resolveServerPort('3099'), 3099);
  assert.equal(resolveServerPort(' 8080 '), 8080);
});


