# Telegram Expense Capture

NanoClaw now includes a first-pass **Telegram expense capture** module for the personal finance inbox workflow. The module treats Telegram as the low-friction capture layer, records raw evidence in the central SQLite database, and creates a normalized expense row that can be reviewed later.

The design follows the existing NanoClaw routing model. It adds a non-consuming router observer rather than replacing the existing message interceptor path. This means expense capture runs as a side effect and does not prevent the normal agent-routing flow from continuing.

| Component | Responsibility |
|---|---|
| Telegram channel | Receives the user’s text, photo, screenshot, or receipt message. |
| Router observer | Lets modules observe inbound messages without consuming them. |
| Expense module | Filters Telegram captures, extracts basic fields, and writes database records. |
| Central SQLite database | Stores raw capture records and normalized expense records. |

## Database Tables

The migration `016-expense-capture.ts` creates two tables. The first table preserves the raw inbox evidence. The second table stores the normalized expense fields derived from that evidence.

| Table | Purpose | Important Fields |
|---|---|---|
| `expense_captures` | Durable raw capture inbox | `source_channel_type`, `source_platform_id`, `source_message_id`, `raw_text`, `raw_content_json`, `attachment_summary_json`, `capture_status` |
| `expenses` | Normalized expense record | `amount`, `currency`, `transaction_date`, `merchant`, `category`, `payment_method`, `review_status`, `missing_fields_json` |

The unique key on `expense_captures(source_channel_type, source_platform_id, source_message_id)` makes the Telegram processing **idempotent**. If NanoClaw sees the same Telegram message more than once, it will not create duplicate expense records.

## Current Extraction Behavior

The first implementation is intentionally conservative. It extracts obvious structured information from short Telegram messages and marks uncertain records for review instead of pretending the data is complete.

| Input Example | Result |
|---|---|
| `6.50 lunch cash` | Creates a complete expense with amount `6.50`, default currency `SGD`, category `food`, and payment method `cash`. |
| Receipt photo without text | Creates a capture and expense shell marked `needs_review`, with attachment metadata preserved. |
| `/start` or `/help` | Ignored so Telegram bot commands are not captured as expenses. |

The default currency is `SGD`. It can be overridden by setting the environment variable `NANOCLAW_EXPENSE_DEFAULT_CURRENCY`. Text containing `RM` or `MYR` is parsed as `MYR`, while `SGD`, `S$`, or `$` is parsed as Singapore-dollar context by default.

## First-Class Expense CLI Tool

Agents and host operators should use the first-class `expenses-*` commands instead of writing local JSON files or editing the database directly. The commands write to the same central SQLite tables used by passive Telegram capture, so text expenses, receipt-photo shells, manual corrections, listing, and monthly summaries all share one source of truth.

| Command | Purpose | Typical Arguments |
|---|---|---|
| `expenses-add` | Create a standalone expense or update a captured message expense. | `--amount 6.50 --merchant "Lunch Stall" --category food --payment-method cash --date 2026-05-26` |
| `expenses-add` with source fields | Link corrections to an existing Telegram capture and avoid duplicate rows. | `--source-message-id 123 --source-platform-id <chat-id> --amount 12.30 --category food --payment-method card` |
| `expenses-list` | Review normalized expense rows. | `--month 2026-05 --category food --review-status needs_review --limit 50` |
| `expenses-get` | Inspect one expense and its source message metadata. | `--id <expense-id>` |
| `expenses-summary` | Aggregate monthly totals by category and currency. | `--month 2026-05` |
| `expenses-mark-reviewed` | Mark a reviewed expense as complete. | `--id <expense-id>` |

A routed group-scoped agent can call this resource without approval. The dispatcher intentionally whitelists `expenses` for group-scoped CLI access and does not auto-fill `--id`, because expense IDs are independent records rather than agent group IDs.

## How to Inspect Captured Expenses

Prefer the first-class CLI commands for normal review and summary work. If direct database inspection is needed for debugging, use SQL similar to the following:

```sql
SELECT
  ec.message_timestamp,
  ec.raw_text,
  e.amount,
  e.currency,
  e.category,
  e.payment_method,
  e.review_status,
  e.missing_fields_json
FROM expense_captures ec
JOIN expenses e ON e.capture_id = ec.id
ORDER BY ec.created_at DESC;
```

## Verification Commands

The implementation was validated with the focused expense tests, full TypeScript typecheck, and full test suite.

```bash
pnpm vitest run src/modules/expenses/capture.test.ts
pnpm test src/cli/dispatch.test.ts src/cli/resources/expenses.test.ts
pnpm typecheck
pnpm test
```

## Next Improvements

The next practical step is to let the routed finance agent use `expenses-list --review-status needs_review` to proactively review incomplete records and then call `expenses-add --source-message-id ...` or `expenses-mark-reviewed --id ...` after the user confirms missing details. The current module stores missing fields explicitly, so the review flow can ask only for the missing information instead of forcing the user to re-enter the whole expense.

Potential extensions include OCR for receipts and screenshots, richer merchant extraction, category customization, household-ledger routing, and Telegram-facing shortcuts such as `/expenses_today` or `/review_expenses`.
