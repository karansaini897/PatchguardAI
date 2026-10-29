import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthenticatedUser,
  FindingStatus,
  ProjectRecord,
  ReviewRecord,
  SourceRetentionMode,
} from '../types/patchguard';
import {
  DbFindingRow,
  DbProjectRow,
  DbReviewRow,
  isConfiguredSupabaseAnonKey,
  isConfiguredSupabaseUrl,
  mapDatabaseRowsToReviewRecord,
  mapProjectRowToRecord,
} from './supabaseBackendCore';

const SESSION_STORAGE_KEY = 'patchguard_auth_session_v1';

const rawViteSupabaseUrl =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_SUPABASE_URL as string | undefined)
    : undefined;

const rawViteSupabaseAnonKey =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)
    : undefined;

const rawEdgeFunctionUrl =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_SUPABASE_EDGE_FUNCTION_URL as string | undefined)
    : undefined;

export const isLiveSupabaseClientConfigured =
  isConfiguredSupabaseUrl(rawViteSupabaseUrl) &&
  isConfiguredSupabaseAnonKey(rawViteSupabaseAnonKey);

export const supabase: SupabaseClient | null = isLiveSupabaseClientConfigured
  ? createClient(rawViteSupabaseUrl!.trim(), rawViteSupabaseAnonKey!.trim(), {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function getReviewAnalysisEndpoint(): string {
  if (rawEdgeFunctionUrl && rawEdgeFunctionUrl.trim().startsWith('http')) {
    return rawEdgeFunctionUrl.trim();
  }
  if (isLiveSupabaseClientConfigured && rawViteSupabaseUrl) {
    return `${rawViteSupabaseUrl.trim().replace(/\/+$/, '')}/functions/v1/analyze-review`;
  }
  return '/api/review';
}

function readStoredLocalSession(): AuthenticatedUser | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthenticatedUser;
    if (!parsed || !parsed.accessToken || !parsed.id || !parsed.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredLocalSession(user: AuthenticatedUser | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!user) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
    }
  } catch {
    // ignore storage errors
  }
}

export async function getActiveAccessToken(): Promise<string | null> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return data.session.access_token;
    }
  }
  const local = readStoredLocalSession();
  return local?.accessToken || null;
}

export interface SessionRestoreResult {
  user: AuthenticatedUser | null;
  projects: ProjectRecord[];
  sessionExpired: boolean;
  errorMessage?: string;
}

export async function restoreAuthSession(): Promise<SessionRestoreResult> {
  // 1. Live Supabase Auth session restoration
  if (supabase) {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        return {
          user: null,
          projects: [],
          sessionExpired: true,
          errorMessage: error.message,
        };
      }
      if (!data.session || !data.session.user) {
        return { user: null, projects: [], sessionExpired: false };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (data.session.expires_at && data.session.expires_at < nowSec) {
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr || !refreshed.session || !refreshed.user) {
          await supabase.auth.signOut();
          return {
            user: null,
            projects: [],
            sessionExpired: true,
            errorMessage: 'Your Supabase session expired. Please sign in again.',
          };
        }
        const user: AuthenticatedUser = {
          id: refreshed.user.id,
          email: refreshed.user.email || 'user@supabase.io',
          accessToken: refreshed.session.access_token,
          expiresAt: (refreshed.session.expires_at || nowSec + 3600) * 1000,
          authProvider: 'supabase-jwt',
        };
        const projects = await fetchUserProjects(user);
        return { user, projects, sessionExpired: false };
      }

      const user: AuthenticatedUser = {
        id: data.session.user.id,
        email: data.session.user.email || 'user@supabase.io',
        accessToken: data.session.access_token,
        expiresAt: data.session.expires_at ? data.session.expires_at * 1000 : undefined,
        authProvider: 'supabase-jwt',
      };
      const projects = await fetchUserProjects(user);
      return { user, projects, sessionExpired: false };
    } catch (err: any) {
      return {
        user: null,
        projects: [],
        sessionExpired: false,
        errorMessage: err?.message || 'Failed to restore Supabase session.',
      };
    }
  }

  // 2. Local RLS Mirror session restoration
  const stored = readStoredLocalSession();
  if (!stored) {
    return { user: null, projects: [], sessionExpired: false };
  }

  if (stored.expiresAt && Date.now() > stored.expiresAt) {
    writeStoredLocalSession(null);
    return {
      user: null,
      projects: [],
      sessionExpired: true,
      errorMessage: 'Your authenticated session has expired. Please sign in again.',
    };
  }

  try {
    const res = await fetch('/api/auth/session', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${stored.accessToken}`,
      },
    });
    if (res.status === 401) {
      // Server restarted or session expired: if default dev account, silently re-authenticate or notify
      writeStoredLocalSession(null);
      return {
        user: null,
        projects: [],
        sessionExpired: true,
        errorMessage: 'Your previous session expired. Sign in to continue.',
      };
    }
    if (!res.ok) {
      return { user: null, projects: [], sessionExpired: false };
    }
    const body = await res.json();
    writeStoredLocalSession(body.user);
    return {
      user: body.user,
      projects: Array.isArray(body.projects) ? body.projects : [],
      sessionExpired: false,
    };
  } catch {
    return { user: null, projects: [], sessionExpired: false };
  }
}

export async function signUpUser(
  email: string,
  password: string
): Promise<
  | { ok: true; user: AuthenticatedUser; projects: ProjectRecord[]; message?: string }
  | { ok: false; error: string }
> {
  if (supabase) {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    if (!data.user || !data.session) {
      return {
        ok: false,
        error:
          'Account registered. Check your email inbox to confirm your address before signing in (or disable Confirm Email in Supabase Auth settings for immediate local login).',
      };
    }
    const user: AuthenticatedUser = {
      id: data.user.id,
      email: data.user.email || email.trim(),
      accessToken: data.session.access_token,
      expiresAt: data.session.expires_at ? data.session.expires_at * 1000 : undefined,
      authProvider: 'supabase-jwt',
    };
    const projects = await fetchUserProjects(user);
    return { ok: true, user, projects };
  }

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.user) {
      const errMsg =
        typeof body.error?.message === 'string'
          ? body.error.message
          : typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string'
          ? body.error
          : `Sign-up failed (HTTP ${res.status}).`;
      return { ok: false, error: errMsg };
    }
    writeStoredLocalSession(body.user);
    return {
      ok: true,
      user: body.user,
      projects: Array.isArray(body.projects) ? body.projects : [],
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unable to reach authentication server.' };
  }
}

export async function signInUser(
  email: string,
  password: string
): Promise<
  | { ok: true; user: AuthenticatedUser; projects: ProjectRecord[] }
  | { ok: false; error: string }
> {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error || !data.user || !data.session) {
      return { ok: false, error: error?.message || 'Invalid credentials.' };
    }
    const user: AuthenticatedUser = {
      id: data.user.id,
      email: data.user.email || email.trim(),
      accessToken: data.session.access_token,
      expiresAt: data.session.expires_at ? data.session.expires_at * 1000 : undefined,
      authProvider: 'supabase-jwt',
    };
    const projects = await fetchUserProjects(user);
    return { ok: true, user, projects };
  }

  try {
    const res = await fetch('/api/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.user) {
      const errMsg =
        typeof body.error?.message === 'string'
          ? body.error.message
          : typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string'
          ? body.error
          : `Sign-in failed (HTTP ${res.status}).`;
      return { ok: false, error: errMsg };
    }
    writeStoredLocalSession(body.user);
    return {
      ok: true,
      user: body.user,
      projects: Array.isArray(body.projects) ? body.projects : [],
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unable to reach authentication server.' };
  }
}

export async function signOutUser(): Promise<void> {
  if (supabase) {
    await supabase.auth.signOut().catch(() => {});
  }
  const token = readStoredLocalSession()?.accessToken;
  writeStoredLocalSession(null);
  if (token) {
    await fetch('/api/auth/signout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

export async function resetUserPassword(
  email: string
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const cleanEmail = email.trim();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  if (supabase) {
    const redirectTo =
      typeof window !== 'undefined' && window.location
        ? `${window.location.origin}/`
        : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return {
      ok: true,
      message: `Password recovery link requested via Supabase Auth for ${cleanEmail}. Check your inbox.`,
    };
  }

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Password reset request failed.',
      };
    }
    return {
      ok: true,
      message:
        body.message ||
        `Local password reset acknowledged for ${cleanEmail} (connect live Supabase Auth tomorrow to send recovery emails).`,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unable to reach authentication server.' };
  }
}

export async function fetchUserProjects(
  currentUser?: AuthenticatedUser | null
): Promise<ProjectRecord[]> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('owner_id', currentUser.id)
      .order('updated_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      if (data.length === 0) {
        const created = await createUserProject(
          {
            name: 'Core Engineering Repository',
            repository: 'github.com/org/core-services',
            defaultBranch: 'main',
            retentionMode: 'redacted_snippets_only',
          },
          currentUser
        );
        return created.ok ? [created.project] : [];
      }
      return data.map((row) => mapProjectRowToRecord(row as DbProjectRow));
    }
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) return [];
  try {
    const res = await fetch('/api/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.projects) ? body.projects : [];
  } catch {
    return [];
  }
}

export async function fetchProjectById(
  projectId: string,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('owner_id', currentUser.id)
      .maybeSingle();

    if (error || !data) {
      return { ok: false, error: error?.message || 'Project not found or access denied.' };
    }
    return { ok: true, project: mapProjectRowToRecord(data as DbProjectRow) };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required.' };
  }
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.project) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Project not found.',
      };
    }
    return { ok: true, project: body.project };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error loading project.' };
  }
}

export async function createUserProject(
  input: {
    name: string;
    repository?: string;
    defaultBranch?: string;
    retentionMode?: SourceRetentionMode;
  },
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const slug =
      input.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') +
      '-' +
      Date.now().toString(36).slice(-4);

    const { data, error } = await supabase
      .from('projects')
      .insert({
        owner_id: currentUser.id,
        name: input.name.trim(),
        slug,
        repository: (input.repository || '').trim(),
        default_branch: (input.defaultBranch || 'main').trim(),
        retention_mode: input.retentionMode || 'redacted_snippets_only',
      })
      .select('*')
      .single();

    if (error || !data) {
      return { ok: false, error: error?.message || 'Failed to create project in Supabase.' };
    }
    return { ok: true, project: mapProjectRowToRecord(data as DbProjectRow) };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required to create a project.' };
  }

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.project) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to create project.',
      };
    }
    return { ok: true, project: body.project };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error creating project.' };
  }
}

export async function updateUserProject(
  projectId: string,
  updates: {
    name?: string;
    repository?: string;
    defaultBranch?: string;
    retentionMode?: SourceRetentionMode;
  },
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const dbPatch: Record<string, unknown> = {};
    if (updates.name !== undefined) dbPatch.name = updates.name.trim();
    if (updates.repository !== undefined) dbPatch.repository = updates.repository.trim();
    if (updates.defaultBranch !== undefined) dbPatch.default_branch = updates.defaultBranch.trim();
    if (updates.retentionMode !== undefined) dbPatch.retention_mode = updates.retentionMode;

    const { data, error } = await supabase
      .from('projects')
      .update(dbPatch)
      .eq('id', projectId)
      .eq('owner_id', currentUser.id)
      .select('*')
      .single();

    if (error || !data) {
      return { ok: false, error: error?.message || 'Failed to update project.' };
    }
    return { ok: true, project: mapProjectRowToRecord(data as DbProjectRow) };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required.' };
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updates),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.project) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to update project.',
      };
    }
    return { ok: true, project: body.project };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error updating project.' };
  }
}

export async function updateProjectRetentionSetting(
  projectId: string,
  retentionMode: SourceRetentionMode,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  return updateUserProject(projectId, { retentionMode }, currentUser);
}

export async function deleteUserProject(
  projectId: string,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('owner_id', currentUser.id);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required.' };
  }
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to delete project.',
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error deleting project.' };
  }
}

export async function fetchPersistedReviews(
  currentUser?: AuthenticatedUser | null,
  projectId?: string
): Promise<{ ok: true; reviews: ReviewRecord[] } | { ok: false; error: string; authExpired?: boolean }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    let query = supabase
      .from('reviews')
      .select('*, projects(name), findings(*)')
      .eq('owner_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;
    if (error) {
      return { ok: false, error: error.message };
    }

    const reviews: ReviewRecord[] = (data || []).map((row: any) => {
      const fRows: DbFindingRow[] = Array.isArray(row.findings) ? row.findings : [];
      const projName: string | undefined = row.projects?.name;
      return mapDatabaseRowsToReviewRecord(row as DbReviewRow, fRows, projName);
    });

    return { ok: true, reviews };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Not signed in.', authExpired: true };
  }

  try {
    const url = projectId
      ? `/api/reviews?projectId=${encodeURIComponent(projectId)}`
      : '/api/reviews';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      return { ok: false, error: 'Session expired.', authExpired: true };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to fetch persisted reviews.',
      };
    }
    return { ok: true, reviews: Array.isArray(body.reviews) ? body.reviews : [] };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to connect to review persistence service.' };
  }
}

export async function fetchReviewById(
  reviewId: string,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; review: ReviewRecord } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { data, error } = await supabase
      .from('reviews')
      .select('*, projects(name), findings(*)')
      .eq('owner_id', currentUser.id)
      .or(`client_review_id.eq.${reviewId},id.eq.${reviewId}`)
      .maybeSingle();

    if (error || !data) {
      return { ok: false, error: error?.message || 'Review not found or access denied.' };
    }
    const fRows: DbFindingRow[] = Array.isArray((data as any).findings)
      ? (data as any).findings
      : [];
    const projName: string | undefined = (data as any).projects?.name;
    return {
      ok: true,
      review: mapDatabaseRowsToReviewRecord(data as DbReviewRow, fRows, projName),
    };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required.' };
  }
  try {
    const res = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.review) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Review not found.',
      };
    }
    return { ok: true, review: body.review };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error retrieving review.' };
  }
}

export async function updatePersistedFindingStatus(
  reviewId: string,
  findingId: string,
  nextStatus: FindingStatus,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true; review?: ReviewRecord } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { error } = await supabase
      .from('findings')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('owner_id', currentUser.id)
      .eq('client_finding_id', findingId);

    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required to update finding status.' };
  }

  try {
    const res = await fetch(
      `/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to update finding status.',
      };
    }
    return { ok: true, review: body.review };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error updating finding status.' };
  }
}

export async function deletePersistedReview(
  reviewId: string,
  currentUser?: AuthenticatedUser | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (supabase && currentUser?.authProvider === 'supabase-jwt') {
    const { error } = await supabase
      .from('reviews')
      .delete()
      .eq('owner_id', currentUser.id)
      .eq('client_review_id', reviewId);

    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  const token = currentUser?.accessToken || (await getActiveAccessToken());
  if (!token) {
    return { ok: false, error: 'Authentication required to delete review.' };
  }

  try {
    const res = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: body.error?.message || body.error || 'Failed to delete review.',
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Network error deleting review.' };
  }
}

