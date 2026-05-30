import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'expense-capture',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS expense_captures (
        id                  TEXT PRIMARY KEY,
        source_channel_type TEXT NOT NULL,
        source_platform_id  TEXT NOT NULL,
        source_thread_id    TEXT,
        source_message_id   TEXT NOT NULL,
        source_user_id      TEXT,
        sender_name         TEXT,
        message_timestamp   TEXT NOT NULL,
        raw_text            TEXT,
        raw_content_json    TEXT NOT NULL,
        attachment_count    INTEGER NOT NULL DEFAULT 0,
        attachment_summary_json TEXT NOT NULL DEFAULT '[]',
        capture_status      TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (source_channel_type, source_platform_id, source_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_expense_captures_status
        ON expense_captures(capture_status, created_at);

      CREATE INDEX IF NOT EXISTS idx_expense_captures_message_time
        ON expense_captures(message_timestamp);

      CREATE TABLE IF NOT EXISTS expenses (
        id                    TEXT PRIMARY KEY,
        capture_id            TEXT NOT NULL UNIQUE REFERENCES expense_captures(id) ON DELETE CASCADE,
        amount                REAL,
        currency              TEXT,
        transaction_date      TEXT,
        merchant              TEXT,
        category              TEXT,
        payment_method        TEXT,
        ledger                TEXT,
        notes                 TEXT,
        extraction_confidence REAL NOT NULL DEFAULT 0,
        review_status         TEXT NOT NULL,
        missing_fields_json   TEXT NOT NULL DEFAULT '[]',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_expenses_review_status
        ON expenses(review_status, created_at);

      CREATE INDEX IF NOT EXISTS idx_expenses_transaction_date
        ON expenses(transaction_date);
    `);
  },
};
