import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './expenses.js';

function now(): string {
  return new Date().toISOString();
}

describe('expenses CLI resource', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('creates a standalone expense in the central SQLite tables', async () => {
    const resp = await dispatch(
      {
        id: 'expense-add-1',
        command: 'expenses-add',
        args: {
          amount: '6.50',
          merchant: 'Lunch Stall',
          category: 'food',
          payment_method: 'cash',
          date: '2026-05-26',
          notes: '6.50 lunch cash',
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toMatchObject({ amount: 6.5, currency: 'SGD', category: 'food', review_status: 'complete' });

    const rows = getDb()
      .prepare('SELECT amount, currency, category, payment_method, review_status FROM expenses')
      .all();
    expect(rows).toEqual([
      { amount: 6.5, currency: 'SGD', category: 'food', payment_method: 'cash', review_status: 'complete' },
    ]);
  });

  it('upserts by source_message_id and updates an existing captured expense shell', async () => {
    const db = getDb();
    const createdAt = now();
    db.prepare(
      `INSERT INTO expense_captures (
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
       ) VALUES (?, 'telegram', 'chat-1', NULL, 'msg-1', NULL, NULL, ?, NULL, '{}', 0, '[]', 'needs_review', ?, ?)`,
    ).run('cap-existing', createdAt, createdAt, createdAt);
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
       ) VALUES (?, ?, NULL, 'SGD', '2026-05-26', NULL, NULL, NULL, NULL, NULL, 0.1, 'needs_review', '["amount","category","payment_method"]', ?, ?)`,
    ).run('exp-existing', 'cap-existing', createdAt, createdAt);

    const resp = await dispatch(
      {
        id: 'expense-upsert-1',
        command: 'expenses-add',
        args: {
          source_message_id: 'msg-1',
          source_platform_id: 'chat-1',
          amount: '12.30',
          merchant: 'Receipt Cafe',
          category: 'food',
          payment_method: 'card',
          date: '2026-05-26',
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toMatchObject({
      id: 'exp-existing',
      source_message_id: 'msg-1',
      amount: 12.3,
      upserted: 'updated',
    });

    const count = db.prepare('SELECT COUNT(*) AS count FROM expenses').get() as { count: number };
    expect(count.count).toBe(1);
    const row = db
      .prepare('SELECT merchant, review_status, missing_fields_json FROM expenses WHERE id = ?')
      .get('exp-existing');
    expect(row).toEqual({ merchant: 'Receipt Cafe', review_status: 'complete', missing_fields_json: '[]' });
  });

  it('deletes an expense and its linked raw capture record', async () => {
    const add = await dispatch(
      {
        id: 'expense-add-delete-1',
        command: 'expenses-add',
        args: {
          amount: '9.90',
          merchant: 'Delete Cafe',
          category: 'food',
          payment_method: 'card',
          date: '2026-05-27',
          source_message_id: 'delete-msg-1',
          source_platform_id: 'delete-chat-1',
        },
      },
      { caller: 'host' },
    );
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const expenseId = (add.data as Record<string, unknown>).id as string;
    const captureId = (add.data as Record<string, unknown>).capture_id as string;

    const deleted = await dispatch(
      { id: 'expense-delete-1', command: 'expenses-delete', args: { id: expenseId } },
      { caller: 'host' },
    );

    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.data).toMatchObject({
        deleted: expenseId,
        deleted_capture_id: captureId,
        source_message_id: 'delete-msg-1',
        amount: 9.9,
        currency: 'SGD',
        category: 'food',
      });
    }

    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE id = ?').get(expenseId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM expense_captures WHERE id = ?').get(captureId)).toEqual({
      count: 0,
    });

    const missing = await dispatch(
      { id: 'expense-delete-missing', command: 'expenses-delete', args: { id: expenseId } },
      { caller: 'host' },
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'handler-error', message: `expense not found: ${expenseId}` },
    });
  });

  it('lists and summarizes expenses for a month', async () => {
    await dispatch(
      {
        id: 'expense-add-food',
        command: 'expenses-add',
        args: { amount: '6.50', category: 'food', payment_method: 'cash', date: '2026-05-01' },
      },
      { caller: 'host' },
    );
    await dispatch(
      {
        id: 'expense-add-transport',
        command: 'expenses-add',
        args: { amount: '3.20', category: 'transport', payment_method: 'card', date: '2026-05-02' },
      },
      { caller: 'host' },
    );

    const list = await dispatch(
      { id: 'expense-list-1', command: 'expenses-list', args: { month: '2026-05', category: 'food' } },
      { caller: 'host' },
    );
    expect(list.ok).toBe(true);
    if (list.ok) {
      const rows = list.data as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 6.5, category: 'food' });
    }

    const summary = await dispatch(
      { id: 'expense-summary-1', command: 'expenses-summary', args: { month: '2026-05' } },
      { caller: 'host' },
    );
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      const data = summary.data as { month: string; by_category: Array<Record<string, unknown>> };
      expect(data).toMatchObject({ month: '2026-05' });
      expect(data.by_category).toEqual([
        { category: 'food', currency: 'SGD', total_amount: 6.5, expense_count: 1 },
        { category: 'transport', currency: 'SGD', total_amount: 3.2, expense_count: 1 },
      ]);
    }
  });
});
