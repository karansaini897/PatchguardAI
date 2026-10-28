import {
  AnalysisSourceType,
  ExpectedDefect,
  FindingCategory,
  FindingStatus,
  MatchedDefectPair,
  ReviewFinding,
  SeverityLevel,
} from '../types/patchguard';
import { compareSeverity } from './staticAnalyzer';

export interface FindingFilterCriteria {
  severity: SeverityLevel | 'all';
  category: FindingCategory | 'all';
  filename: string | 'all';
  status: FindingStatus | 'all';
  source: AnalysisSourceType | 'all';
  searchQuery: string;
}

export function filterFindings(
  findings: ReviewFinding[],
  criteria: FindingFilterCriteria
): ReviewFinding[] {
  const q = criteria.searchQuery.trim().toLowerCase();
  return findings.filter((f) => {
    if (criteria.severity !== 'all' && f.severity !== criteria.severity) return false;
    if (criteria.category !== 'all' && f.category !== criteria.category) return false;
    if (criteria.filename !== 'all' && f.location.filename !== criteria.filename) return false;
    if (criteria.status !== 'all' && f.status !== criteria.status) return false;
    if (criteria.source !== 'all' && f.analysisSource !== criteria.source) return false;
    if (q) {
      const hay = `${f.title} ${f.explanation} ${f.category} ${f.location.filename} ${f.staticCorroboration?.ruleId || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface SeverityDistribution {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
  highestSeverity: SeverityLevel | 'none';
}

export function computeSeverityDistribution(findings: ReviewFinding[]): SeverityDistribution {
  const dist: SeverityDistribution = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    total: findings.length,
    highestSeverity: 'none',
  };

  for (const f of findings) {
    dist[f.severity]++;
  }

  if (dist.critical > 0) dist.highestSeverity = 'critical';
  else if (dist.high > 0) dist.highestSeverity = 'high';
  else if (dist.medium > 0) dist.highestSeverity = 'medium';
  else if (dist.low > 0) dist.highestSeverity = 'low';
  else if (dist.info > 0) dist.highestSeverity = 'info';

  return dist;
}

/**
 * Matches detected findings against ground-truth expected defects using:
 * 1. Valid source location within ±3 lines of the expected defect range
 * 2. Category match OR severity at least as high as expected minSeverity
 */
export function matchFindingsToExpectedDefects(
  detectedFindings: ReviewFinding[],
  expectedDefects: ExpectedDefect[]
): {
  matchedPairs: MatchedDefectPair[];
  unmatchedExpectedIds: string[];
  falsePositiveFindingIds: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1Score: number | null;
} {
  const matchedPairs: MatchedDefectPair[] = [];
  const matchedExpectedSet = new Set<string>();
  const matchedFindingSet = new Set<string>();

  for (const exp of expectedDefects) {
    let bestCandidate: ReviewFinding | null = null;
    let bestDelta = Infinity;

    for (const f of detectedFindings) {
      if (matchedFindingSet.has(f.id)) continue;
      if (!f.location.isValidLocation) continue;

      const overlaps =
        f.location.startLine <= exp.endLine + 3 && f.location.endLine >= exp.startLine - 3;
      if (!overlaps) continue;

      const categoryMatched = f.category === exp.category;
      const severityMet = compareSeverity(f.severity, exp.minSeverity) <= 1;

      if (categoryMatched && severityMet) {
        const delta = Math.abs(f.location.startLine - exp.startLine);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestCandidate = f;
        }
      }
    }

    if (bestCandidate) {
      matchedExpectedSet.add(exp.id);
      matchedFindingSet.add(bestCandidate.id);
      matchedPairs.push({
        expectedDefectId: exp.id,
        findingId: bestCandidate.id,
        lineDelta: bestDelta,
        categoryMatched: bestCandidate.category === exp.category,
      });
    }
  }

  const unmatchedExpectedIds = expectedDefects
    .filter((e) => !matchedExpectedSet.has(e.id))
    .map((e) => e.id);

  const falsePositiveFindingIds = detectedFindings
    .filter((f) => !matchedFindingSet.has(f.id))
    .map((f) => f.id);

  const truePositives = matchedPairs.length;
  const falsePositives = falsePositiveFindingIds.length;
  const falseNegatives = unmatchedExpectedIds.length;

  const { precision, recall, f1Score } = computePrecisionRecall(
    truePositives,
    falsePositives,
    falseNegatives
  );

  return {
    matchedPairs,
    unmatchedExpectedIds,
    falsePositiveFindingIds,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1Score,
  };
}

/**
 * Explicit metric formulas:
 * Precision = TP / (TP + FP)
 * Recall = TP / (TP + FN)
 * Zero denominators are handled explicitly by returning null rather than NaN or fabricated 100%.
 */
export function computePrecisionRecall(
  tp: number,
  fp: number,
  fn: number
): {
  precision: number | null;
  recall: number | null;
  f1Score: number | null;
} {
  const precisionDenom = tp + fp;
  const recallDenom = tp + fn;

  const precision = precisionDenom > 0 ? Number((tp / precisionDenom).toFixed(4)) : null;
  const recall = recallDenom > 0 ? Number((tp / recallDenom).toFixed(4)) : null;

  let f1Score: number | null = null;
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1Score = Number(((2 * precision * recall) / (precision + recall)).toFixed(4));
  }

  return { precision, recall, f1Score };
}
