-- ============================================================================
-- PatchGuard AI — Backend Phase 1: Schema, Constraints, Indexes & RLS Policies
-- Migration: 20261028000001_patchguard_phase1.sql
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Automatic updated_at Trigger Function
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Table: public.projects
-- Stores user-owned code repositories / workspaces and source-retention policy
-- ----------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  repository text not null default '',
  default_branch text not null default 'main',
  retention_mode text not null default 'redacted_snippets_only',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint projects_name_length_chk
    check (char_length(btrim(name)) between 1 and 120),
  constraint projects_slug_length_chk
    check (char_length(btrim(slug)) between 1 and 140),
  constraint projects_retention_mode_chk
    check (retention_mode in ('redacted_snippets_only', 'redacted_full_source')),
  constraint projects_owner_slug_unique
    unique (owner_id, slug),
  constraint projects_id_owner_unique
    unique (id, owner_id)
);

create index if not exists idx_projects_owner_updated
  on public.projects (owner_id, updated_at desc);

drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Table: public.reviews
-- Stores review executions, status, stage telemetry, and retained file manifest
-- ----------------------------------------------------------------------------
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_review_id text not null,
  request_id text not null,
  title text not null,
  objective text not null default '',
  status text not null,
  analysis_mode text not null default 'hybrid',
  model_used text not null default 'pg-static-ast-1.4.2',
  duration_ms integer not null default 0,
  focus_areas text[] not null default '{}',
  summary text not null default '',
  warning_message text,
  error_details jsonb,
  stages jsonb not null default '[]'::jsonb,
  files_manifest jsonb not null default '[]'::jsonb,
  retention_policy jsonb not null default '{"mode":"redacted_snippets_only","secretsRedacted":true,"rawSourcePurged":true}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint reviews_title_length_chk
    check (char_length(btrim(title)) between 1 and 240),
  constraint reviews_status_chk
    check (status in (
      'queued',
      'processing',
      'in_progress',
      'completed',
      'completed_static_only',
      'completed_with_warnings',
      'failed',
      'cancelled'
    )),
  constraint reviews_analysis_mode_chk
    check (analysis_mode in ('hybrid', 'static-only', 'ai-only')),
  constraint reviews_duration_non_negative_chk
    check (duration_ms >= 0),
  constraint reviews_owner_client_id_unique
    unique (owner_id, client_review_id),
  constraint reviews_id_project_owner_unique
    unique (id, project_id, owner_id),
  constraint reviews_project_owner_fk
    foreign key (project_id, owner_id)
    references public.projects (id, owner_id)
    on delete cascade
);

create index if not exists idx_reviews_owner_created
  on public.reviews (owner_id, created_at desc);

create index if not exists idx_reviews_project_created
  on public.reviews (project_id, created_at desc);

create index if not exists idx_reviews_status
  on public.reviews (status);

drop trigger if exists trg_reviews_updated_at on public.reviews;
create trigger trg_reviews_updated_at
  before update on public.reviews
  for each row
  execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Table: public.findings
-- Stores verified and quarantined findings bound to a review and project
-- ----------------------------------------------------------------------------
create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_finding_id text not null,
  title text not null,
  severity text not null,
  confidence text not null,
  category text not null,
  status text not null default 'unreviewed',
  analysis_source text not null,
  rule_id text,
  uncertainty_note text,
  file_id text not null,
  file_path text not null,
  start_line integer not null default 0,
  end_line integer not null default 0,
  is_valid_location boolean not null default true,
  location_reason text not null default 'verified',
  validation_note text,
  code_snippet text not null default '',
  content_hash text,
  explanation text not null,
  potential_impact text not null,
  suggested_remediation text not null,
  remediation_code text,
  static_corroboration jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint findings_title_non_empty_chk
    check (char_length(btrim(title)) >= 1),
  constraint findings_severity_chk
    check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  constraint findings_confidence_chk
    check (confidence in ('high', 'medium', 'low')),
  constraint findings_category_chk
    check (category in (
      'security',
      'concurrency',
      'boundary',
      'error-handling',
      'performance',
      'correctness',
      'data-integrity',
      'maintainability'
    )),
  constraint findings_status_chk
    check (status in ('unreviewed', 'reviewed', 'dismissed', 'reopened')),
  constraint findings_analysis_source_chk
    check (analysis_source in ('ai-gemini', 'static-pattern', 'corroborated')),
  constraint findings_location_reason_chk
    check (location_reason in (
      'verified',
      'out_of_bounds',
      'wrong_file',
      'missing_line',
      'source_changed',
      'insufficient_evidence'
    )),
  constraint findings_line_bounds_chk
    check ((is_valid_location = false) or (start_line >= 1 and end_line >= start_line)),
  constraint findings_review_client_id_unique
    unique (review_id, client_finding_id),
  constraint findings_review_project_owner_fk
    foreign key (review_id, project_id, owner_id)
    references public.reviews (id, project_id, owner_id)
    on delete cascade
);

create index if not exists idx_findings_review_severity
  on public.findings (review_id, severity);

create index if not exists idx_findings_project_status
  on public.findings (project_id, status);

create index if not exists idx_findings_owner_status_severity
  on public.findings (owner_id, status, severity);

drop trigger if exists trg_findings_updated_at on public.findings;
create trigger trg_findings_updated_at
  before update on public.findings
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- 5. Row Level Security (RLS) Policies
-- Strictly enforces tenant isolation so authenticated users can only read or
-- mutate their own projects, reviews, and findings, and verifies parent-record
-- ownership on relational inserts and updates.
-- ============================================================================

alter table public.projects enable row level security;
alter table public.projects force row level security;

alter table public.reviews enable row level security;
alter table public.reviews force row level security;

alter table public.findings enable row level security;
alter table public.findings force row level security;

-- 5.1 Policies for public.projects
drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects
  for select
  to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own"
  on public.projects
  for insert
  to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own"
  on public.projects
  for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own"
  on public.projects
  for delete
  to authenticated
  using (auth.uid() = owner_id);

-- 5.2 Policies for public.reviews (Verifies both review owner_id and parent project ownership)
drop policy if exists "reviews_select_own" on public.reviews;
create policy "reviews_select_own"
  on public.reviews
  for select
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.projects p
      where p.id = reviews.project_id
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "reviews_insert_own" on public.reviews;
create policy "reviews_insert_own"
  on public.reviews
  for insert
  to authenticated
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.projects p
      where p.id = reviews.project_id
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "reviews_update_own" on public.reviews;
create policy "reviews_update_own"
  on public.reviews
  for update
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.projects p
      where p.id = reviews.project_id
        and p.owner_id = auth.uid()
    )
  )
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.projects p
      where p.id = reviews.project_id
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "reviews_delete_own" on public.reviews;
create policy "reviews_delete_own"
  on public.reviews
  for delete
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.projects p
      where p.id = reviews.project_id
        and p.owner_id = auth.uid()
    )
  );

-- 5.3 Policies for public.findings (Verifies finding owner_id, parent review ownership, and project ownership)
drop policy if exists "findings_select_own" on public.findings;
create policy "findings_select_own"
  on public.findings
  for select
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.reviews r
      join public.projects p on p.id = r.project_id
      where r.id = findings.review_id
        and r.project_id = findings.project_id
        and r.owner_id = auth.uid()
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "findings_insert_own" on public.findings;
create policy "findings_insert_own"
  on public.findings
  for insert
  to authenticated
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.reviews r
      join public.projects p on p.id = r.project_id
      where r.id = findings.review_id
        and r.project_id = findings.project_id
        and r.owner_id = auth.uid()
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "findings_update_own" on public.findings;
create policy "findings_update_own"
  on public.findings
  for update
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.reviews r
      join public.projects p on p.id = r.project_id
      where r.id = findings.review_id
        and r.project_id = findings.project_id
        and r.owner_id = auth.uid()
        and p.owner_id = auth.uid()
    )
  )
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.reviews r
      join public.projects p on p.id = r.project_id
      where r.id = findings.review_id
        and r.project_id = findings.project_id
        and r.owner_id = auth.uid()
        and p.owner_id = auth.uid()
    )
  );

drop policy if exists "findings_delete_own" on public.findings;
create policy "findings_delete_own"
  on public.findings
  for delete
  to authenticated
  using (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.reviews r
      join public.projects p on p.id = r.project_id
      where r.id = findings.review_id
        and r.project_id = findings.project_id
        and r.owner_id = auth.uid()
        and p.owner_id = auth.uid()
    )
  );
