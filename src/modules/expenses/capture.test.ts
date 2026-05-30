import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { captureExpenseMessage } from './capture.js';

function telegramEvent(id: string, content: Record<string, unknown>): InboundEvent {
  return {
    channelType: 'telegram',
    platformId: 'telegram-chat-1',
    threadId: 'ignored-thread',
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify(content),
      timestamp: '2026-05-26T08:15:00.000Z',
      isMention: true,
      isGroup: false,
    },
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('Telegram expense capture', () => {
  it('stores a parsed Telegram text expense once per source message', async () => {
    const event = telegramEvent('msg-1', {
      text: '6.50 lunch cash',
      userId: 'telegram:123',
      senderName: 'Shin Jie',
    });

    await captureExpenseMessage(event);
    await captureExpenseMessage(event);

    const db = getDb();
    const captureCount = db.prepare('SELECT COUNT(*) AS count FROM expense_captures').get() as { count: number };
    const expenseCount = db.prepare('SELECT COUNT(*) AS count FROM expenses').get() as { count: number };
    const capture = db.prepare('SELECT * FROM expense_captures').get() as Record<string, unknown>;
    const expense = db.prepare('SELECT * FROM expenses').get() as Record<string, unknown>;

    expect(captureCount.count).toBe(1);
    expect(expenseCount.count).toBe(1);
    expect(capture.raw_text).toBe('6.50 lunch cash');
    expect(capture.capture_status).toBe('captured');
    expect(expense.amount).toBe(6.5);
    expect(expense.currency).toBe('SGD');
    expect(expense.category).toBe('food');
    expect(expense.payment_method).toBe('cash');
    expect(expense.review_status).toBe('complete');
    expect(expense.missing_fields_json).toBe('[]');
  });

  it('stores receipt-photo metadata without raw file payloads and marks it for review', async () => {
    await captureExpenseMessage(
      telegramEvent('msg-photo', {
        attachments: [
          {
            type: 'photo',
            filename: 'receipt.jpg',
            mimeType: 'image/jpeg',
            size: 12345,
            width: 1200,
            height: 900,
            data: 'large-base64-payload-should-not-be-copied',
          },
        ],
      }),
    );

    const db = getDb();
    const capture = db.prepare('SELECT * FROM expense_captures').get() as Record<string, unknown>;
    const expense = db.prepare('SELECT * FROM expenses').get() as Record<string, unknown>;

    expect(capture.attachment_count).toBe(1);
    expect(capture.capture_status).toBe('needs_review');
    expect(capture.attachment_summary_json).toContain('receipt.jpg');
    expect(capture.attachment_summary_json).not.toContain('large-base64-payload');
    expect(expense.amount).toBeNull();
    expect(expense.review_status).toBe('needs_review');
    expect(JSON.parse(expense.missing_fields_json as string)).toEqual(['amount', 'category', 'payment_method']);
  });

  it('ignores non-expense Telegram commands', async () => {
    await captureExpenseMessage(telegramEvent('msg-command', { text: '/start' }));

    const db = getDb();
    const captureCount = db.prepare('SELECT COUNT(*) AS count FROM expense_captures').get() as { count: number };
    expect(captureCount.count).toBe(0);
  });
});
