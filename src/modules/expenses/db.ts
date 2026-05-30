import { createHash } from 'crypto';

import { getDb } from '../../db/index.js';

export type CaptureStatus = 'captured' | 'needs_review';
export type ReviewStatus = 'complete' | 'needs_review';

export interface ExpenseCaptureInput {
  source_channel_type: string;
  source_platform_id: string;
  source_thread_id: string | null;
  source_message_id: string;
  source_user_id: string | null;
  sender_name: string | null;
  message_timestamp: string;
  raw_text: string | null;
  raw_content_json: string;
  attachment_count: number;
  attachment_summary_json: string;
  capture_status: CaptureStatus;
}

export interface ExpenseInput {
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
}

export interface UpsertExpenseCaptureResult {
  captureId: string;
  expenseId: string;
  inserted: boolean;
}

export function buildCaptureId(channelType: string, platformId: string, messageId: string): string {
  const digest = createHash('sha256')
    .update(`${channelType}\u0000${platformId}\u0000${messageId}`)
    .digest('hex')
    .slice(0, 20);
  return `cap-${digest}`;
}

export function buildExpenseId(captureId: string): string {
  return `exp-${captureId.slice(4)}`;
}

export function upsertExpenseCapture(capture: ExpenseCaptureInput, expense: ExpenseInput): UpsertExpenseCaptureResult {
  const db = getDb();
  const captureId = buildCaptureId(capture.source_channel_type, capture.source_platform_id, capture.source_message_id);
  const expenseId = buildExpenseId(captureId);
  const now = new Date().toISOString();

  const insertCapture = db.prepare(`
    INSERT OR IGNORE INTO expense_captures (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertExpense = db.prepare(`
    INSERT OR IGNORE INTO expenses (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = db.transaction(() => {
    const captureInfo = insertCapture.run(
      captureId,
      capture.source_channel_type,
      capture.source_platform_id,
      capture.source_thread_id,
      capture.source_message_id,
      capture.source_user_id,
      capture.sender_name,
      capture.message_timestamp,
      capture.raw_text,
      capture.raw_content_json,
      capture.attachment_count,
      capture.attachment_summary_json,
      capture.capture_status,
      now,
      now,
    );

    insertExpense.run(
      expenseId,
      captureId,
      expense.amount,
      expense.currency,
      expense.transaction_date,
      expense.merchant,
      expense.category,
      expense.payment_method,
      expense.ledger,
      expense.notes,
      expense.extraction_confidence,
      expense.review_status,
      expense.missing_fields_json,
      now,
      now,
    );

    return captureInfo;
  })();

  return { captureId, expenseId, inserted: info.changes > 0 };
}
