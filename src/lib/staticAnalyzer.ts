import type {
  FindingCategory,
  FindingLocation,
  LocationValidationReason,
  ReviewFinding,
  SeverityLevel,
  SourceFileRecord,
} from '../types/patchguard.ts';

export const STATIC_ANALYZER_VERSION = 'pg-static-ast-1.4.2';

/**
 * Computes a deterministic 64-bit hex digest (dual 32-bit FNV-1a + DJB2) of LF-normalized source code.
 * Runs synchronously in both Node.js and browser environments to bind findings to an exact source version.
 */
export function computeSourceContentHash(content: string): string {
  const normalized = (content || '').replace(/\r\n/g, '\n');
  let h1 = 0x811c9dc5;
  let h2 = 0x00001505;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 = (Math.imul(h2, 33) ^ ch) >>> 0;
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `pg-sha-${part1}${part2}-${normalized.length}`;
}

function normalizePathForComparison(p: string): string {
  return (p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Strictly resolves a target SourceFileRecord from a list of reviewed files.
 * Never falls back to `files[0]` when the requested fileId or filename does not match.
 */
export function resolveTargetSourceFile(
  files: SourceFileRecord[],
  requestedFileId?: string,
  requestedFilename?: string
): SourceFileRecord | null {
  if (!Array.isArray(files) || files.length === 0) return null;

  const cleanId = (requestedFileId || '').trim();
  const cleanName = normalizePathForComparison(requestedFilename || '');

  // If both fileId and filename are provided, require them not to conflict
  if (cleanId) {
    const byId = files.find((f) => f.id === cleanId);
    if (byId) {
      if (!cleanName || normalizePathForComparison(byId.filename) === cleanName) {
        return byId;
      }
      // fileId matched one file, but filename explicitly named a different file
      return null;
    }
  }

  if (!cleanName) {
    return null;
  }

  // Exact normalized path match
  const exactMatches = files.filter(
    (f) => normalizePathForComparison(f.filename) === cleanName
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  // Case-insensitive exact path match (only if unambiguous)
  const lowerMatches = files.filter(
    (f) => normalizePathForComparison(f.filename).toLowerCase() === cleanName.toLowerCase()
  );
  if (lowerMatches.length === 1) {
    return lowerMatches[0];
  }

  // Suffix/basename match ONLY if the caller passed a bare filename without directory conflict and it uniquely matches one file
  if (!cleanName.includes('/')) {
    const basenameMatches = files.filter((f) => {
      const norm = normalizePathForComparison(f.filename);
      const base = norm.split('/').pop() || norm;
      return base === cleanName;
    });
    if (basenameMatches.length === 1) {
      return basenameMatches[0];
    }
  }

  return null;
}

export function createQuarantinedFindingLocation(params: {
  fileId?: string;
  filename?: string;
  rawStartLine?: number;
  rawEndLine?: number;
  reason: LocationValidationReason;
  validationNote: string;
}): FindingLocation {
  const start =
    typeof params.rawStartLine === 'number' && Number.isFinite(params.rawStartLine)
      ? params.rawStartLine
      : 0;
  const end =
    typeof params.rawEndLine === 'number' && Number.isFinite(params.rawEndLine)
      ? params.rawEndLine
      : start;

  return {
    fileId: params.fileId || 'unmatched-file',
    filename: (params.filename || '').trim() || 'unmatched-file',
    startLine: start,
    endLine: end,
    isValidLocation: false,
    rawSnippet: '',
    locationReason: params.reason,
    validationNote: params.validationNote,
  };
}

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
    title: 'Unsanitized SQL query interpolation enables SQL injection (CWE-89)',
    severity: 'critical',
    category: 'security',
    languages: ['typescript', 'javascript', 'python', 'java', 'sql'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|#|--|\/\*|\*)/.test(line)) continue;
        // Exclude logging and error construction statements that mention SQL verbs in prose
        if (
          /\b(console\.(log|warn|error|info|debug)|logger\.(log|warn|error|info|debug)|throw\s+new\s+\w*Error)\s*\(/.test(
            line
          )
        ) {
          continue;
        }

        // Inspect single line, or a multi-line template literal window (up to 6 lines) if an unclosed backtick starts a SQL query
        let windowText = line;
        let windowEndIdx = i;
        const backtickCount = (line.match(/`/g) || []).length;
        if (backtickCount === 1) {
          for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
            windowText += '\n' + lines[k];
            windowEndIdx = k;
            if (lines[k].includes('`')) break;
          }
        }

        // Require actual SQL statement structure beginning inside a string literal,
        // avoiding false positives on casual English prose like `Please select an item from ${list}`
        const hasSqlQueryLiteral =
          /(?:f?[`'"]\s*)(?:SELECT\s+[\w*,.\s()]+\s+FROM\s+[a-zA-Z0-9_."`]+|UPDATE\s+[a-zA-Z0-9_."`]+\s+SET\s+[a-zA-Z0-9_."`]+\s*=|DELETE\s+FROM\s+[a-zA-Z0-9_."`]+|INSERT\s+INTO\s+[a-zA-Z0-9_."`]+)/i.test(
            windowText
          );

        const hasInterpolation =
          /\$\{[^}]+\}/.test(windowText) ||
          /f["'][^"']*\{[^}]+\}/.test(windowText) ||
          /["']\s*\+\s*[a-zA-Z0-9_.]+\s*(\+|;|\)|$)/.test(windowText) ||
          (/%s/.test(windowText) && /\.execute\s*\(\s*f["']/.test(windowText));

        if (hasSqlQueryLiteral && hasInterpolation) {
          // Include the immediately following execution line only if it exists and executes this query variable
          const nextLine = windowEndIdx + 1 < lines.length ? lines[windowEndIdx + 1] : '';
          const spansNextLine =
            windowEndIdx === i &&
            windowEndIdx + 1 < lines.length &&
            /\b(query|execute|getBalance|raw)\s*\(/.test(nextLine);
          const finalEndIdx = spansNextLine ? windowEndIdx + 1 : windowEndIdx;

          hits.push({
            startLine: i + 1,
            endLine: finalEndIdx + 1,
            matchedPattern: line.trim(),
            explanation:
              'SQL statement string is constructed dynamically by interpolating or concatenating runtime variables directly into SQL query syntax rather than using bound parameters.',
            potentialImpact:
              'SQL Injection (CWE-89): an attacker controlling the interpolated input can alter SQL predicate logic, bypass tenant/authentication filters, or read and modify arbitrary database records.',
            suggestedRemediation:
              'Replace string interpolation with parameterized query placeholders ($1, ?, or :param) passed separately to the database driver.',
            remediationCode:
              '// Bind parameters separately from the SQL statement:\nawait db.query("SELECT * FROM accounts WHERE tenant_id = $1 AND status = $2", [tenantId, status]);',
          });
          i = finalEndIdx;
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
        if (/^\s*(\/\/|#|--)/.test(lines[i])) continue;
        const hasRead =
          /\b(getBalance|findUnique|findOne|fetchAccount|SELECT\s+balance|readState|getLock)\b/i.test(
            lines[i]
          );
        if (!hasRead) continue;

        const maxWindowEnd = Math.min(lines.length - 1, i + 15);
        let writeLineIdx = -1;
        for (let j = i + 1; j <= maxWindowEnd; j++) {
          if (
            /\b(updateBalance|save|SET\s+balance|writeState|deduct|credit)\b/i.test(
              lines[j]
            )
          ) {
            writeLineIdx = j;
            break;
          }
        }

        if (writeLineIdx !== -1) {
          const windowLines = lines.slice(i, writeLineIdx + 1).join('\n');
          const lacksTransactionOrLock =
            !/\b(FOR\s+UPDATE|transaction|mutex|synchronized|atomic|optimistic|version)\b/i.test(
              windowLines
            );

          if (lacksTransactionOrLock) {
            hits.push({
              startLine: i + 1,
              endLine: writeLineIdx + 1,
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
            i = writeLineIdx;
          }
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
        if (
          /for\s*\([^;]+;\s*[a-zA-Z0-9_]+\s*<=\s*[a-zA-Z0-9_.]+\.(length|size\(\))\s*;/.test(
            line
          )
        ) {
          let endIdx = i;
          for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
            endIdx = j;
            if (/^\s*\}/.test(lines[j])) break;
          }
          hits.push({
            startLine: i + 1,
            endLine: endIdx + 1,
            matchedPattern: line.trim(),
            explanation:
              'The loop termination condition uses the inclusive `<=` operator against a zero-indexed collection length or size.',
            potentialImpact:
              'On the final iteration, the index equals `collection.length`, reading `undefined` in JavaScript/TypeScript or throwing `IndexOutOfBoundsException` in Java.',
            suggestedRemediation:
              'Use a strict `<` comparison against `.length` / `.size()`, or iterate directly over elements with `for...of`.',
            remediationCode:
              'for (let i = 0; i < items.length; i++) {\n  processItem(items[i]);\n}',
          });
        }
      }
      return hits;
    },
  },
  {
    ruleId: 'PG-ERR-004',
    title: 'Silent exception handler swallows errors without logging or propagation',
    severity: 'medium',
    category: 'error-handling',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|#|--|\/\*|\*)/.test(line)) continue;

        // 1. JS / TS / Java catch block: catch (err) { ... } or catch { ... }
        const catchMatch = line.match(/\bcatch\s*(?:\([^)]*\))?\s*\{(.*)$/);
        if (catchMatch) {
          let braceDepth = 1;
          let inBlockComment = false;
          let inSingleQuote = false;
          let inDoubleQuote = false;
          let inTemplate = false;
          let executableChars = '';
          let endLineIdx = -1;

          const maxScanEnd = Math.min(lines.length - 1, i + 15);
          for (let k = i; k <= maxScanEnd; k++) {
            const segment = k === i ? catchMatch[1] : lines[k];
            for (let c = 0; c < segment.length; c++) {
              const ch = segment[c];
              const next = segment[c + 1] || '';

              if (inBlockComment) {
                if (ch === '*' && next === '/') {
                  inBlockComment = false;
                  c++;
                }
                continue;
              }
              if (inSingleQuote) {
                if (ch === '\\') {
                  executableChars += ch + next;
                  c++;
                  continue;
                }
                if (ch === "'") inSingleQuote = false;
                executableChars += ch;
                continue;
              }
              if (inDoubleQuote) {
                if (ch === '\\') {
                  executableChars += ch + next;
                  c++;
                  continue;
                }
                if (ch === '"') inDoubleQuote = false;
                executableChars += ch;
                continue;
              }
              if (inTemplate) {
                if (ch === '\\') {
                  executableChars += ch + next;
                  c++;
                  continue;
                }
                if (ch === '`') inTemplate = false;
                executableChars += ch;
                continue;
              }

              if (ch === '/' && next === '*') {
                inBlockComment = true;
                c++;
                continue;
              }
              if (ch === '/' && next === '/') {
                break; // Remainder of line k is a single-line comment
              }
              if (ch === "'") {
                inSingleQuote = true;
                executableChars += ch;
                continue;
              }
              if (ch === '"') {
                inDoubleQuote = true;
                executableChars += ch;
                continue;
              }
              if (ch === '`') {
                inTemplate = true;
                executableChars += ch;
                continue;
              }
              if (ch === '{') {
                braceDepth++;
                executableChars += ch;
                continue;
              }
              if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) {
                  endLineIdx = k;
                  break;
                }
                executableChars += ch;
                continue;
              }
              executableChars += ch;
            }
            if (endLineIdx !== -1) break;
          }

          if (
            endLineIdx !== -1 &&
            !inBlockComment &&
            executableChars.replace(/[\s;]/g, '') === ''
          ) {
            hits.push({
              startLine: i + 1,
              endLine: endLineIdx + 1,
              matchedPattern: line.trim(),
              explanation:
                'Exception handler catches runtime errors and discards them with an empty or comment-only body without logging, rethrowing, or returning an error state.',
              potentialImpact:
                'Errors inside the try block are silently ignored, allowing execution to continue with potentially incomplete state and making operational failures harder to diagnose.',
              suggestedRemediation:
                'Log the caught exception with contextual identifiers and either rethrow a domain error or return an explicit fallback/failure result.',
            });
            i = endLineIdx;
          }
          continue;
        }

        // 2. Python single-line except ...: pass / ...
        if (
          /^\s*except(?:\s+[A-Za-z0-9_.,()\s]+)?\s*:\s*(?:pass\b|\.\.\.(?!\.))\s*(?:#.*)?$/.test(
            line
          )
        ) {
          hits.push({
            startLine: i + 1,
            endLine: i + 1,
            matchedPattern: line.trim(),
            explanation:
              'Exception handler catches runtime errors and discards them with a bare pass or ellipsis statement without logging or error propagation.',
            potentialImpact:
              'Errors inside the try block are silently ignored, allowing execution to continue with potentially incomplete state and making operational failures harder to diagnose.',
            suggestedRemediation:
              'Log the caught exception with contextual identifiers and either re-raise or return an explicit failure result.',
          });
          continue;
        }

        // 3. Python multiline except ...: block containing only comments and pass/...
        const pyExceptMatch = line.match(
          /^(\s*)except(?:\s+[A-Za-z0-9_.,()\s]+)?\s*:\s*(?:#.*)?$/
        );
        if (pyExceptMatch) {
          const exceptIndent = pyExceptMatch[1].length;
          const bodyStatements: string[] = [];
          let lastBodyLineIdx = i;
          const maxPyEnd = Math.min(lines.length - 1, i + 15);

          for (let k = i + 1; k <= maxPyEnd; k++) {
            const rawLine = lines[k];
            if (/^\s*(?:#.*)?$/.test(rawLine)) continue;
            const indent = (rawLine.match(/^(\s*)/)?.[1] ?? '').length;
            if (indent <= exceptIndent) break;
            const stmt = rawLine.replace(/#.*$/, '').trim();
            bodyStatements.push(stmt);
            lastBodyLineIdx = k;
          }

          if (
            bodyStatements.length > 0 &&
            bodyStatements.every((stmt) => stmt === 'pass' || stmt === '...')
          ) {
            hits.push({
              startLine: i + 1,
              endLine: lastBodyLineIdx + 1,
              matchedPattern: line.trim(),
              explanation:
                'Exception handler catches runtime errors and discards them with a bare pass statement without logging or error propagation.',
              potentialImpact:
                'Errors inside the try block are silently ignored, allowing execution to continue with potentially incomplete state and making operational failures harder to diagnose.',
              suggestedRemediation:
                'Log the caught exception with contextual identifiers and either re-raise or return an explicit failure result.',
            });
            i = lastBodyLineIdx;
          }
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
        if (/^\s*(\/\/|#|--)/.test(line)) continue;
        const secretMatch = line.match(
          /(api[_-]?key|[a-z0-9_]*secret(?:[_-]?key)?|password|private[_-]?key|bearer[_-]?token)\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{12,})["']/i
        );
        if (secretMatch) {
          const literalValue = secretMatch[2];
          const isPlaceholder =
            /^(YOUR_|MY_|CHANGE_ME|REPLACE_ME|EXAMPLE_|TEST_|DUMMY_|PLACEHOLDER|REDACTED)/i.test(
              literalValue
            );
          if (!isPlaceholder) {
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
        const hasAuthCheck =
          /\b(tenantId|tenant_id|ownerId|owner_id|userId|user_id|authorize|canAccess)\b/i.test(
            codeOnlyBlock
          );
        if (isDirectIdMutation && !hasAuthCheck) {
          hits.push({
            startLine: i + 1,
            endLine: i + 1,
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
        const line = lines[i];
        const isPyLoop = /^(\s*)(?:for\s+[a-zA-Z0-9_,\s]+\s+in\b.*|while\b.*):\s*(?:#.*)?$/.test(
          line
        );
        const isBraceLoop = /^\s*(?:for\s*\(|while\s*\()/.test(line);
        if (!isPyLoop && !isBraceLoop) continue;

        const maxLoopEnd = Math.min(lines.length - 1, i + 8);
        const bodyLines: string[] = [];
        let endLineIdx = i;

        if (isPyLoop) {
          const loopIndent = (line.match(/^(\s*)/)?.[1] ?? '').length;
          for (let k = i + 1; k <= maxLoopEnd; k++) {
            const rawLine = lines[k];
            if (/^\s*(?:#.*)?$/.test(rawLine)) continue;
            const indent = (rawLine.match(/^(\s*)/)?.[1] ?? '').length;
            if (indent <= loopIndent) break;
            bodyLines.push(rawLine);
            endLineIdx = k;
          }
        } else {
          for (let k = i + 1; k <= maxLoopEnd; k++) {
            bodyLines.push(lines[k]);
            endLineIdx = k;
            if (/^\s*\}/.test(lines[k])) break;
          }
        }

        const loopBody = bodyLines.join('\n');
        if (/\b(await\s+(db|client|repo|fetch|axios|prisma)|cursor\.execute)\b/.test(loopBody)) {
          hits.push({
            startLine: i + 1,
            endLine: endLineIdx + 1,
            matchedPattern: line.trim(),
            explanation:
              'An asynchronous I/O or database query is awaited sequentially on each iteration of a collection loop.',
            potentialImpact:
              'Latency scales linearly with input cardinality (O(N) round-trips), risking connection pool exhaustion and request timeouts on large payloads.',
            suggestedRemediation:
              'Batch-fetch records before the loop using a single `WHERE id IN (...)` query or execute independent requests with bounded concurrency.',
          });
          i = endLineIdx;
        }
      }
      return hits;
    },
  },
];

/**
 * Validates a 1-indexed line range against a specific SourceFileRecord.
 * Never clamps out-of-bounds line numbers to nearest valid lines, and never invents replacement locations.
 */
export function validateAndNormalizeFindingLocation(
  file: SourceFileRecord,
  rawStartLine: number | undefined | null,
  rawEndLine?: number | undefined | null
): FindingLocation {
  const normalizedContent = (file.content || '').replace(/\r\n/g, '\n');
  const lines = normalizedContent.split('\n');
  const totalLines = lines.length;
  const contentHash = file.contentHash || computeSourceContentHash(normalizedContent);

  const hasValidStartInt =
    typeof rawStartLine === 'number' &&
    Number.isInteger(rawStartLine) &&
    Number.isFinite(rawStartLine);

  const effectiveRawEnd =
    rawEndLine === undefined || rawEndLine === null ? rawStartLine : rawEndLine;
  const hasValidEndInt =
    typeof effectiveRawEnd === 'number' &&
    Number.isInteger(effectiveRawEnd) &&
    Number.isFinite(effectiveRawEnd);

  // 1. Missing, non-integer, or non-positive line reference
  if (!hasValidStartInt || !hasValidEndInt || (rawStartLine as number) < 1) {
    const reportedStart =
      typeof rawStartLine === 'number' && Number.isFinite(rawStartLine) ? rawStartLine : 0;
    const reportedEnd =
      typeof effectiveRawEnd === 'number' && Number.isFinite(effectiveRawEnd)
        ? effectiveRawEnd
        : reportedStart;
    return {
      fileId: file.id,
      filename: file.filename,
      startLine: reportedStart,
      endLine: reportedEnd,
      isValidLocation: false,
      rawSnippet: '',
      contentHash,
      locationReason: 'missing_line',
      validationNote: `Finding did not provide a valid 1-indexed line reference (received L${String(
        rawStartLine
      )}) for ${file.filename}. Location has been quarantined.`,
    };
  }

  const start = rawStartLine as number;
  const end = effectiveRawEnd as number;

  // 2. Inverted line range (end < start) or out-of-bounds (> totalLines)
  if (end < start || start > totalLines || end > totalLines) {
    return {
      fileId: file.id,
      filename: file.filename,
      startLine: start,
      endLine: end,
      isValidLocation: false,
      rawSnippet: '',
      contentHash,
      locationReason: 'out_of_bounds',
      validationNote: `Referenced line range L${start}${
        end !== start ? `–L${end}` : ''
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
    contentHash,
    locationReason: 'verified',
  };
}

/**
 * Verifies a finding's location against the current set of review files.
 * Detects wrong-file attribution, post-analysis source mutations (via contentHash),
 * and out-of-bounds or missing line citations.
 */
export function verifyFindingLocationIntegrity(
  finding: ReviewFinding,
  files: SourceFileRecord[]
): FindingLocation {
  const loc = finding?.location;
  if (!loc || typeof loc !== 'object') {
    return createQuarantinedFindingLocation({
      fileId: 'unmatched-file',
      filename: 'unknown-file',
      rawStartLine: 0,
      rawEndLine: 0,
      reason: 'missing_line',
      validationNote: 'Finding is missing location metadata and has been quarantined.',
    });
  }

  // If already quarantined as wrong_file or missing_line or insufficient_evidence, preserve quarantine
  if (!loc.isValidLocation && loc.locationReason && loc.locationReason !== 'verified') {
    return loc;
  }

  const targetFile = resolveTargetSourceFile(files, loc.fileId, loc.filename);
  if (!targetFile) {
    return createQuarantinedFindingLocation({
      fileId: loc.fileId || 'unmatched-file',
      filename: loc.filename || 'unknown-file',
      rawStartLine: loc.startLine,
      rawEndLine: loc.endLine,
      reason: 'wrong_file',
      validationNote: `Finding references file "${loc.filename}" (ID: ${loc.fileId}), which does not match any file in this review.`,
    });
  }

  const currentHash =
    targetFile.contentHash || computeSourceContentHash(targetFile.content);

  if (loc.contentHash && loc.contentHash !== currentHash) {
    return createQuarantinedFindingLocation({
      fileId: targetFile.id,
      filename: targetFile.filename,
      rawStartLine: loc.startLine,
      rawEndLine: loc.endLine,
      reason: 'source_changed',
      validationNote: `Source content for ${targetFile.filename} changed after this finding was generated (expected hash ${loc.contentHash}, current hash ${currentHash}). Line highlighting is quarantined to prevent stale evidence alignment.`,
    });
  }

  const revalidated = validateAndNormalizeFindingLocation(
    targetFile,
    loc.startLine,
    loc.endLine
  );

  if (!revalidated.isValidLocation) {
    return revalidated;
  }

  // Also check if a previously stored rawSnippet conflicts with current lines at startLine..endLine
  if (
    loc.rawSnippet &&
    loc.rawSnippet.replace(/\r\n/g, '\n').trim() !==
      revalidated.rawSnippet.replace(/\r\n/g, '\n').trim()
  ) {
    return createQuarantinedFindingLocation({
      fileId: targetFile.id,
      filename: targetFile.filename,
      rawStartLine: loc.startLine,
      rawEndLine: loc.endLine,
      reason: 'source_changed',
      validationNote: `Recorded code snippet for ${targetFile.filename}:L${loc.startLine} no longer matches the source lines in the file.`,
    });
  }

  return revalidated;
}

/**
 * Defensively verifies a collection of ReviewFindings against the exact SourceFileRecords
 * in a review. Preserves valid findings while quarantining any finding with a wrong file,
 * missing/out-of-bounds line range, or stale source hash, downgrading its confidence to 'low'.
 */
export function verifyReviewFindingsIntegrity(
  findings: ReviewFinding[],
  files: SourceFileRecord[]
): ReviewFinding[] {
  if (!Array.isArray(findings)) return [];
  const safeFiles = Array.isArray(files) ? files : [];

  return findings.map((finding) => {
    const verifiedLocation = verifyFindingLocationIntegrity(finding, safeFiles);
    if (!verifiedLocation.isValidLocation) {
      const quarantineNote =
        verifiedLocation.validationNote ||
        'Source location could not be verified against the reviewed file contents.';
      const existingNote = finding.uncertaintyNote || '';
      const combinedNote = existingNote.includes(quarantineNote)
        ? existingNote
        : existingNote
        ? `${existingNote} ${quarantineNote}`
        : quarantineNote;

      return {
        ...finding,
        confidence: 'low',
        uncertaintyNote: combinedNote,
        location: verifiedLocation,
      };
    }

    return {
      ...finding,
      location: verifiedLocation,
    };
  });
}

/**
 * Deduplicates genuinely redundant findings while preserving distinct, evidence-backed findings:
 * - Preserves findings from the same rule when they occur at non-overlapping line ranges (e.g. L12-13 and L22).
 * - Preserves findings at the same line range when they come from different static rules or defect categories (e.g. PG-BND-003 vs PG-PERF-007).
 * - Deduplicates findings in the same file when they share the same static ruleId and overlapping lines,
 *   or when uncorroborated AI findings share the same file, category, and overlapping lines.
 */
export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const result: ReviewFinding[] = [];

  for (const candidate of findings) {
    const existingIdx = result.findIndex((existing) => {
      if (existing.location.fileId !== candidate.location.fileId) return false;
      if (existing.location.filename !== candidate.location.filename) return false;
      if (!existing.location.isValidLocation || !candidate.location.isValidLocation) {
        return (
          existing.title.trim().toLowerCase() === candidate.title.trim().toLowerCase() &&
          existing.location.startLine === candidate.location.startLine &&
          existing.location.endLine === candidate.location.endLine
        );
      }

      const linesOverlap =
        existing.location.startLine <= candidate.location.endLine &&
        existing.location.endLine >= candidate.location.startLine;
      if (!linesOverlap) return false;

      const existingRule = existing.staticCorroboration?.ruleId;
      const candidateRule = candidate.staticCorroboration?.ruleId;

      // If both findings carry static rule IDs, they are duplicates if and only if the rule ID is identical
      if (existingRule && candidateRule) {
        return existingRule === candidateRule;
      }

      // If neither carries a static rule ID (e.g. duplicate AI findings), deduplicate if same category on overlapping lines
      if (!existingRule && !candidateRule) {
        return existing.category === candidate.category;
      }

      // If one is corroborated/static and the other is an AI finding on the same category & overlapping lines
      return existing.category === candidate.category;
    });

    if (existingIdx === -1) {
      result.push(candidate);
    } else {
      const existing = result[existingIdx];
      // Prefer corroborated > static-pattern > ai-gemini, or higher severity
      const preferCandidate =
        (candidate.analysisSource === 'corroborated' &&
          existing.analysisSource !== 'corroborated') ||
        (candidate.analysisSource === existing.analysisSource &&
          compareSeverity(candidate.severity, existing.severity) < 0);
      if (preferCandidate) {
        result[existingIdx] = candidate;
      }
    }
  }

  return result;
}

export function runStaticAnalysisOnFiles(
  files: SourceFileRecord[],
  focusAreas?: FindingCategory[]
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const now = new Date().toISOString();

  for (const file of files) {
    const cleanContent = (file.content || '').replace(/\r\n/g, '\n');
    const fileWithHash: SourceFileRecord = {
      ...file,
      content: cleanContent,
      lineCount: cleanContent.split('\n').length,
      contentHash: file.contentHash || computeSourceContentHash(cleanContent),
    };
    const lines = cleanContent.split('\n');

    for (const rule of STATIC_RULES) {
      if (!rule.languages.includes(fileWithHash.language)) continue;

      const matches = rule.matcher(lines, cleanContent);
      for (let idx = 0; idx < matches.length; idx++) {
        const m = matches[idx];
        const location = validateAndNormalizeFindingLocation(
          fileWithHash,
          m.startLine,
          m.endLine
        );
        const prioritized =
          focusAreas && focusAreas.length > 0 && focusAreas.includes(rule.category);

        findings.push({
          id: `fnd-static-${rule.ruleId.toLowerCase()}-${fileWithHash.id}-${m.startLine}-${idx}`,
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

  return deduplicateFindings(findings);
}

export function mergeAndCorroborateFindings(
  staticFindings: ReviewFinding[],
  aiFindings: ReviewFinding[]
): ReviewFinding[] {
  const dedupedStatic = deduplicateFindings(staticFindings);
  const dedupedAi = deduplicateFindings(aiFindings);
  const merged: ReviewFinding[] = [];
  const consumedAiIds = new Set<string>();

  for (const sf of dedupedStatic) {
    const matchingAiList = dedupedAi.filter((af) => {
      if (consumedAiIds.has(af.id)) return false;
      if (af.location.fileId !== sf.location.fileId) return false;
      if (af.location.filename !== sf.location.filename) return false;
      if (!af.location.isValidLocation || !sf.location.isValidLocation) return false;
      const lineDiff = Math.abs(af.location.startLine - sf.location.startLine);
      const overlaps =
        af.location.startLine <= sf.location.endLine + 3 &&
        af.location.endLine >= sf.location.startLine - 3;
      return (overlaps || lineDiff <= 3) && af.category === sf.category;
    });

    if (matchingAiList.length > 0) {
      for (const ma of matchingAiList) {
        consumedAiIds.add(ma.id);
      }
      const primaryAi = matchingAiList[0];
      merged.push({
        ...primaryAi,
        id: `fnd-corroborated-${sf.staticCorroboration?.ruleId.toLowerCase() || 'rule'}-${sf.location.startLine}`,
        severity:
          compareSeverity(sf.severity, primaryAi.severity) <= 0
            ? sf.severity
            : primaryAi.severity,
        analysisSource: 'corroborated',
        confidence: 'high',
        location: sf.location, // Preserve verified deterministic static location & contentHash
        uncertaintyNote:
          'Independently corroborated by both PatchGuard Static Analyzer and Gemini AI code reasoning.',
        staticCorroboration: sf.staticCorroboration,
        remediationCode: primaryAi.remediationCode || sf.remediationCode,
      });
    } else {
      merged.push(sf);
    }
  }

  for (const af of dedupedAi) {
    if (!consumedAiIds.has(af.id)) {
      merged.push(af);
    }
  }

  return sortFindingsBySeverity(deduplicateFindings(merged));
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
    // Place valid locations ahead of quarantined locations of the same severity
    if (a.location.isValidLocation !== b.location.isValidLocation) {
      return a.location.isValidLocation ? -1 : 1;
    }
    const sevDiff = compareSeverity(a.severity, b.severity);
    if (sevDiff !== 0) return sevDiff;
    return a.location.startLine - b.location.startLine;
  });
}
