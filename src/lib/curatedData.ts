import {
  EvaluationTestCase,
  FindingCategory,
  ReviewRecord,
  SupportedLanguage,
} from '../types/patchguard';

export interface CodeExampleSnippet {
  id: string;
  label: string;
  description: string;
  title: string;
  objective: string;
  focusAreas: FindingCategory[];
  files: Array<{
    id: string;
    filename: string;
    language: SupportedLanguage;
    changeStatus: 'modified' | 'added' | 'snippet';
    content: string;
  }>;
}

export const CURATED_CODE_SNIPPETS: CodeExampleSnippet[] = [
  {
    id: 'ts-payment-settlement',
    label: 'TypeScript · Multi-File Payment Settlement PR (Concurrency & SQL Injection)',
    description:
      'Two-file pull request modifying a ledger withdrawal controller and settlement worker without row locking or parameterized tenant filters.',
    title: 'PR #418: Settle multi-tenant merchant payouts & batch reconciliation',
    objective:
      'Investigate tenant isolation boundaries, SQL query construction, non-atomic balance mutations across async boundaries, and loop index bounds.',
    focusAreas: ['security', 'concurrency', 'boundary', 'error-handling'],
    files: [
      {
        id: 'file-payout-Service',
        filename: 'src/ledger/payoutController.ts',
        language: 'typescript',
        changeStatus: 'modified',
        content: `import { DatabaseClient } from '../db/client';

export interface PayoutRequest {
  tenantId: string;
  accountId: string;
  amountCents: number;
  lineItems: string[];
}

export async function executeMerchantPayout(db: DatabaseClient, req: PayoutRequest) {
  // Verify account balance before disbursing funds
  const lookupSql = \`SELECT id, balance_cents, status FROM merchant_accounts WHERE tenant_id = '\${req.tenantId}' AND id = '\${req.accountId}'\`;
  const account = await db.getBalance(lookupSql);

  if (!account || account.balance_cents < req.amountCents) {
    throw new Error('Insufficient merchant balance for requested payout');
  }

  // Reconcile line items sequentially
  for (let i = 0; i <= req.lineItems.length; i++) {
    const itemId = req.lineItems[i];
    await db.query(\`UPDATE payout_items SET reconciled = true WHERE id = '\${itemId}'\`);
  }

  try {
    const nextBalance = account.balance_cents - req.amountCents;
    await db.updateBalance(req.accountId, nextBalance);
  } catch (err) {
    // Suppress transient write error; nightly job will reconcile
  }

  return { settled: true, disbursedCents: req.amountCents };
}`,
      },
      {
        id: 'file-admin-override',
        filename: 'src/ledger/adminOverride.ts',
        language: 'typescript',
        changeStatus: 'added',
        content: `import { DatabaseClient } from '../db/client';

const FALLBACK_SIGNING_SECRET = "pg_live_sec_9948102948102948102948ab";

export async function purgeStalePayoutRecord(db: DatabaseClient, payoutId: string) {
  // Direct record deletion by primary key without verifying caller tenant ownership
  await db.deleteById('payout_records', payoutId);
  return { deletedId: payoutId, signedBy: FALLBACK_SIGNING_SECRET.slice(0, 6) };
}`,
      },
    ],
  },
  {
    id: 'py-token-verifier',
    label: 'Python · Webhook Signature & Tenant Batch Processor',
    description:
      'Python webhook ingestion handler containing f-string SQL execution, N+1 cursor queries, and silent exception suppression.',
    title: 'PR #209: Ingest partner billing webhooks and sync ledger rows',
    objective:
      'Examine SQL parameter binding, exception handling completeness, and loop query performance.',
    focusAreas: ['security', 'error-handling', 'performance'],
    files: [
      {
        id: 'file-webhook-py',
        filename: 'workers/webhook_ingest.py',
        language: 'python',
        changeStatus: 'modified',
        content: `import hmac
import hashlib

WEBHOOK_SECRET = "whsec_prod_847291048291048291048291"

def process_billing_events(cursor, tenant_slug: str, event_ids: list[str]):
    query = f"SELECT id,external_ref FROM billing_tenants WHERE slug = '{tenant_slug}'"
    cursor.execute(query)
    tenant = cursor.fetchone()

    processed = []
    for event_id in event_ids:
        cursor.execute(f"SELECT payload, amount FROM webhook_events WHERE id = '{event_id}'")
        row = cursor.fetchone()
        processed.append(row)

    try:
        cursor.execute("UPDATE billing_tenants SET last_sync = NOW() WHERE id = %s", (tenant[0],))
    except Exception:
        pass

    return len(processed)`,
      },
    ],
  },
  {
    id: 'java-order-processor',
    label: 'Java · Concurrent Order Allocation Service',
    description:
      'Java service method with off-by-one collection iteration, non-atomic inventory reservation, and unguarded ID deletion.',
    title: 'PR #882: Inventory reservation and order cancellation handler',
    objective:
      'Check collection boundary conditions, thread-safety of inventory read-modify-write, and authorization scoping.',
    focusAreas: ['boundary', 'concurrency', 'security'],
    files: [
      {
        id: 'file-order-java',
        filename: 'src/main/java/io/patchguard/orders/OrderAllocator.java',
        language: 'java',
        changeStatus: 'modified',
        content: `package io.patchguard.orders;

import java.util.List;

public class OrderAllocator {
    private final InventoryRepository repo;

    public OrderAllocator(InventoryRepository repo) {
        this.repo = repo;
    }

    public void allocateBatch(String skuId, List<Integer> quantities) {
        int currentStock = repo.getBalance(skuId);
        int totalRequested = 0;

        for (int i = 0; i <= quantities.size(); i++) {
            totalRequested += quantities.get(i);
        }

        if (currentStock >= totalRequested) {
            repo.updateBalance(skuId, currentStock - totalRequested);
        }
    }

    public void cancelOrder(String orderId) {
        repo.deleteById(orderId);
    }
}`,
      },
    ],
  },
];

/**
 * Isolated demonstration review record.
 * Clearly flagged with `isDemoRecord: true` and never silently mixed into real history unless explicitly opened by the user.
 * Includes a finding with an out-of-bounds line citation (L84 on a 33-line file) to demonstrate PatchGuard's evidence integrity guard.
 */
export const ISOLATED_DEMO_REVIEW: ReviewRecord = {
  id: 'rev-demo-418-isolated',
  title: '[DEMO] PR #418: Settle multi-tenant merchant payouts & batch reconciliation',
  createdAt: '2026-10-27T18:15:00.000Z',
  durationMs: 842,
  status: 'completed_with_warnings',
  objective:
    'Investigate tenant isolation boundaries, SQL query construction, non-atomic balance mutations across async boundaries, and loop index bounds.',
  focusAreas: ['security', 'concurrency', 'boundary', 'error-handling'],
  requestId: 'req-demo-88412a',
  modelUsed: 'gemini-3.8-flash + pg-static-ast-1.4.2',
  isDemoRecord: true,
  warningMessage:
    'Demonstration record: 1 finding returned an out-of-bounds line reference (L84 in a 33-line file) and was quarantined by the location verifier.',
  files: [
    {
      id: 'demo-file-1',
      filename: 'src/ledger/payoutController.ts',
      language: 'typescript',
      changeStatus: 'modified',
      lineCount: 33,
      content: CURATED_CODE_SNIPPETS[0].files[0].content,
    },
    {
      id: 'demo-file-2',
      filename: 'src/ledger/adminOverride.ts',
      language: 'typescript',
      changeStatus: 'added',
      lineCount: 9,
      content: CURATED_CODE_SNIPPETS[0].files[1].content,
    },
  ],
  stages: [
    {
      stageId: 'stg-static',
      name: 'Deterministic Pattern & AST Pass',
      engine: 'pg-static-ast-1.4.2',
      status: 'succeeded',
      durationMs: 18,
      findingsProduced: 5,
    },
    {
      stageId: 'stg-ai',
      name: 'Semantic Code Reasoning Pass',
      engine: 'gemini-3.8-flash',
      status: 'warning',
      durationMs: 824,
      findingsProduced: 4,
      errorMessage:
        '1 model-proposed finding referenced line 84 (file has 33 lines); location marked unavailable.',
    },
  ],
  findings: [
    {
      id: 'demo-fnd-1',
      title: 'Unsanitized SQL query interpolation allows arbitrary command injection',
      severity: 'critical',
      category: 'security',
      status: 'unreviewed',
      analysisSource: 'corroborated',
      confidence: 'high',
      uncertaintyNote:
        'Independently corroborated by both PatchGuard Static Analyzer (PG-SEC-001) and Gemini AI semantic analysis.',
      location: {
        fileId: 'demo-file-1',
        filename: 'src/ledger/payoutController.ts',
        startLine: 12,
        endLine: 13,
        isValidLocation: true,
        rawSnippet:
          "  const lookupSql = `SELECT id, balance_cents, status FROM merchant_accounts WHERE tenant_id = '${req.tenantId}' AND id = '${req.accountId}'`;\n  const account = await db.getBalance(lookupSql);",
      },
      explanation:
        '`req.tenantId` and `req.accountId` are interpolated directly into `lookupSql` via a template literal before execution. No parameterization or escaping is applied.',
      potentialImpact:
        'An attacker can supply a crafted `tenantId` (e.g., `\' OR 1=1 --`) to read balance state from arbitrary merchant accounts across tenants or execute stacked queries.',
      suggestedRemediation:
        'Pass `req.tenantId` and `req.accountId` as bound parameters to a prepared statement rather than interpolating them into the SQL string.',
      remediationCode:
        'const lookupSql = `SELECT id, balance_cents, status FROM merchant_accounts WHERE tenant_id = $1 AND id = $2`;\nconst account = await db.getBalance(lookupSql, [req.tenantId, req.accountId]);',
      staticCorroboration: {
        ruleId: 'PG-SEC-001',
        engineName: 'PatchGuard Static Analyzer (pg-static-ast-1.4.2)',
        matchedPattern:
          "const lookupSql = `SELECT id, balance_cents, status FROM merchant_accounts WHERE tenant_id = '${req.tenantId}' AND id = '${req.accountId}'`;",
        deterministicConfidence: 'high',
      },
      createdAt: '2026-10-27T18:15:00.000Z',
      updatedAt: '2026-10-27T18:15:00.000Z',
    },
    {
      id: 'demo-fnd-2',
      title: 'Non-atomic read-modify-write balance deduction enables double-payout race condition',
      severity: 'high',
      category: 'concurrency',
      status: 'unreviewed',
      analysisSource: 'corroborated',
      confidence: 'high',
      uncertaintyNote:
        'Corroborated by PG-CONC-002 and AI control-flow analysis across `await db.getBalance` and `await db.updateBalance`.',
      location: {
        fileId: 'demo-file-1',
        filename: 'src/ledger/payoutController.ts',
        startLine: 13,
        endLine: 27,
        isValidLocation: true,
        rawSnippet:
          "  const account = await db.getBalance(lookupSql);\n\n  if (!account || account.balance_cents < req.amountCents) {\n    throw new Error('Insufficient merchant balance for requested payout');\n  }\n\n  // Reconcile line items sequentially\n  for (let i = 0; i <= req.lineItems.length; i++) {\n    const itemId = req.lineItems[i];\n    await db.query(`UPDATE payout_items SET reconciled = true WHERE id = '${itemId}'`);\n  }\n\n  try {\n    const nextBalance = account.balance_cents - req.amountCents;\n    await db.updateBalance(req.accountId, nextBalance);",
      },
      explanation:
        '`account.balance_cents` is read at line 13, followed by multiple asynchronous `await db.query` network hops before computing `nextBalance = account.balance_cents - req.amountCents` and writing it at line 27 without a transaction or row lock.',
      potentialImpact:
        'Concurrent payout requests for the same `accountId` will read the same initial `balance_cents`, pass the balance check simultaneously, and overwrite each other’s deduction.',
      suggestedRemediation:
        'Execute the balance check and deduction atomically in a single `UPDATE ... WHERE balance_cents >= $1 RETURNING *` statement or inside a serializable transaction with `SELECT ... FOR UPDATE`.',
      remediationCode:
        'const updated = await db.query(\n  `UPDATE merchant_accounts SET balance_cents = balance_cents - $1 WHERE tenant_id = $2 AND id = $3 AND balance_cents >= $1 RETURNING balance_cents`,\n  [req.amountCents, req.tenantId, req.accountId]\n);',
      staticCorroboration: {
        ruleId: 'PG-CONC-002',
        engineName: 'PatchGuard Static Analyzer (pg-static-ast-1.4.2)',
        matchedPattern: 'const account = await db.getBalance(lookupSql);',
        deterministicConfidence: 'high',
      },
      createdAt: '2026-10-27T18:15:00.000Z',
      updatedAt: '2026-10-27T18:15:00.000Z',
    },
    {
      id: 'demo-fnd-3',
      title: 'Inclusive loop upper bound (`i <= req.lineItems.length`) reads past array end',
      severity: 'high',
      category: 'boundary',
      status: 'unreviewed',
      analysisSource: 'static-pattern',
      confidence: 'high',
      location: {
        fileId: 'demo-file-1',
        filename: 'src/ledger/payoutController.ts',
        startLine: 20,
        endLine: 23,
        isValidLocation: true,
        rawSnippet:
          "  for (let i = 0; i <= req.lineItems.length; i++) {\n    const itemId = req.lineItems[i];\n    await db.query(`UPDATE payout_items SET reconciled = true WHERE id = '${itemId}'`);\n  }",
      },
      explanation:
        'The loop condition `i <= req.lineItems.length` executes one extra iteration where `i === req.lineItems.length`, evaluating `req.lineItems[i]` as `undefined`.',
      potentialImpact:
        'Executes a bogus `UPDATE payout_items SET reconciled = true WHERE id = \'undefined\'` query on every payout call.',
      suggestedRemediation:
        'Replace `i <= req.lineItems.length` with `i < req.lineItems.length`, and batch the update using `WHERE id = ANY($1)`.',
      staticCorroboration: {
        ruleId: 'PG-BND-003',
        engineName: 'PatchGuard Static Analyzer (pg-static-ast-1.4.2)',
        matchedPattern: 'for (let i = 0; i <= req.lineItems.length; i++) {',
        deterministicConfidence: 'high',
      },
      createdAt: '2026-10-27T18:15:00.000Z',
      updatedAt: '2026-10-27T18:15:00.000Z',
    },
    {
      id: 'demo-fnd-4',
      title: 'Hardcoded live signing secret literal in adminOverride.ts',
      severity: 'critical',
      category: 'security',
      status: 'unreviewed',
      analysisSource: 'static-pattern',
      confidence: 'high',
      location: {
        fileId: 'demo-file-2',
        filename: 'src/ledger/adminOverride.ts',
        startLine: 3,
        endLine: 3,
        isValidLocation: true,
        rawSnippet: 'const FALLBACK_SIGNING_SECRET = "pg_live_sec_9948102948102948102948ab";',
      },
      explanation:
        '`FALLBACK_SIGNING_SECRET` embeds a high-entropy live credential directly inside versioned source code.',
      potentialImpact:
        'Secret leakage through repository clones, CI logs, or compiled artifacts allows unauthorized signature forgery.',
      suggestedRemediation:
        'Require `process.env.SIGNING_SECRET` at process initialization and fail fast if absent.',
      staticCorroboration: {
        ruleId: 'PG-SEC-005',
        engineName: 'PatchGuard Static Analyzer (pg-static-ast-1.4.2)',
        matchedPattern: 'const FALLBACK_SIGNING_SECRET = "pg_live_sec_9948102948102948102948ab";',
        deterministicConfidence: 'high',
      },
      createdAt: '2026-10-27T18:15:00.000Z',
      updatedAt: '2026-10-27T18:15:00.000Z',
    },
    {
      id: 'demo-fnd-5',
      title: 'Unverified model hypothesis: Missing idempotency key expiration index',
      severity: 'low',
      category: 'maintainability',
      status: 'unreviewed',
      analysisSource: 'ai-gemini',
      confidence: 'low',
      uncertaintyNote:
        'Model-only reasoning with invalid source line citation (L84). Treat as unverified hypothesis because referenced schema file is not part of this diff.',
      location: {
        fileId: 'demo-file-1',
        filename: 'src/ledger/payoutController.ts',
        startLine: 84,
        endLine: 88,
        isValidLocation: false,
        rawSnippet: '',
        validationNote:
          'Referenced line range L84–L88 is outside valid bounds (1–33) for src/ledger/payoutController.ts. PatchGuard suppresses approximate line highlighting to preserve evidence integrity.',
      },
      explanation:
        'The AI model hypothesized that idempotency keys may accumulate without a TTL index, but cited lines 84–88 which do not exist in the submitted 33-line file.',
      potentialImpact:
        'No confirmed impact in the submitted diff; demonstrates how PatchGuard isolates ungrounded model claims from verified source evidence.',
      suggestedRemediation:
        'Verify database migration files separately if idempotency storage is introduced.',
      createdAt: '2026-10-27T18:15:00.000Z',
      updatedAt: '2026-10-27T18:15:00.000Z',
    },
  ],
};

export const INITIAL_EVALUATION_TEST_CASES: EvaluationTestCase[] = [
  {
    id: 'eval-tc-01',
    suiteId: 'suite-injection-auth',
    suiteName: '01 · Injection & Authorization Boundaries',
    title: 'Multi-tenant SQL interpolation & unguarded IDOR deletion',
    language: 'typescript',
    category: 'security',
    filename: 'src/repos/invoiceRepo.ts',
    description:
      'Tests whether the analysis pipeline detects both template-literal SQL injection (L4) and unscoped primary-key deletion (L9) without false positives on safe helper lines.',
    sourceCode: `export async function findAndPurgeInvoice(db: any, tenantId: string, invoiceId: string) {
  const cleanId = invoiceId.trim();
  // Defect 1: Unsanitized SQL string interpolation
  const sql = \`SELECT * FROM invoices WHERE tenant_id = '\${tenantId}' AND id = '\${cleanId}'\`;
  const row = await db.query(sql);

  if (row) {
    // Defect 2: Direct deletion by ID without tenant_id predicate
    await db.deleteById('invoices', cleanId);
  }
  return Boolean(row);
}`,
    expectedDefects: [
      {
        id: 'exp-tc01-1',
        title: 'SQL injection via template literal interpolation',
        category: 'security',
        minSeverity: 'critical',
        startLine: 4,
        endLine: 5,
        rationale: 'Variables tenantId and cleanId are interpolated directly into SQL text.',
      },
      {
        id: 'exp-tc01-2',
        title: 'Missing tenant authorization scope on deleteById',
        category: 'security',
        minSeverity: 'high',
        startLine: 9,
        endLine: 9,
        rationale: 'deleteById is invoked with cleanId without verifying tenant ownership.',
      },
    ],
  },
  {
    id: 'eval-tc-02',
    suiteId: 'suite-concurrency',
    suiteName: '02 · Concurrency & State Atomicity',
    title: 'Lost update in async wallet balance deduction',
    language: 'typescript',
    category: 'concurrency',
    filename: 'src/wallet/debitWorker.ts',
    description:
      'Tests detection of a non-atomic read-modify-write cycle across an await point when debiting a wallet balance.',
    sourceCode: `export async function debitWallet(db: any, walletId: string, debitAmount: number) {
  const wallet = await db.getBalance(walletId);
  if (wallet.balance < debitAmount) {
    throw new Error('Insufficient funds');
  }
  const updatedBalance = wallet.balance - debitAmount;
  await db.updateBalance(walletId, updatedBalance);
  return updatedBalance;
}`,
    expectedDefects: [
      {
        id: 'exp-tc02-1',
        title: 'Non-atomic read-modify-write across async boundary',
        category: 'concurrency',
        minSeverity: 'high',
        startLine: 2,
        endLine: 7,
        rationale:
          'getBalance and updateBalance execute without a transaction lock or atomic WHERE balance >= debitAmount guard.',
      },
    ],
  },
  {
    id: 'eval-tc-03',
    suiteId: 'suite-boundary',
    suiteName: '03 · Boundary & Loop Invariants',
    title: 'Off-by-one inclusive upper bound in batch reconciler',
    language: 'java',
    category: 'boundary',
    filename: 'BatchReconciler.java',
    description:
      'Verifies detection of `i <= records.size()` loop termination error in Java collection iteration.',
    sourceCode: `import java.util.List;

public class BatchReconciler {
    public int sumSettlementAmounts(List<Integer> records) {
        int sum = 0;
        for (int i = 0; i <= records.size(); i++) {
            sum += records.get(i);
        }
        return sum;
    }
}`,
    expectedDefects: [
      {
        id: 'exp-tc03-1',
        title: 'Inclusive loop upper bound causes IndexOutOfBoundsException',
        category: 'boundary',
        minSeverity: 'high',
        startLine: 6,
        endLine: 8,
        rationale: 'Loop runs while i <= records.size(), throwing on final iteration.',
      },
    ],
  },
  {
    id: 'eval-tc-04',
    suiteId: 'suite-error-handling',
    suiteName: '04 · Error Handling & Observability',
    title: 'Swallowed exception in Python ledger sync worker',
    language: 'python',
    category: 'error-handling',
    filename: 'ledger_sync.py',
    description:
      'Verifies detection of bare/silent `except Exception: pass` blocks that mask database commit failures.',
    sourceCode: `def commit_settlement_batch(cursor, batch_id: str, total_cents: int):
    try:
        cursor.execute(
            "UPDATE settlement_batches SET status = 'COMMITTED', total = %s WHERE id = %s",
            (total_cents, batch_id)
        )
    except Exception:
        pass
    return {"batch_id": batch_id, "committed": True}`,
    expectedDefects: [
      {
        id: 'exp-tc04-1',
        title: 'Swallowed exception masks failed settlement batch update',
        category: 'error-handling',
        minSeverity: 'medium',
        startLine: 7,
        endLine: 8,
        rationale: 'except Exception: pass silently ignores database failure and returns committed: True.',
      },
    ],
  },
  {
    id: 'eval-tc-05',
    suiteId: 'suite-clean-control',
    suiteName: '05 · Negative Control (Zero-Defect Baseline)',
    title: 'Parameterized atomic balance transfer (Clean Control)',
    language: 'typescript',
    category: 'correctness',
    filename: 'src/ledger/safeTransfer.ts',
    description:
      'Clean baseline control case using parameterized SQL and an atomic conditional UPDATE. Any finding reported on this snippet is counted as a False Positive.',
    sourceCode: `export async function safeAtomicDebit(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number }> },
  tenantId: string,
  accountId: string,
  amountCents: number
): Promise<boolean> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RangeError('amountCents must be a positive integer');
  }

  const sql = \`
    UPDATE merchant_accounts
    SET balance_cents = balance_cents - $1,
        updated_at = NOW()
    WHERE tenant_id = $2
      AND id = $3
      AND balance_cents >= $1
  \`;

  const result = await db.query(sql, [amountCents, tenantId, accountId]);
  return result.rowCount === 1;
}`,
    expectedDefects: [],
  },
];
