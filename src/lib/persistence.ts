import {
  DiagnosticEvent,
  EvaluationTestCase,
  FindingStatus,
  ReviewRecord,
} from '../types/patchguard';
import { INITIAL_EVALUATION_TEST_CASES } from './curatedData';

const STORAGE_KEYS = {
  REVIEWS: 'patchguard_reviews_v1',
  EVAL_CASES: 'patchguard_eval_cases_v1',
  DIAGNOSTICS: 'patchguard_diagnostics_v1',
  THEME: 'patchguard_theme_v1',
  WORKSPACE_LAYOUT: 'patchguard_layout_v1',
} as const;

export interface WorkspaceLayoutPrefs {
  sourceWidthPercent: number;
  findingsWidthPercent: number;
}

class PersistenceManager {
  private memoryReviews: ReviewRecord[] = [];
  private memoryEvalCases: EvaluationTestCase[] = [...INITIAL_EVALUATION_TEST_CASES];
  private memoryDiagnostics: DiagnosticEvent[] = [];
  private storageHealthy = true;

  constructor() {
    this.verifyStorageAccess();
  }

  private verifyStorageAccess(): boolean {
    if (typeof window === 'undefined' || !window.localStorage) {
      this.storageHealthy = false;
      return false;
    }
    try {
      const probeKey = '__pg_storage_probe__';
      window.localStorage.setItem(probeKey, '1');
      window.localStorage.removeItem(probeKey);
      this.storageHealthy = true;
      return true;
    } catch {
      this.storageHealthy = false;
      return false;
    }
  }

  public isLocalStorageAvailable(): boolean {
    return this.storageHealthy;
  }

  public getReviews(): ReviewRecord[] {
    if (!this.storageHealthy) return this.memoryReviews;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.REVIEWS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return this.memoryReviews;
    }
  }

  public saveReview(review: ReviewRecord): { ok: boolean; error?: string } {
    const current = this.getReviews().filter((r) => r.id !== review.id);
    const updated = [review, ...current];
    this.memoryReviews = updated;

    if (!this.storageHealthy) {
      return {
        ok: false,
        error: 'Browser localStorage is unavailable; review stored in volatile session memory only.',
      };
    }

    try {
      window.localStorage.setItem(STORAGE_KEYS.REVIEWS, JSON.stringify(updated));
      return { ok: true };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || 'Failed to persist review to browser localStorage (quota or permission error).',
      };
    }
  }

  public updateFindingStatus(
    reviewId: string,
    findingId: string,
    nextStatus: FindingStatus
  ): ReviewRecord | null {
    const reviews = this.getReviews();
    const targetIdx = reviews.findIndex((r) => r.id === reviewId);
    if (targetIdx === -1) return null;

    const now = new Date().toISOString();
    const target = reviews[targetIdx];
    const updatedReview: ReviewRecord = {
      ...target,
      findings: target.findings.map((f) =>
        f.id === findingId ? { ...f, status: nextStatus, updatedAt: now } : f
      ),
    };

    reviews[targetIdx] = updatedReview;
    this.memoryReviews = reviews;
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.REVIEWS, JSON.stringify(reviews));
      } catch {
        // Ignore quota write failure on status update
      }
    }
    return updatedReview;
  }

  public deleteReview(reviewId: string): ReviewRecord[] {
    const next = this.getReviews().filter((r) => r.id !== reviewId);
    this.memoryReviews = next;
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.REVIEWS, JSON.stringify(next));
      } catch {
        // ignore
      }
    }
    return next;
  }

  public clearAllReviews(): void {
    this.memoryReviews = [];
    if (this.storageHealthy) {
      try {
        window.localStorage.removeItem(STORAGE_KEYS.REVIEWS);
      } catch {
        // ignore
      }
    }
  }

  public getEvaluationCases(): EvaluationTestCase[] {
    if (!this.storageHealthy) return this.memoryEvalCases;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.EVAL_CASES);
      if (!raw) return [...INITIAL_EVALUATION_TEST_CASES];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return [...INITIAL_EVALUATION_TEST_CASES];
      return parsed;
    } catch {
      return [...INITIAL_EVALUATION_TEST_CASES];
    }
  }

  public saveEvaluationCases(cases: EvaluationTestCase[]): void {
    this.memoryEvalCases = cases;
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.EVAL_CASES, JSON.stringify(cases));
      } catch {
        // ignore
      }
    }
  }

  public resetEvaluationCases(): EvaluationTestCase[] {
    const fresh = INITIAL_EVALUATION_TEST_CASES.map((c) => ({ ...c, lastRunResult: undefined }));
    this.saveEvaluationCases(fresh);
    return fresh;
  }

  public getDiagnostics(): DiagnosticEvent[] {
    if (!this.storageHealthy) return this.memoryDiagnostics;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.DIAGNOSTICS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return this.memoryDiagnostics;
    }
  }

  public appendDiagnostic(event: DiagnosticEvent): DiagnosticEvent[] {
    const current = this.getDiagnostics();
    const updated = [event, ...current].slice(0, 50);
    this.memoryDiagnostics = updated;
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.DIAGNOSTICS, JSON.stringify(updated));
      } catch {
        // ignore
      }
    }
    return updated;
  }

  public clearDiagnostics(): void {
    this.memoryDiagnostics = [];
    if (this.storageHealthy) {
      try {
        window.localStorage.removeItem(STORAGE_KEYS.DIAGNOSTICS);
      } catch {
        // ignore
      }
    }
  }

  public getTheme(): 'dark' | 'light' {
    if (!this.storageHealthy) return 'dark';
    try {
      const val = window.localStorage.getItem(STORAGE_KEYS.THEME);
      return val === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  public saveTheme(theme: 'dark' | 'light'): void {
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.THEME, theme);
      } catch {
        // ignore
      }
    }
  }

  public getWorkspaceLayout(): WorkspaceLayoutPrefs {
    const fallback: WorkspaceLayoutPrefs = { sourceWidthPercent: 44, findingsWidthPercent: 28 };
    if (!this.storageHealthy) return fallback;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.WORKSPACE_LAYOUT);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.sourceWidthPercent === 'number' &&
        typeof parsed.findingsWidthPercent === 'number'
      ) {
        return {
          sourceWidthPercent: Math.max(25, Math.min(60, parsed.sourceWidthPercent)),
          findingsWidthPercent: Math.max(20, Math.min(45, parsed.findingsWidthPercent)),
        };
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  public saveWorkspaceLayout(prefs: WorkspaceLayoutPrefs): void {
    if (this.storageHealthy) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.WORKSPACE_LAYOUT, JSON.stringify(prefs));
      } catch {
        // ignore
      }
    }
  }
}

export const persistence = new PersistenceManager();
