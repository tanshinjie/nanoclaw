import { randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import { buildCaptureId, buildExpenseId } from '../../modules/expenses/db.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

type ReviewStatus = 'complete' | 'needs_review';

type CaptureRow = {
  id: string;
  source_channel_type: string;
  source_platform_id: string;
  source_thread_id: string | null;
  source_message_id: string;
  message_timestamp: string;
};

type ExpenseRow = {
  id: string;
  capture_id: string;
  amount: number | null;
  currency: string | null;
  transaction_date: string | null;
  merchant: string | null;
  category: string | null;
  payment_method: string | null;
  ledger: string | null;
  notes: string | null;
  extraction_confidence: number;
  review_status: ReviewStatus;
  missing_fields_json: string;
  created_at: string;
  updated_at: string;
};

const REVIEW_STATUSES = new Set<ReviewStatus>(['complete', 'needs_review']);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asOptionalString(args: Record<string, unknown>, key: string): string | null {
  return asString(args[key]);
}

function asNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`--${label} must be a number`);
  return n;
}

function normalizeCurrency(value: unknown): string {
  const currency = asString(value) ?? process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD';
  return currency.toUpperCase();
}

function normalizeDate(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('--date must use YYYY-MM-DD');
  return raw;
}

function normalizeMonth(value: unknown): string {
  const raw = asString(value) ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new Error('--month must use YYYY-MM');
  return raw;
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber, 1));
  return date.toISOString().slice(0, 7);
}

function computeMissingFields(expense: Pick<ExpenseRow, 'amount' | 'category' | 'payment_method'>): string[] {
  const missing: string[] = [];
  if (expense.amount === null) missing.push('amount');
  if (!expense.category) missing.push('category');
  if (!expense.payment_method) missing.push('payment_method');
  return missing;
}

function selectExpenseById(id: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare(
      `SELECT
         e.id,
         e.capture_id,
         c.source_channel_type,
         c.source_platform_id,
         c.source_thread_id,
         c.source_message_id,
         c.message_timestamp,
         e.amount,
         e.currency,
         e.transaction_date,
         e.merchant,
         e.category,
         e.payment_method,
         e.ledger,
         e.notes,
         e.extraction_confidence,
         e.review_status,
         e.missing_fields_json,
         e.created_at,
         e.updated_at
       FROM expenses e
       JOIN expense_captures c ON c.id = e.capture_id
       WHERE e.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
}

function findCapture(
  sourceMessageId: string,
  sourcePlatformId: string | null,
  sourceChannelType: string,
): CaptureRow | undefined {
  if (sourcePlatformId) {
    const exact = getDb()
      .prepare(
        `SELECT id, source_channel_type, source_platform_id, source_thread_id, source_message_id, message_timestamp
         FROM expense_captures
         WHERE source_channel_type = ? AND source_platform_id = ? AND source_message_id = ?`,
      )
      .get(sourceChannelType, sourcePlatformId, sourceMessageId) as CaptureRow | undefined;
    if (exact) return exact;
  }

  const candidates = getDb()
    .prepare(
      `SELECT id, source_channel_type, source_platform_id, source_thread_id, source_message_id, message_timestamp
       FROM expense_captures
       WHERE source_message_id = ?
       ORDER BY created_at DESC
       LIMIT 2`,
    )
    .all(sourceMessageId) as CaptureRow[];

  if (candidates.length > 1) {
    throw new Error('--source-message-id matched multiple captures; provide --source-platform-id');
  }
  return candidates[0];
}

function resolveReviewStatus(
  args: Record<string, unknown>,
  row: Pick<ExpenseRow, 'amount' | 'category' | 'payment_method'>,
): ReviewStatus {
  const provided = asOptionalString(args, 'review_status') as ReviewStatus | null;
  if (provided) {
    if (!REVIEW_STATUSES.has(provided)) throw new Error('--review-status must be complete or needs_review');
    return provided;
  }
  return computeMissingFields(row).length === 0 ? 'complete' : 'needs_review';
}

function createPlaceholderCapture(
  args: Record<string, unknown>,
  ctx: CallerContext,
  now: string,
  transactionDate: string | null,
): CaptureRow {
  const sourceMessageId = asOptionalString(args, 'source_message_id') ?? `manual-${randomUUID()}`;
  const sourceChannelType =
    asOptionalString(args, 'source_channel_type') ?? (args.source_message_id ? 'telegram' : 'cli');
  const sourcePlatformId =
    asOptionalString(args, 'source_platform_id') ??
    (ctx.caller === 'agent' ? ctx.messagingGroupId : null) ??
    (args.source_message_id ? 'unknown-platform' : 'manual');
  const captureId = buildCaptureId(sourceChannelType, sourcePlatformId, sourceMessageId);
  const messageTimestamp = transactionDate ? `${transactionDate}T00:00:00.000Z` : now;

  getDb()
    .prepare(
      `INSERT OR IGNORE INTO expense_captures (
         id,
         source_channel_type,
         source_platform_id,
         source_thread_id,
         source_message_id,
         source_user_id,
         sender_name,
         message_timestamp,
         raw_text,
         raw_content_json,
         attachment_count,
         attachment_summary_json,
         capture_status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'needs_review', ?, ?)`,
    )
    .run(
      captureId,
      sourceChannelType,
      sourcePlatformId,
      asOptionalString(args, 'source_thread_id'),
      sourceMessageId,
      null,
      'ncl expenses-add',
      messageTimestamp,
      asOptionalString(args, 'notes'),
      JSON.stringify({ source: 'ncl expenses-add', source_message_id: sourceMessageId }),
      now,
      now,
    );

  return {
    id: captureId,
    source_channel_type: sourceChannelType,
    source_platform_id: sourcePlatformId,
    source_thread_id: asOptionalString(args, 'source_thread_id'),
    source_message_id: sourceMessageId,
    message_timestamp: messageTimestamp,
  };
}

function upsertExpense(args: Record<string, unknown>, ctx: CallerContext): Record<string, unknown> {
  const now = new Date().toISOString();
  const sourceMessageId = asOptionalString(args, 'source_message_id');
  const sourcePlatformId =
    asOptionalString(args, 'source_platform_id') ?? (ctx.caller === 'agent' ? ctx.messagingGroupId : null);
  const sourceChannelType = asOptionalString(args, 'source_channel_type') ?? 'telegram';
  const transactionDate = normalizeDate(args.date ?? args.transaction_date);
  const amount = asNumber(args.amount, 'amount');

  const db = getDb();
  const result = db.transaction(() => {
    const capture = sourceMessageId
      ? (findCapture(sourceMessageId, sourcePlatformId, sourceChannelType) ??
        createPlaceholderCapture(args, ctx, now, transactionDate))
      : createPlaceholderCapture(args, ctx, now, transactionDate);

    const existing = db.prepare('SELECT * FROM expenses WHERE capture_id = ?').get(capture.id) as
      | ExpenseRow
      | undefined;
    const candidate: Pick<
      ExpenseRow,
      'amount' | 'currency' | 'transaction_date' | 'merchant' | 'category' | 'payment_method' | 'ledger' | 'notes'
    > = {
      amount: args.amount !== undefined ? amount : (existing?.amount ?? null),
      currency: args.currency !== undefined || !existing ? normalizeCurrency(args.currency) : existing.currency,
      transaction_date: transactionDate ?? existing?.transaction_date ?? capture.message_timestamp.slice(0, 10),
      merchant: asOptionalString(args, 'merchant') ?? existing?.merchant ?? null,
      category: asOptionalString(args, 'category') ?? existing?.category ?? null,
      payment_method: asOptionalString(args, 'payment_method') ?? existing?.payment_method ?? null,
      ledger: asOptionalString(args, 'ledger') ?? existing?.ledger ?? null,
      notes: asOptionalString(args, 'notes') ?? existing?.notes ?? null,
    };
    const reviewStatus = resolveReviewStatus(args, candidate);
    const missingFields = reviewStatus === 'complete' ? [] : computeMissingFields(candidate);
    const confidence =
      asNumber(args.extraction_confidence, 'extraction-confidence') ?? existing?.extraction_confidence ?? 1;
    const expenseId = existing?.id ?? buildExpenseId(capture.id);

    if (existing) {
      db.prepare(
        `UPDATE expenses
         SET amount = ?,
             currency = ?,
             transaction_date = ?,
             merchant = ?,
             category = ?,
             payment_method = ?,
             ledger = ?,
             notes = ?,
             extraction_confidence = ?,
             review_status = ?,
             missing_fields_json = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        candidate.amount,
        candidate.currency,
        candidate.transaction_date,
        candidate.merchant,
        candidate.category,
        candidate.payment_method,
        candidate.ledger,
        candidate.notes,
        confidence,
        reviewStatus,
        JSON.stringify(missingFields),
        now,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO expenses (
           id,
           capture_id,
           amount,
           currency,
           transaction_date,
           merchant,
           category,
           payment_method,
           ledger,
           notes,
           extraction_confidence,
           review_status,
           missing_fields_json,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        expenseId,
        capture.id,
        candidate.amount,
        candidate.currency,
        candidate.transaction_date,
        candidate.merchant,
        candidate.category,
        candidate.payment_method,
        candidate.ledger,
        candidate.notes,
        confidence,
        reviewStatus,
        JSON.stringify(missingFields),
        now,
        now,
      );
    }

    db.prepare('UPDATE expense_captures SET capture_status = ?, updated_at = ? WHERE id = ?').run(
      reviewStatus === 'complete' ? 'captured' : 'needs_review',
      now,
      capture.id,
    );

    const row = selectExpenseById(expenseId);
    if (!row) throw new Error('expense upsert failed');
    return { ...row, upserted: existing ? 'updated' : 'created' };
  })();

  return result;
}

function listExpenses(args: Record<string, unknown>): Record<string, unknown>[] {
  const filters: string[] = [];
  const params: unknown[] = [];

  const month = asOptionalString(args, 'month');
  if (month) {
    const normalized = normalizeMonth(month);
    filters.push('e.transaction_date >= ? AND e.transaction_date < ?');
    params.push(`${normalized}-01`, `${nextMonth(normalized)}-01`);
  }

  const category = asOptionalString(args, 'category');
  if (category) {
    filters.push('e.category = ?');
    params.push(category);
  }

  const reviewStatus = asOptionalString(args, 'review_status');
  if (reviewStatus) {
    if (!REVIEW_STATUSES.has(reviewStatus as ReviewStatus))
      throw new Error('--review-status must be complete or needs_review');
    filters.push('e.review_status = ?');
    params.push(reviewStatus);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Number(args.limit ?? 200)));
  params.push(limit);

  return getDb()
    .prepare(
      `SELECT
         e.id,
         c.source_message_id,
         e.amount,
         e.currency,
         e.transaction_date,
         e.merchant,
         e.category,
         e.payment_method,
         e.ledger,
         e.notes,
         e.review_status,
         e.missing_fields_json,
         e.created_at,
         e.updated_at
       FROM expenses e
       JOIN expense_captures c ON c.id = e.capture_id
       ${where}
       ORDER BY e.transaction_date DESC, e.created_at DESC
       LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
}

function summarizeExpenses(args: Record<string, unknown>): Record<string, unknown> {
  const month = normalizeMonth(args.month);
  const start = `${month}-01`;
  const end = `${nextMonth(month)}-01`;
  const db = getDb();

  const byCategory = db
    .prepare(
      `SELECT
         COALESCE(category, 'uncategorized') AS category,
         COALESCE(currency, ?) AS currency,
         ROUND(SUM(COALESCE(amount, 0)), 2) AS total_amount,
         COUNT(*) AS expense_count
       FROM expenses
       WHERE transaction_date >= ? AND transaction_date < ?
       GROUP BY COALESCE(category, 'uncategorized'), COALESCE(currency, ?)
       ORDER BY total_amount DESC`,
    )
    .all(
      process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD',
      start,
      end,
      process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD',
    ) as Record<string, unknown>[];

  const byCurrency = db
    .prepare(
      `SELECT
         COALESCE(currency, ?) AS currency,
         ROUND(SUM(COALESCE(amount, 0)), 2) AS total_amount,
         COUNT(*) AS expense_count
       FROM expenses
       WHERE transaction_date >= ? AND transaction_date < ?
       GROUP BY COALESCE(currency, ?)
       ORDER BY total_amount DESC`,
    )
    .all(
      process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD',
      start,
      end,
      process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD',
    ) as Record<string, unknown>[];

  return { month, by_category: byCategory, by_currency: byCurrency };
}

function markReviewed(args: Record<string, unknown>): Record<string, unknown> {
  const id = asOptionalString(args, 'id');
  if (!id) throw new Error('--id is required');
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE expenses SET review_status = 'complete', missing_fields_json = '[]', updated_at = ? WHERE id = ?")
    .run(now, id);
  if (result.changes === 0) throw new Error(`expense not found: ${id}`);
  const row = selectExpenseById(id);
  if (!row) throw new Error(`expense not found: ${id}`);
  return row;
}

function deleteExpense(args: Record<string, unknown>): Record<string, unknown> {
  const id = asOptionalString(args, 'id');
  if (!id) throw new Error('--id is required');

  const db = getDb();
  return db.transaction(() => {
    const row = selectExpenseById(id);
    if (!row) throw new Error(`expense not found: ${id}`);

    const captureId = row.capture_id as string;
    const expenseResult = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    if (expenseResult.changes === 0) throw new Error(`expense not found: ${id}`);

    db.prepare('DELETE FROM expense_captures WHERE id = ?').run(captureId);

    return {
      deleted: id,
      deleted_capture_id: captureId,
      source_message_id: row.source_message_id,
      amount: row.amount,
      currency: row.currency,
      transaction_date: row.transaction_date,
      merchant: row.merchant,
      category: row.category,
    };
  })();
}

registerResource({
  name: 'expense',
  plural: 'expenses',
  table: 'expenses',
  description:
    'Personal finance expense records stored in the central SQLite database. Use these commands instead of agent-local JSON files.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Expense ID. Generated from the linked capture ID.' },
    { name: 'capture_id', type: 'string', description: 'Raw capture row this normalized expense belongs to.' },
    {
      name: 'source_message_id',
      type: 'string',
      description: 'Optional Telegram message ID used to link or upsert a captured message.',
    },
    {
      name: 'source_platform_id',
      type: 'string',
      description: 'Optional Telegram chat/platform ID for disambiguating source message IDs.',
    },
    {
      name: 'source_channel_type',
      type: 'string',
      description: 'Optional source channel type. Defaults to telegram for sourced records and cli for manual records.',
    },
    { name: 'amount', type: 'number', description: 'Transaction amount.' },
    { name: 'currency', type: 'string', description: 'ISO-like currency code. Defaults to SGD.' },
    { name: 'transaction_date', type: 'string', description: 'Transaction date in YYYY-MM-DD format.' },
    { name: 'merchant', type: 'string', description: 'Merchant or counterparty name.' },
    {
      name: 'category',
      type: 'string',
      description: 'User-facing spending category, such as food, transport, groceries, bills, or healthcare.',
    },
    {
      name: 'payment_method',
      type: 'string',
      description: 'Payment method, such as cash, card, paynow, grabpay, debit_card, or bank_transfer.',
    },
    { name: 'ledger', type: 'string', description: 'Optional ledger/account label.' },
    { name: 'notes', type: 'string', description: 'Optional note or evidence summary.' },
    {
      name: 'extraction_confidence',
      type: 'number',
      description: 'Confidence score from automated extraction, from 0 to 1.',
    },
    {
      name: 'review_status',
      type: 'string',
      description: 'Review state for the normalized expense.',
      enum: ['complete', 'needs_review'],
    },
    {
      name: 'missing_fields_json',
      type: 'json',
      description: 'JSON array of fields still needed before the record is complete.',
    },
    { name: 'created_at', type: 'string', description: 'Auto-set creation timestamp.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set update timestamp.' },
  ],
  operations: {},
  customOperations: {
    add: {
      access: 'open',
      description:
        'Create or update an expense. Use --amount, --merchant, --category, --payment-method, --date, and optionally --source-message-id.',
      handler: async (args, ctx) => upsertExpense(args, ctx),
    },
    list: {
      access: 'open',
      description: 'List expenses. Optional filters: --month YYYY-MM, --category, --review-status, --limit.',
      handler: async (args) => listExpenses(args),
    },
    get: {
      access: 'open',
      description: 'Get one expense by --id.',
      handler: async (args) => {
        const id = asOptionalString(args, 'id');
        if (!id) throw new Error('--id is required');
        const row = selectExpenseById(id);
        if (!row) throw new Error(`expense not found: ${id}`);
        return row;
      },
    },
    summary: {
      access: 'open',
      description:
        'Summarize monthly spending by category and currency. Use --month YYYY-MM; defaults to the current month.',
      handler: async (args) => summarizeExpenses(args),
    },
    'mark-reviewed': {
      access: 'open',
      description: 'Mark an expense as complete after review. Use --id <expense-id>.',
      handler: async (args) => markReviewed(args),
    },
    delete: {
      access: 'open',
      description: 'Delete an expense and its linked raw capture record. Use --id <expense-id>.',
      handler: async (args) => deleteExpense(args),
    },
  },
});
