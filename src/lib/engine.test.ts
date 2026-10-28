import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAndCorroborateFindings,
  runStaticAnalysisOnFiles,
  validateAndNormalizeFindingLocation,
} from './staticAnalyzer';
import {
  computePrecisionRecall,
  computeSeverityDistribution,
  filterFindings,
  matchFindingsToExpectedDefects,
} from './evaluationMath';
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

test('static analyzer detects SQL injection, hardcoded secret, off-by-one boundary, concurrency, and silent catch', () => {
  const findings = runStaticAnalysisOnFiles([sampleVulnFile]);
  assert.ok(findings.length >= 4, `Expected at least 4 findings, got ${findings.length}`);

  const ruleIds = findings.map((f) => f.staticCorroboration?.ruleId);
  assert.ok(ruleIds.includes('PG-SEC-001'), 'Should detect SQL injection');
  assert.ok(ruleIds.includes('PG-SEC-005'), 'Should detect hardcoded secret');
  assert.ok(ruleIds.includes('PG-BND-003'), 'Should detect off-by-one <= length loop');
  assert.ok(ruleIds.includes('PG-ERR-004'), 'Should detect silent catch block');
});

test('validateAndNormalizeFindingLocation flags out-of-bounds line numbers without highlighting nearby lines', () => {
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

test('mergeAndCorroborateFindings upgrades overlapping AI and Static findings to corroborated status', () => {
  const staticFindings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const sqlStatic = staticFindings.find((f) => f.staticCorroboration?.ruleId === 'PG-SEC-001')!;
  assert.ok(sqlStatic);

  const mockAiFinding: ReviewFinding = {
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

  const merged = mergeAndCorroborateFindings([sqlStatic], [mockAiFinding]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].analysisSource, 'corroborated');
  assert.equal(merged[0].staticCorroboration?.ruleId, 'PG-SEC-001');
});

test('computePrecisionRecall handles normal ratios and zero denominators explicitly', () => {
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
});

test('matchFindingsToExpectedDefects pairs findings within line tolerance and computes TP, FP, FN', () => {
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
});

test('filterFindings and computeSeverityDistribution accurately filter and summarize findings', () => {
  const findings = runStaticAnalysisOnFiles([sampleVulnFile]);
  const dist = computeSeverityDistribution(findings);
  assert.equal(dist.total, findings.length);
  assert.equal(dist.highestSeverity, 'critical');

  const onlyCritical = filterFindings(findings, {
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
