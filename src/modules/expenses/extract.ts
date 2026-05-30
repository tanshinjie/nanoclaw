export interface AttachmentSummary {
  index: number;
  type: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  fileId: string | null;
}

export interface MessageDetails {
  rawContent: unknown;
  text: string | null;
  sourceUserId: string | null;
  senderName: string | null;
  attachments: AttachmentSummary[];
}

export interface ExtractedExpense {
  amount: number | null;
  currency: string | null;
  transaction_date: string | null;
  merchant: string | null;
  category: string | null;
  payment_method: string | null;
  ledger: string | null;
  notes: string | null;
  extraction_confidence: number;
  review_status: 'complete' | 'needs_review';
  missing_fields: string[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstString(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstNumber(record: UnknownRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function parseMessageContent(contentJson: string): MessageDetails | null {
  let rawContent: unknown;
  try {
    rawContent = JSON.parse(contentJson);
  } catch {
    return null;
  }

  const root = asRecord(rawContent);
  if (!root) return { rawContent, text: null, sourceUserId: null, senderName: null, attachments: [] };

  const text = firstString(root, ['text', 'caption', 'body', 'message']);
  const sourceUserId = firstString(root, ['userId', 'senderId', 'authorId', 'fromId']);
  const senderName = firstString(root, ['senderName', 'authorName', 'displayName', 'username', 'fromName']);

  const attachmentCandidates = [root.attachments, root.files, root.photos, root.images]
    .filter(Array.isArray)
    .flat() as unknown[];

  const attachments = attachmentCandidates.map((item, index): AttachmentSummary => {
    const record = asRecord(item) ?? {};
    return {
      index,
      type: firstString(record, ['type', 'kind']) ?? null,
      filename: firstString(record, ['filename', 'name', 'fileName']) ?? null,
      mimeType: firstString(record, ['mimeType', 'mime_type', 'contentType']) ?? null,
      size: firstNumber(record, ['size', 'fileSize']) ?? null,
      width: firstNumber(record, ['width']) ?? null,
      height: firstNumber(record, ['height']) ?? null,
      fileId: firstString(record, ['fileId', 'file_id', 'id']) ?? null,
    };
  });

  return { rawContent, text, sourceUserId, senderName, attachments };
}

function normalizeCurrency(text: string): string | null {
  if (/\b(?:myr|rm)\b/i.test(text)) return 'MYR';
  if (/\b(?:sgd|s\$)\b/i.test(text)) return 'SGD';
  if (/\$/.test(text)) return process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD';
  return process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD';
}

function extractAmount(text: string): number | null {
  const match = text.match(/(?:\b(?:sgd|myr|rm|s\$)\s*)?(\d+(?:[.,]\d{1,2})?)(?!\d)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function extractPaymentMethod(text: string): string | null {
  const lowered = text.toLowerCase();
  if (/\b(cash)\b/.test(lowered)) return 'cash';
  if (/\b(paynow|pay now)\b/.test(lowered)) return 'paynow';
  if (/\b(grabpay|grab pay)\b/.test(lowered)) return 'grabpay';
  if (/\b(credit|cc|card|visa|mastercard|amex)\b/.test(lowered)) return 'card';
  if (/\b(debit)\b/.test(lowered)) return 'debit_card';
  if (/\b(bank|transfer)\b/.test(lowered)) return 'bank_transfer';
  return null;
}

function inferCategory(text: string): string | null {
  const lowered = text.toLowerCase();
  if (/\b(lunch|dinner|breakfast|coffee|kopi|tea|meal|food|restaurant|cafe|makan)\b/.test(lowered)) return 'food';
  if (/\b(grab|taxi|bus|mrt|train|ride|transport|parking|petrol|fuel)\b/.test(lowered)) return 'transport';
  if (/\b(grocery|groceries|ntuc|fairprice|cold storage|sheng siong|supermarket)\b/.test(lowered)) return 'groceries';
  if (/\b(phone|internet|electricity|water|utility|bill|subscription)\b/.test(lowered)) return 'bills';
  if (/\b(movie|cinema|game|netflix|spotify|entertainment)\b/.test(lowered)) return 'entertainment';
  if (/\b(clinic|doctor|dentist|pharmacy|medicine|health)\b/.test(lowered)) return 'healthcare';
  return null;
}

function inferMerchant(text: string, amount: number | null, paymentMethod: string | null): string | null {
  let cleaned = text
    .replace(/(?:\b(?:sgd|myr|rm|s\$)\s*)?\d+(?:[.,]\d{1,2})?/i, ' ')
    .replace(
      /\b(?:cash|paynow|pay now|grabpay|grab pay|credit|cc|card|visa|mastercard|amex|debit|bank|transfer)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (amount !== null && cleaned === String(amount)) cleaned = '';
  if (paymentMethod && cleaned.toLowerCase() === paymentMethod.toLowerCase()) cleaned = '';
  return cleaned || null;
}

export function extractExpense(details: MessageDetails, messageTimestamp: string): ExtractedExpense {
  const text = details.text ?? '';
  const amount = text ? extractAmount(text) : null;
  const currency = text ? normalizeCurrency(text) : (process.env.NANOCLAW_EXPENSE_DEFAULT_CURRENCY ?? 'SGD');
  const paymentMethod = text ? extractPaymentMethod(text) : null;
  const category = text ? inferCategory(text) : null;
  const merchant = text ? inferMerchant(text, amount, paymentMethod) : null;
  const transactionDate = messageTimestamp.slice(0, 10) || null;

  const missingFields: string[] = [];
  if (amount === null) missingFields.push('amount');
  if (!category) missingFields.push('category');
  if (!paymentMethod) missingFields.push('payment_method');

  let confidence = 0.1;
  if (details.text) confidence += 0.1;
  if (amount !== null) confidence += 0.4;
  if (category) confidence += 0.2;
  if (paymentMethod) confidence += 0.2;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  return {
    amount,
    currency,
    transaction_date: transactionDate,
    merchant,
    category,
    payment_method: paymentMethod,
    ledger: null,
    notes: details.text,
    extraction_confidence: confidence,
    review_status: missingFields.length === 0 ? 'complete' : 'needs_review',
    missing_fields: missingFields,
  };
}
