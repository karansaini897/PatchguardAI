export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'security'
  | 'concurrency'
  | 'boundary'
  | 'error-handling'
  | 'performance'
  | 'correctness'
  | 'data-integrity'
  | 'maintainability';

export type FindingStatus = 'unreviewed' | 'reviewed' | 'dismissed' | 'reopened';

export type AnalysisSourceType = 'ai-gemini' | 'static-pattern' | 'corroborated';

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'sql';

export type FileChangeStatus = 'modified' | 'added' | 'snippet';

export interface SourceFileRecord {
  id: string;
  filename: string;
  language: SupportedLanguage;
  content: string;
  lineCount: number;
  changeStatus: FileChangeStatus;
}

export interface FindingLocation {
  fileId: string;
  filename: string;
  startLine: number;
  endLine: number;
  isValidLocation: boolean;
  rawSnippet: string;
  validationNote?: string;
}

export interface StaticCorroboration {
  ruleId: string;
  engineName: string;
  matchedPattern: string;
  deterministicConfidence: 'high' | 'medium';
}

export interface ReviewFinding {
  id: string;
  title: string;
  severity: SeverityLevel;
  category: FindingCategory;
  status: FindingStatus;
  analysisSource: AnalysisSourceType;
  confidence: 'high' | 'medium' | 'low';
  uncertaintyNote?: string;
  location: FindingLocation;
  explanation: string;
  potentialImpact: string;
  suggestedRemediation: string;
  remediationCode?: string;
  staticCorroboration?: StaticCorroboration;
  createdAt: string;
  updatedAt: string;
}

export type ReviewExecutionStatus =
  | 'completed'
  | 'completed_static_only'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'
  | 'in_progress';

export interface AnalysisStageReport {
  stageId: string;
  name: string;
  engine: string;
  status: 'succeeded' | 'warning' | 'failed' | 'skipped';
  durationMs: number;
  findingsProduced: number;
  attempts?: number;
  retriedCount?: number;
  httpStatus?: number;
  retryable?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type ApiErrorCategory =
  | 'BACKEND_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'MISSING_SERVER_CONFIG'
  | 'AI_SERVICE_UNAVAILABLE'
  | 'AI_AUTH_ERROR'
  | 'AI_RATE_LIMIT'
  | 'AI_TIMEOUT'
  | 'INVALID_MODEL_RESPONSE'
  | 'PERSISTENCE_FAILURE'
  | 'INCOMPLETE_ANALYSIS';

export interface StructuredApiError {
  category: ApiErrorCategory;
  message: string;
  technicalDetail: string;
  remediationStep: string;
  requestId: string;
  timestamp: string;
  retryable: boolean;
  attemptsMade?: number;
  httpStatus?: number;
}

export interface ReviewRecord {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  status: ReviewExecutionStatus;
  objective: string;
  focusAreas: FindingCategory[];
  files: SourceFileRecord[];
  findings: ReviewFinding[];
  stages: AnalysisStageReport[];
  requestId: string;
  modelUsed: string;
  warningMessage?: string;
  errorDetails?: StructuredApiError;
  isDemoRecord?: boolean;
}

export interface ReviewRequestPayload {
  title: string;
  objective: string;
  focusAreas: FindingCategory[];
  files: Array<{
    id?: string;
    filename: string;
    language: SupportedLanguage;
    content: string;
    changeStatus?: FileChangeStatus;
  }>;
  analysisMode?: 'hybrid' | 'static-only' | 'ai-only';
  simulateFailureMode?: ApiErrorCategory;
}

export interface ExpectedDefect {
  id: string;
  title: string;
  category: FindingCategory;
  minSeverity: SeverityLevel;
  startLine: number;
  endLine: number;
  rationale: string;
}

export interface MatchedDefectPair {
  expectedDefectId: string;
  findingId: string;
  lineDelta: number;
  categoryMatched: boolean;
}

export interface EvaluationCaseResult {
  executedAt: string;
  durationMs: number;
  status: ReviewExecutionStatus;
  detectedFindings: ReviewFinding[];
  matchedPairs: MatchedDefectPair[];
  unmatchedExpectedIds: string[];
  falsePositiveFindingIds: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1Score: number | null;
  requestId: string;
  analysisSourcesUsed: string[];
  errorDetails?: StructuredApiError;
}

export interface EvaluationTestCase {
  id: string;
  suiteId: string;
  suiteName: string;
  title: string;
  language: SupportedLanguage;
  category: FindingCategory;
  description: string;
  filename: string;
  sourceCode: string;
  expectedDefects: ExpectedDefect[];
  lastRunResult?: EvaluationCaseResult;
}

export interface DiagnosticEvent {
  id: string;
  timestamp: string;
  requestId: string;
  reviewId?: string;
  endpoint: string;
  durationMs: number;
  stage: string;
  status: 'succeeded' | 'warning' | 'failed';
  errorCategory?: ApiErrorCategory;
  statusCode: number;
  message: string;
  retryAvailable: boolean;
}

export interface SystemHealthStatus {
  checkedAt: string;
  backendReachable: boolean;
  backendLatencyMs: number | null;
  aiProviderConfigured: boolean;
  aiConnectivityState: 'unverified' | 'verified' | 'failed';
  aiConnectivityMessage: string;
  aiModelId: string;
  staticEngineAvailable: boolean;
  staticEngineVersion: string;
  persistenceMode: 'browser-local-storage' | 'memory-fallback';
  persistenceHealthy: boolean;
}

export type ActiveScreen =
  | 'overview'
  | 'new-review'
  | 'workspace'
  | 'history'
  | 'evaluation-lab'
  | 'settings';
