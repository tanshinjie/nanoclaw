import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { upsertExpenseCapture } from './db.js';
import { extractExpense, parseMessageContent } from './extract.js';

function shouldCapture(event: InboundEvent, text: string | null, attachmentCount: number): boolean {
  if (event.channelType !== 'telegram') return false;
  if (!text && attachmentCount === 0) return false;

  const normalizedText = text?.trim() ?? '';
  if (/^\/(start|help|settings|pair|authorize|approve|reject)\b/i.test(normalizedText)) return false;

  return true;
}

export async function captureExpenseMessage(event: InboundEvent): Promise<void> {
  const details = parseMessageContent(event.message.content);
  if (!details) return;

  if (!shouldCapture(event, details.text, details.attachments.length)) return;

  const expense = extractExpense(details, event.message.timestamp);
  const result = upsertExpenseCapture(
    {
      source_channel_type: event.channelType,
      source_platform_id: event.platformId,
      source_thread_id: event.threadId,
      source_message_id: event.message.id,
      source_user_id: details.sourceUserId,
      sender_name: details.senderName,
      message_timestamp: event.message.timestamp,
      raw_text: details.text,
      raw_content_json: JSON.stringify(details.rawContent),
      attachment_count: details.attachments.length,
      attachment_summary_json: JSON.stringify(details.attachments),
      capture_status: expense.review_status === 'complete' ? 'captured' : 'needs_review',
    },
    {
      amount: expense.amount,
      currency: expense.currency,
      transaction_date: expense.transaction_date,
      merchant: expense.merchant,
      category: expense.category,
      payment_method: expense.payment_method,
      ledger: expense.ledger,
      notes: expense.notes,
      extraction_confidence: expense.extraction_confidence,
      review_status: expense.review_status,
      missing_fields_json: JSON.stringify(expense.missing_fields),
    },
  );

  if (result.inserted) {
    log.info('Expense capture stored', {
      captureId: result.captureId,
      expenseId: result.expenseId,
      platformId: event.platformId,
      messageId: event.message.id,
      reviewStatus: expense.review_status,
    });
  }
}
