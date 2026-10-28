import {
  FindingCategory,
  FindingLocation,
  ReviewFinding,
  SeverityLevel,
  SourceFileRecord,
} from '../types/patchguard';

export const STATIC_ANALYZER_VERSION = 'pg-static-ast-1.4.2';

interface StaticRuleDefinition {
  ruleId: string;
  title: string;
  severity: SeverityLevel;
  category: FindingCategory;
  languages: Array<'typescript' | 'javascript' | 'python' | 'java' | 'sql'>;
  matcher: (lines: string[], fullText: string) => Array<{
    startLine: number;
    endLine: number;
    matchedPattern: string;
    explanation: string;
    potentialImpact: string;
    suggestedRemediation: string;
    remediationCode?: string;
  }>;
}

const STATIC_RULES: StaticRuleDefinition[] = [
  {
    ruleId: 'PG-SEC-001',
    title: 'Unsanitized SQL query interpolation allows arbitrary command injection',
    severity: 'critical',
    category: 'security',
    languages: ['typescript', 'javascript', 'python', 'java', 'sql'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hasSqlKeyword = /\b(SELECT|UPDATE|DELETE|INSERT\s+INTO|WHERE)\b/i.test(line);
        const hasInterpolation =
          /\$\{[^}]+\}/.test(line) ||
          /f["'][^"']*\{[^}]+\}/.test(line) ||
          /["']\s*\+\s*[a-zA-Z0-9_.]+\s*(\+|;|$)/.test(line) ||
          /%s/.test(line) && /\.execute\s*\(\s*f["']/.test(line);

        if (hasSqlKeyword && hasInterpolation) {
          hits.push({
            startLine: i + 1,
            endLine: Math.min(lines.length, i + 2),
            matchedPattern: line.trim(),
            explanation:
              'Query string is constructed dynamically by interpolating or concatenating runtime variables directly into SQL syntax rather than binding parameters.',
            potentialImpact:
              'An attacker controlling the interpolated input can break out of the intended predicate, bypass authentication/authorization filters, or read/modify arbitrary tables.',
            suggestedRemediation:
              'Replace string interpolation with parameterized placeholders ($1, ?, or :param) passed separately to the database driver.',
            remediationCode:
              '// Bind parameters separately from the SQL statement:\nawait db.query("SELECT * FROM accounts WHERE tenant_id = $1 AND status = $2", [tenantId, status]);',
          });
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-CONC-002',
    title: 'Non-atomic read-modify-write cycle across asynchronous boundary',
    severity: 'high',
    category: 'concurrency',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const windowLines = lines.slice(i, Math.min(lines.length, i + 10)).join('\n');
        const hasRead = /\b(getBalance|findUnique|findOne|fetchAccount|SELECT\s+balance|readState|getLock)\b/i.test(lines[i]);
        const hasUpdateLater = /\b(updateBalance|save|SET\s+balance|writeState|deduct|credit)\b/i.test(windowLines);
        const lacksTransactionOrLock = !/\b(FOR\s+UPDATE|transaction|mutex|synchronized|atomic|optimistic|version)\b/i.test(windowLines);

        if (hasRead && hasUpdateLater && lacksTransactionOrLock) {
          hits.push({
            startLine: i + 1,
            endLine: Math.min(lines.length, i + 6),
            matchedPattern: lines[i].trim(),
            explanation:
              'State is fetched before an asynchronous yield point and subsequently written back based on the in-memory value without row locking or compare-and-swap version checks.',
            potentialImpact:
              'Concurrent requests for the same entity can interleave between the read and write steps, causing lost updates, double-spending, or state corruption.',
            suggestedRemediation:
              'Wrap the read-modify-write sequence in an atomic database transaction with SELECT ... FOR UPDATE or enforce an atomic conditional UPDATE with a version/balance guard.',
            remediationCode:
              'await db.query(\n  "UPDATE accounts SET balance = balance - $1, version = version + 1 WHERE id = $2 AND balance >= $1",\n  [amount, accountId]\n);',
          });
          i += 5;
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-BND-003',
    title: 'Inclusive loop upper bound (<= length) causes out-of-bounds index access',
    severity: 'high',
    category: 'boundary',
    languages: ['typescript', 'javascript', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/for\s*\([^;]+;\s*[a-zA-Z0-9_]+\s*<=\s*[a-zA-Z0-9_.]+\.(length|size\(\))\s*;/.test(line)) {
          hits.push({
            startLine: i + 1,
            endLine: Math.min(lines.length, i + 3),
            matchedPattern: line.trim(),
            explanation:
              'The loop termination condition uses the inclusive `<=` operator against a zero-indexed collection length or size.',
            potentialImpact:
              'On the final iteration, the index equals `collection.length`, reading `undefined` in JavaScript/TypeScript or throwing `IndexOutOfBoundsException` in Java.',
            suggestedRemediation:
              'Use a strict `<` comparison against `.length` / `.size()`, or iterate directly over elements with `for...of`.',
            remediationCode: 'for (let i = 0; i < items.length; i++) {\n  processItem(items[i]);\n}',
          });
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-ERR-004',
    title: 'Swallowed exception or unawaited promise inside catch/error handler',
    severity: 'medium',
    category: 'error-handling',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextTwo = lines.slice(i, Math.min(lines.length, i + 4)).join(' ');
        const isSilentCatch =
          /catch\s*\([^)]*\)\s*\{\s*(\/\/.*)?\s*\}/.test(nextTwo) ||
          /except(\s+[A-Za-z0-9_]+)?\s*:\s*pass\b/.test(nextTwo);

        if (isSilentCatch) {
          hits.push({
            startLine: i + 1,
            endLine: Math.min(lines.length, i + 3),
            matchedPattern: line.trim(),
            explanation:
              'Exception block catches runtime failures and discards them without structured logging, metric emission, or error propagation.',
            potentialImpact:
              'Partial failures leave downstream callers assuming the operation succeeded, masking production incidents and corrupting caller control flow.',
            suggestedRemediation:
              'Log the error with contextual identifiers and either rethrow a typed domain error or return an explicit failure result.',
          });
          i += 2;
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-SEC-005',
    title: 'Hardcoded secret or bearer credential literal in source code',
    severity: 'critical',
    category: 'security',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          /(api[_-]?key|secret[_-]?key|jwt[_-]?secret|password|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{12,}["']/i.test(
            line
          )
        ) {
          hits.push({
            startLine: i + 1,
            endLine: i + 1,
            matchedPattern: line.trim(),
            explanation:
              'A credential or cryptographic secret is assigned as a string literal directly in source control.',
            potentialImpact:
              'Anyone with read access to the repository or build artifacts can extract the secret and impersonate the service or forge tokens.',
            suggestedRemediation:
              'Load secrets exclusively from validated environment variables or a secret manager at startup, and rotate the exposed credential immediately.',
          });
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-AUTH-006',
    title: 'Missing tenant or ownership authorization check before record mutation',
    severity: 'high',
    category: 'security',
    languages: ['typescript', 'javascript', 'python', 'java', 'sql'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|#|--)/.test(line)) continue;
        const codeOnlyBlock = lines
          .slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
          .filter((l) => !/^\s*(\/\/|#|--)/.test(l))
          .join('\n');
        const isDirectIdMutation =
          /\b(deleteById|updateById|DELETE\s+FROM\s+\w+\s+WHERE\s+id\s*=)\b/i.test(line);
        const hasAuthCheck = /\b(tenantId|tenant_id|ownerId|owner_id|userId|user_id|authorize|canAccess)\b/i.test(
          codeOnlyBlock
        );
        if (isDirectIdMutation && !hasAuthCheck) {
          hits.push({
            startLine: i + 1,
            endLine: Math.min(lines.length, i + 2),
            matchedPattern: line.trim(),
            explanation:
              'A destructive or mutating operation targets a primary key identifier directly without scoping the query to the authenticated principal or tenant.',
            potentialImpact:
              'Insecure Direct Object Reference (IDOR): an authenticated user can mutate or delete records belonging to another tenant by supplying a foreign ID.',
            suggestedRemediation:
              'Include the authenticated tenant_id / owner_id in the WHERE clause or verify resource ownership prior to executing the mutation.',
          });
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-PERF-007',
    title: 'Sequential network or database query executed inside loop (N+1 query pattern)',
    severity: 'medium',
    category: 'performance',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const isLoop = /^\s*(for\s*\(|for\s+[a-zA-Z0-9_]+\s+in\b|while\s*\()/.test(lines[i]);
        if (isLoop) {
          const loopBody = lines.slice(i + 1, Math.min(lines.length, i + 7)).join('\n');
          if (/\b(await\s+(db|client|repo|fetch|axios|prisma)|cursor\.execute)\b/.test(loopBody)) {
            hits.push({
              startLine: i + 1,
              endLine: Math.min(lines.length, i + 5),
              matchedPattern: lines[i].trim(),
              explanation:
                'An asynchronous I/O or database query is awaited sequentially on each iteration of a collection loop.',
              potentialImpact:
                'Latency scales linearly with input cardinality (O(N) round-trips), risking connection pool exhaustion and request timeouts on large payloads.',
              suggestedRemediation:
                'Batch-fetch records before the loop using a single `WHERE id IN (...)` query or execute independent requests with bounded concurrency.',
            });
            i += 4;
          }
        }
      }
      return hits;
    },
  },
];

export function validateAndNormalizeFindingLocation(
  file: SourceFileRecord,
  rawStartLine: number,
  rawEndLine?: number
): FindingLocation {
  const lines = file.content.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Number.isInteger(rawStartLine) ? rawStartLine : -1;
  const end = Number.isInteger(rawEndLine) && (rawEndLine as number) >= start ? (rawEndLine as number) : start;

  if (start < 1 || start > totalLines || end < 1 || end > totalLines) {
    return {
      fileId: file.id,
      filename: file.filename,
      startLine: rawStartLine,
      endLine: rawEndLine ?? rawStartLine,
      isValidLocation: false,
      rawSnippet: '',
      validationNote: `Referenced line range L${rawStartLine}${
        rawEndLine && rawEndLine !== rawStartLine ? `–L${rawEndLine}` : ''
      } is outside valid bounds (1–${totalLines}) for ${file.filename}. PatchGuard suppresses approximate line highlighting to preserve evidence integrity.`,
    };
  }

  const snippetLines = lines.slice(start - 1, end);
  return {
    fileId: file.id,
    filename: file.filename,
    startLine: start,
    endLine: end,
    isValidLocation: true,
    rawSnippet: snippetLines.join('\n'),
  };
}

export function runStaticAnalysisOnFiles(
  files: SourceFileRecord[],
  focusAreas?: FindingCategory[]
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const now = new Date().toISOString();

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const rule of STATIC_RULES) {
      if (!rule.languages.includes(file.language)) continue;

      const matches = rule.matcher(lines, file.content);
      for (let idx = 0; idx < matches.length; idx++) {
        const m = matches[idx];
        const location = validateAndNormalizeFindingLocation(file, m.startLine, m.endLine);
        const prioritized =
          focusAreas && focusAreas.length > 0 && focusAreas.includes(rule.category);

        findings.push({
          id: `fnd-static-${rule.ruleId.toLowerCase()}-${file.id}-${m.startLine}-${idx}`,
          title: rule.title,
          severity: rule.severity,
          category: rule.category,
          status: 'unreviewed',
          analysisSource: 'static-pattern',
          confidence: 'high',
          uncertaintyNote: prioritized
            ? 'Deterministic pattern match aligned with selected review focus area.'
            : 'Deterministic syntax/pattern match; verify surrounding call-site invariants.',
          location,
          explanation: m.explanation,
          potentialImpact: m.potentialImpact,
          suggestedRemediation: m.suggestedRemediation,
          remediationCode: m.remediationCode,
          staticCorroboration: {
            ruleId: rule.ruleId,
            engineName: `PatchGuard Static Analyzer (${STATIC_ANALYZER_VERSION})`,
            matchedPattern: m.matchedPattern,
            deterministicConfidence: 'high',
          },
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  return findings;
}

export function mergeAndCorroborateFindings(
  staticFindings: ReviewFinding[],
  aiFindings: ReviewFinding[]
): ReviewFinding[] {
  const merged: ReviewFinding[] = [];
  const consumedAiIds = new Set<string>();

  for (const sf of staticFindings) {
    const matchingAi = aiFindings.find((af) => {
      if (consumedAiIds.has(af.id)) return false;
      if (af.location.filename !== sf.location.filename) return false;
      if (!af.location.isValidLocation || !sf.location.isValidLocation) return false;
      const lineDiff = Math.abs(af.location.startLine - sf.location.startLine);
      const overlaps =
        af.location.startLine <= sf.location.endLine + 3 &&
        af.location.endLine >= sf.location.startLine - 3;
      return (overlaps || lineDiff <= 3) && af.category === sf.category;
    });

    if (matchingAi) {
      consumedAiIds.add(matchingAi.id);
      merged.push({
        ...matchingAi,
        id: `fnd-corroborated-${sf.staticCorroboration?.ruleId.toLowerCase() || 'rule'}-${sf.location.startLine}`,
        severity: compareSeverity(sf.severity, matchingAi.severity) <= 0 ? sf.severity : matchingAi.severity,
        analysisSource: 'corroborated',
        confidence: 'high',
        uncertaintyNote:
          'Independently corroborated by both PatchGuard Static Analyzer and Gemini AI code reasoning.',
        staticCorroboration: sf.staticCorroboration,
        remediationCode: matchingAi.remediationCode || sf.remediationCode,
      });
    } else {
      merged.push(sf);
    }
  }

  for (const af of aiFindings) {
    if (!consumedAiIds.has(af.id)) {
      merged.push(af);
    }
  }

  return sortFindingsBySeverity(merged);
}

const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function compareSeverity(a: SeverityLevel, b: SeverityLevel): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

export function sortFindingsBySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = compareSeverity(a.severity, b.severity);
    if (sevDiff !== 0) return sevDiff;
    return a.location.startLine - b.location.startLine;
  });
}
