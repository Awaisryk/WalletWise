export interface ProviderErrorInfo {
  requestId?: string;
  statusCode?: number;
  code?: string;
  type?: string;
  message?: string;
  failedGeneration?: string;
}

const MAX_CAUSE_DEPTH = 4;

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function mergeProviderErrorInfo(
  left: ProviderErrorInfo | null,
  right: ProviderErrorInfo | null,
): ProviderErrorInfo | null {
  if (!left) return right;
  if (!right) return left;
  return {
    requestId: left.requestId ?? right.requestId,
    statusCode: left.statusCode ?? right.statusCode,
    code: left.code ?? right.code,
    type: left.type ?? right.type,
    message: left.message ?? right.message,
    failedGeneration: left.failedGeneration ?? right.failedGeneration,
  };
}

function extractFromObject(value: Record<string, any>, depth: number): ProviderErrorInfo | null {
  const error = value.error && typeof value.error === "object" ? value.error : value;
  const info: ProviderErrorInfo = {
    requestId: firstString(
      value.request_id,
      value.requestId,
      value.id,
      error.request_id,
      error.requestId,
    ),
    statusCode: firstNumber(value.status_code, value.statusCode, value.status, error.status_code),
    code: firstString(error.code, value.code),
    type: firstString(error.type, value.type),
    message: firstString(error.message, value.message),
    failedGeneration: firstString(
      error.failed_generation,
      error.failedGeneration,
      value.failed_generation,
      value.failedGeneration,
    ),
  };

  const nested = [
    value.responseBody,
    value.data,
    value.body,
    value.raw,
    value.rawValue,
    value.cause,
    error.cause,
  ];
  let merged: ProviderErrorInfo | null =
    info.requestId ||
    info.statusCode ||
    info.code ||
    info.type ||
    info.message ||
    info.failedGeneration
      ? info
      : null;
  if (depth >= MAX_CAUSE_DEPTH) return merged;

  for (const item of nested) {
    merged = mergeProviderErrorInfo(merged, extractProviderErrorInfo(item, depth + 1));
  }
  return merged;
}

export function extractProviderErrorInfo(
  value: unknown,
  depth = 0,
): ProviderErrorInfo | null {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed)) {
    return parsed.reduce<ProviderErrorInfo | null>(
      (acc, item) => mergeProviderErrorInfo(acc, extractProviderErrorInfo(item, depth + 1)),
      null,
    );
  }
  return extractFromObject(parsed as Record<string, any>, depth);
}

export function isProviderGenerationError(info: ProviderErrorInfo | null | undefined): boolean {
  if (!info) return false;
  return ["tool_use_failed", "json_validate_failed"].includes(info.code ?? "");
}

export function formatProviderErrorForLog(info: ProviderErrorInfo): string {
  const parts = [
    info.requestId ? `requestId=${info.requestId}` : null,
    info.code ? `code=${info.code}` : null,
    info.type ? `type=${info.type}` : null,
    info.statusCode ? `status=${info.statusCode}` : null,
    info.message ? `message=${info.message}` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

export function truncateFailedGeneration(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`;
}
