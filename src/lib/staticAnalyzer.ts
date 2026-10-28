import {
  FindingCategory,
  FindingLocation,
  LocationValidationReason,
  ReviewFinding,
  SeverityLevel,
  SourceFileRecord,
} from '../types/patchguard';

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
    title: 'Unsanitized SQL query interpolation allows arbitrary command injection',
    severity: 'critical',
    category: 'security',
    languages: ['typescript', 'javascript', 'python', 'java', 'sql'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|#|--)/.test(line)) continue;
        const hasSqlKeyword = /\b(SELECT|UPDATE|DELETE|INSERT\s+INTO|WHERE)\b/i.test(line);
        const hasInterpolation =
          /\$\{[^}]+\}/.test(line) ||
          /f["'][^"']*\{[^}]+\}/.test(line) ||
          /["']\s*\+\s*[a-zA-Z0-9_.]+\s*(\+|;|$)/.test(line) ||
          (/%s/.test(line) && /\.execute\s*\(\s*f["']/.test(line));

        if (hasSqlKeyword && hasInterpolation) {
          // Include the immediately following execution line only if it exists and executes this query variable
          const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
          const spansNextLine =
            i + 1 < lines.length &&
            /\b(query|execute|getBalance|raw)\s*\(/.test(nextLine);
          hits.push({
            startLine: i + 1,
            endLine: spansNextLine ? i + 2 : i + 1,
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
    title: 'Swallowed exception or unawaited promise inside catch/error handler',
    severity: 'medium',
    category: 'error-handling',
    languages: ['typescript', 'javascript', 'python', 'java'],
    matcher: (lines) => {
      const hits: ReturnType<StaticRuleDefinition['matcher']> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const maxEnd = Math.min(lines.length, i + 4);
        const windowSlice = lines.slice(i, maxEnd);
        const joinedWindow = windowSlice.join(' ');
        const isSilentCatch =
          /catch\s*\([^)]*\)\s*\{\s*(\/\/.*)?\s*\}/.test(joinedWindow) ||
          /except(\s+[A-Za-z0-9_]+)?\s*:\s*pass\b/.test(joinedWindow);

        if (isSilentCatch) {
          let blockLen = 1;
          for (let k = 1; k < windowSlice.length; k++) {
            blockLen = k + 1;
            if (/^\s*(\}|pass\b)/.test(windowSlice[k])) break;
          }
          hits.push({
            startLine: i + 1,
            endLine: i + blockLen,
            matchedPattern: line.trim(),
            explanation:
              'Exception block catches runtime failures and discards them without structured logging, metric emission, or error propagation.',
            potentialImpact:
              'Partial failures leave downstream callers assuming the operation succeeded, masking production incidents and corrupting caller control flow.',
            suggestedRemediation:
              'Log the error with contextual identifiers and either rethrow a typed domain error or return an explicit failure result.',
          });
          i += blockLen - 1;
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
        if (
          /(api[_-]?key|[a-z0-9_]*secret(?:[_-]?key)?|password|private[_-]?key|bearer[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{12,}["']/i.test(
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
        const isLoop = /^\s*(for\s*\(|for\s+[a-zA-Z0-9_]+\s+in\b|while\s*\()/.test(lines[i]);
        if (isLoop) {
          const maxLoopEnd = Math.min(lines.length, i + 6);
          const loopSlice = lines.slice(i + 1, maxLoopEnd);
          const loopBody = loopSlice.join('\n');
          if (/\b(await\s+(db|client|repo|fetch|axios|prisma)|cursor\.execute)\b/.test(loopBody)) {
            let endOffset = 1;
            for (let k = 0; k < loopSlice.length; k++) {
              endOffset = k + 2;
              if (/^\s*\}/.test(loopSlice[k])) break;
            }
            hits.push({
              startLine: i + 1,
              endLine: Math.min(lines.length, i + endOffset),
              matchedPattern: lines[i].trim(),
              explanation:
                'An asynchronous I/O or database query is awaited sequentially on each iteration of a collection loop.',
              potentialImpact:
                'Latency scales linearly with input cardinality (O(N) round-trips), risking connection pool exhaustion and request timeouts on large payloads.',
              suggestedRemediation:
                'Batch-fetch records before the loop using a single `WHERE id IN (...)` query or execute independent requests with bounded concurrency.',
            });
            i += endOffset - 1;
          }
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
  const loc = finding.location;

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
      if (af.location.fileId !== sf.location.fileId) return false;
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
        severity:
          compareSeverity(sf.severity, matchingAi.severity) <= 0
            ? sf.severity
            : matchingAi.severity,
        analysisSource: 'corroborated',
        confidence: 'high',
        location: sf.location, // Preserve verified deterministic static location & contentHash
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
    // Place valid locations ahead of quarantined locations of the same severity
    if (a.location.isValidLocation !== b.location.isValidLocation) {
      return a.location.isValidLocation ? -1 : 1;
    }
    const sevDiff = compareSeverity(a.severity, b.severity);
    if (sevDiff !== 0) return sevDiff;
    return a.location.startLine - b.location.startLine;
  });
}
