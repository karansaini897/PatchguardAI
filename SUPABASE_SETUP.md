# PatchGuard AI — Tomorrow's Supabase Setup & Production Guide (`SUPABASE_SETUP.md`)

Follow this step-by-step runbook tomorrow when you create your live Supabase project. All database migrations, Row Level Security (RLS) policies, Edge Functions, REST APIs, and frontend authentication flows are already implemented in this repository.

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
   - **Project API Keys → `service_role` / `secret` key**: Privileged server-only key that bypasses RLS. **Never** put this key in `VITE_*` variables or browser code.

---

## Step 3: Configure Local Environment Variables
1. Copy `.env.example` to `.env.local` in the repository root:
   ```bash
   cp .env.example .env.local
   ```
2. Edit `.env.local` and fill in your credentials (`.gitignore` already excludes `.env*` files while keeping `!.env.example`):
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
   ```

### Public Client Configuration vs. Privileged Server Secrets
| Variable | Scope | Purpose |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Public (Browser) | Identifies your Supabase project endpoint for Auth & RLS-scoped PostgREST queries. |
| `VITE_SUPABASE_ANON_KEY` | Public (Browser) | Publishable key used alongside the user's Bearer JWT; subject to PostgreSQL RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-Only Secret** | Bypasses RLS. Never required by the browser; guarded by `assertNoClientSideSecretLeakage()`. |
| `GEMINI_API_KEY` | **Server-Only Secret** | Authenticates server/Edge calls to `gemini-3.1-flash-lite`. Never exposed to client code. |

---

## Step 4: Apply Database Migrations (`20261028000001_patchguard_phase1.sql`)

You can apply the version-controlled SQL migration via either the **Supabase SQL Editor** (fastest, zero CLI setup) or the **Supabase CLI**:

### Option A — Supabase Dashboard SQL Editor
1. Open **SQL Editor → New query** in your Supabase Dashboard.
2. Paste the entire contents of `supabase/migrations/20261028000001_patchguard_phase1.sql`.
3. Click **Run**. Confirm that `public.projects`, `public.reviews`, and `public.findings` appear under **Table Editor** with the lock icon indicating **RLS Enabled**.

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
```
(`SUPABASE_URL` and `SUPABASE_ANON_KEY` are automatically injected by the Supabase Edge runtime.)

---

## Step 7: Deploy Supabase Edge Functions (Optional when using Express `/api/review`)
PatchGuard AI includes Deno-compatible Edge Functions in `supabase/functions/`:
- `supabase/functions/analyze-review/index.ts` (`POST /functions/v1/analyze-review`)
- `supabase/functions/review-code/index.ts` (`POST /functions/v1/review-code`)
- `supabase/functions/health/index.ts` (`GET /functions/v1/health`)

Because `src/lib/staticAnalyzer.ts`, `src/lib/reviewOrchestrator.ts`, and `src/lib/supabaseBackendCore.ts` use zero Node-only APIs, they run natively in both the Deno Edge Runtime and the Express server (`server.ts`).

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
# 1. Run complete unit & backend integration test suite
npm test

# 2. Run TypeScript static typecheck
npm run lint

# 3. Build production frontend bundle
npm run build
```

---

## Step 10: Create Test Accounts & Verify Row Level Security (RLS)
1. Open the app at `http://localhost:3000` and navigate to **New Review** or **History**.
2. Select **Create Account** and register `alice@example.com`.
3. Create a project named `Alice Payments Service`.
4. Sign out from the header menu, then register a second account `bob@example.com`.
5. Verify that `bob@example.com` **cannot** see `Alice Payments Service` or any of Alice's reviews/findings, confirming `projects_select_own`, `reviews_select_own`, and `findings_select_own` RLS isolation.

---

## Step 11: Perform a Real Code Review & Check Persisted Findings
1. While signed in, open **New Review**.
2. Select your project and choose a **Source-Code Retention Policy**:
   - **`redacted_snippets_only` (Default)**: Redacts secrets (`[REDACTED_SECRET]`) and omits non-evidence source lines outside `±4` lines around verified findings so full proprietary files are not stored unnecessarily in PostgreSQL.
   - **`redacted_full_source`**: Redacts secrets and retains full source files for cross-device browsing.
3. Click **Execute Code Review**.
4. Inspect the findings in the **Review Workspace**, change a finding's status to **Reviewed** or **Dismissed**, and refresh the browser (`Cmd+R` / `F5`).
5. Confirm that your session, project, review record, and updated finding status persist across reloads in **Review History** and in **Supabase Dashboard → Table Editor → `reviews` / `findings`**.
6. To delete stored source snippets and findings at any time, click the delete action on a review in **Review History** (or delete the parent project), which triggers PostgreSQL `ON DELETE CASCADE`.

---

## Step 12: Troubleshooting Common Errors
- **`401 AUTH_REQUIRED`**: Your session token is missing or expired. Sign out and sign back in to refresh your JWT.
- **`403 FORBIDDEN_PROJECT`**: The `projectId` in the request does not belong to `auth.uid()`. Select a project owned by your signed-in account.
- **`413 PAYLOAD_TOO_LARGE`**: The request body exceeds `256 KB`, contains more than `20` files, or includes a single file larger than `120 KB`. Scope the review to modified files or diff hunks.
- **`429 RATE_LIMIT_EXCEEDED` / `AI_RATE_LIMIT`**: Either the per-user sliding-window rate limiter (`30` reviews/min) or upstream Gemini quota was reached. Wait 15–30 seconds or run in **Static Analyzer Only** mode.
- **`503 MISSING_SERVER_CONFIG`**: `GEMINI_API_KEY` is not set in `.env.local` or Edge Function secrets. Configure `GEMINI_API_KEY` and click **Probe AI Connectivity** in **Settings & Diagnostics**.

---

## Step 13: Deploying Frontend & Backend to Production
1. Build the production assets:
   ```bash
   npm run build
   ```
2. Set production environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GEMINI_API_KEY`, `NODE_ENV=production`) in your hosting provider (Cloud Run, Fly.io, Render, or Railway).
3. Update **Supabase Dashboard → Authentication → URL Configuration → Site URL** to your production HTTPS URL.
4. Start the production server:
   ```bash
   npm start
   ```
