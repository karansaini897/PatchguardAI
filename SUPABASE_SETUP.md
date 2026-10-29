# PatchGuard AI — Tomorrow's Supabase Setup & Production Guide (`SUPABASE_SETUP.md`)

Follow this step-by-step runbook when you create your live Supabase project. All database migrations, Row Level Security (RLS) policies, Deno Edge Functions, REST APIs, and frontend authentication flows are implemented and verified in this repository.

---

## Step 1: Create Your Supabase Project & Choose a Region
1. Sign in to [https://supabase.com/dashboard](https://supabase.com/dashboard) and click **New project**.
2. Name the project `patchguard-ai` (or your preferred environment name).
3. Generate a strong database password and store it in your password manager (PatchGuard AI's browser client never uses the database password).
4. Choose a cloud region close to your primary users (e.g., `us-east-1`, `eu-west-1`, or `ap-northeast-1`).
5. Wait ~60–90 seconds for PostgreSQL and Auth provisioning to complete.

---

## Step 2: Find Your Project URL and Publishable / Anon Key
1. In the Supabase Dashboard sidebar, open **Project Settings (gear icon) → API**.
2. Locate:
   - **Project URL**: `https://<your-project-ref>.supabase.co`
   - **Project API Keys → `anon` / `publishable` key**: Safe for browser usage **because** all tables in `public` have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
   - **Project API Keys → `service_role` / `secret` key**: Privileged server-only administrative key that bypasses RLS. **Never** put this key in `VITE_*` variables or browser code. Standard API routes and Edge Functions use `SUPABASE_ANON_KEY` + the caller's Bearer JWT for least-privilege RLS enforcement.

---

## Step 3: Configure Local Environment Variables
1. Copy `.env.example` to `.env.local` in the repository root:
   ```bash
   cp .env.example .env.local
   ```
2. Edit `.env.local` and fill in your credentials (`.gitignore` excludes `.env*` files while preserving `!.env.example`):
   ```env
   # Browser-safe public configuration (exposed to Vite client)
   VITE_SUPABASE_URL="https://<your-project-ref>.supabase.co"
   VITE_SUPABASE_ANON_KEY="<your-supabase-anon-or-publishable-key>"
   VITE_SUPABASE_EDGE_FUNCTION_URL=""

   # Server-only configuration (NEVER prefix with VITE_)
   SUPABASE_URL="https://<your-project-ref>.supabase.co"
   SUPABASE_ANON_KEY="<your-supabase-anon-or-publishable-key>"
   SUPABASE_SERVICE_ROLE_KEY="<your-supabase-service-role-key-optional>"
   GEMINI_API_KEY="<your-real-gemini-api-key>"
   APP_URL="http://localhost:3000"
   ALLOWED_ORIGINS="http://localhost:3000"
   ALLOW_LOCAL_DEV_AUTH="false"
   ```

### Public Client Configuration vs. Privileged Server Secrets
| Variable | Scope | Purpose |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Public (Browser) | Identifies your Supabase project endpoint for Auth & RLS-scoped PostgREST queries. |
| `VITE_SUPABASE_ANON_KEY` | Public (Browser) | Publishable key used alongside the user's Bearer JWT; subject to PostgreSQL RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-Only Secret** | Bypasses RLS. Never required by the browser or standard user routes; guarded by `assertNoClientSideSecretLeakage()` (which also decodes JWT role claims). |
| `GEMINI_API_KEY` | **Server-Only Secret** | Authenticates server/Edge calls to `gemini-3.1-flash-lite`. Never exposed to client code. |
| `ALLOW_LOCAL_DEV_AUTH` | **Dev-Only Toggle** | Enables the isolated in-memory scrypt auth sandbox **only** when `NODE_ENV !== 'production'` and live Supabase is unconfigured. Automatically refused when `NODE_ENV=production` or when live `SUPABASE_URL` is set. |

---

## Step 4: Apply Database Migrations (`20261028000001_patchguard_phase1.sql`)

> **Important Note**: This migration file has been statically and relationally verified against the TypeScript backend rows (`DbProjectRow`, `DbReviewRow`, `DbFindingRow`), composite foreign keys, and RLS policies, but **has not yet been executed against a live Supabase database** because your Supabase project has not been created yet.

You can apply the version-controlled SQL migration via either the **Supabase SQL Editor** or the **Supabase CLI**:

### Option A — Supabase Dashboard SQL Editor
1. Open **SQL Editor → New query** in your Supabase Dashboard.
2. Paste the entire contents of `supabase/migrations/20261028000001_patchguard_phase1.sql`.
3. Click **Run**. Confirm that `public.projects`, `public.reviews`, and `public.findings` appear under **Table Editor** with **RLS Enabled**.

### Option B — Supabase CLI
```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

---

## Step 5: Configure Authentication URLs & Email Settings
1. In the Supabase Dashboard, open **Authentication → URL Configuration**:
   - Set **Site URL** to `http://localhost:3000` (or your production domain when deploying).
   - Add Redirect URLs under **Redirect URLs**:
     - `http://localhost:3000`
     - `http://localhost:3000/**`
2. Open **Authentication → Providers → Email**:
   - Ensure **Enable Email provider** is enabled.
   - **Development tip**: If you have not configured a custom SMTP provider yet and want immediate sign-up without email confirmation links, toggle **Confirm email** to **OFF** during initial testing. In production with SMTP configured, keep **Confirm email** **ON**.

---

## Step 6: Set Server-Side Gemini & Supabase Secrets
To configure secrets for Supabase Edge Functions:
```bash
npx supabase secrets set GEMINI_API_KEY="<your-real-gemini-api-key>"
npx supabase secrets set ALLOWED_ORIGINS="http://localhost:3000"
```
(`SUPABASE_URL` and `SUPABASE_ANON_KEY` are automatically injected by the Supabase Edge runtime.)

---

## Step 7: Deploy Supabase Edge Functions (Optional when using Express `/api/review`)
PatchGuard AI includes Deno-compatible Edge Functions in `supabase/functions/` with `supabase/functions/import_map.json` and `supabase/functions/deno.json` configured in `supabase/config.toml`:
- `supabase/functions/analyze-review/index.ts` (`POST /functions/v1/analyze-review`)
- `supabase/functions/review-code/index.ts` (`POST /functions/v1/review-code`)
- `supabase/functions/health/index.ts` (`GET /functions/v1/health`)

To deploy the Edge Functions to your Supabase project:
```bash
npx supabase functions deploy analyze-review
npx supabase functions deploy review-code
npx supabase functions deploy health --no-verify-jwt
```

---

## Step 8: Start the Application Locally
Install dependencies and start the full-stack development server on port `3000`:
```bash
npm install
npm run dev
```
Open `http://localhost:3000`.

---

## Step 9: Run Automated Tests, Typecheck & Build Verification
Execute the repository's deterministic verification commands:
```bash
# 1. Run complete unit & backend security/integration test suite
npm test

# 2. Run TypeScript static typecheck
npm run lint

# 3. Build production frontend bundle
npm run build
```

---

## Step 10: Create Test Accounts & Verify Row Level Security (RLS)
1. Open the app at `http://localhost:3000` and navigate to **New Review** or **History**.
2. Select **Create Account** and register `alice@example.com` with a strong password (minimum 8 characters; no default accounts are pre-seeded).
3. Create a project named `Alice Payments Service`.
4. Sign out from the header menu, then register a second account `bob@example.com`.
5. Verify that `bob@example.com` **cannot** see `Alice Payments Service` or any of Alice's reviews/findings, and any direct API call by Bob referencing Alice's `projectId` or `reviewId` is rejected with `403 FORBIDDEN_PROJECT`.

---

## Step 11: Perform a Real Code Review & Check Persisted Findings
1. While signed in, open **New Review**.
2. Select your project and choose a **Source-Code Retention Policy**:
   - **`redacted_snippets_only` (Default)**: Redacts secrets (`[REDACTED_SECRET]`) and omits non-evidence source lines outside `±4` lines around verified findings so full proprietary files are not stored unnecessarily in PostgreSQL.
   - **`redacted_full_source`**: Redacts secrets and retains full source files for cross-device browsing.
3. Click **Execute Code Review**.
4. Inspect the findings in the **Review Workspace**, change a finding's status to **Reviewed** or **Dismissed**, and refresh the browser (`Cmd+R` / `F5`).
5. Confirm that your session, project, review record, and updated finding status persist across reloads in **Review History** and in **Supabase Dashboard → Table Editor → `reviews` / `findings`**.

---

## Step 12: Troubleshooting Common Errors & Known Limitations Before Live Supabase Setup
- **Local Development Sandbox Limitations (Before Step 3)**:
  - When `VITE_SUPABASE_URL` is not configured and `NODE_ENV !== 'production'`, the Express server runs `IsolatedLocalDevAuthStore` (`src/lib/localAuthSecurity.ts`) and `RlsEnforcedPostgresMirror`.
  - No default accounts or hardcoded credentials exist; you must click **Create Account** to register a local session.
  - Local sandbox accounts and reviews are stored in-memory for the life of the Node process and do not send real password-reset emails.
  - When `NODE_ENV=production` or once `SUPABASE_URL` + `SUPABASE_ANON_KEY` are configured, the local auth fallback is **automatically disabled** and refuses requests with `503 MISSING_SERVER_CONFIG`.
- **`401 AUTH_REQUIRED`**: Your session token is missing or expired. Sign out and sign back in to refresh your JWT.
- **`403 FORBIDDEN_PROJECT`**: The `projectId`, `reviewId`, or `ownerId` in the request does not belong to `auth.uid()`. Select a project owned by your signed-in account.
- **`413 PAYLOAD_TOO_LARGE`**: The request body exceeds `256 KB`, contains more than `20` files, or includes a single file larger than `120 KB`.
- **`429 RATE_LIMIT_EXCEEDED` / `AI_RATE_LIMIT`**: Either the per-user sliding-window rate limiter (`30` reviews/min) or upstream Gemini quota was reached.
- **`503 MISSING_SERVER_CONFIG`**: `GEMINI_API_KEY` is not set (when running AI-only mode), or local auth was called in production without `SUPABASE_URL` / `SUPABASE_ANON_KEY`.

---

## Step 13: Deploying Frontend & Backend to Production
1. Build the production assets:
   ```bash
   npm run build
   ```
2. Set production environment variables (`NODE_ENV=production`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GEMINI_API_KEY`, `ALLOWED_ORIGINS=https://your-domain.com`) in your hosting provider. Do **not** set `ALLOW_LOCAL_DEV_AUTH=true` in production (the server will refuse to start).
3. Update **Supabase Dashboard → Authentication → URL Configuration → Site URL** to your production HTTPS URL.
4. Start the production server:
   ```bash
   npm start
   ```
