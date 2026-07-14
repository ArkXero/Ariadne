import type { FailureCategory, LifecycleStage } from "../types/index.js";

export interface AriadneErrorOptions {
  category: FailureCategory;
  code: string;
  stage: LifecycleStage;
  message: string;
  source?: string;
  fieldPath?: string;
  offendingValue?: unknown;
  expected?: string;
  correction?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AriadneError extends Error {
  readonly category: FailureCategory;
  readonly code: string;
  readonly stage: LifecycleStage;
  readonly source?: string;
  readonly fieldPath?: string;
  readonly offendingValue?: unknown;
  readonly expected?: string;
  readonly correction?: string;
  readonly details?: Record<string, unknown>;

  constructor(options: AriadneErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AriadneError";
    this.category = options.category;
    this.code = options.code;
    this.stage = options.stage;
    this.source = options.source;
    this.fieldPath = options.fieldPath;
    this.offendingValue = options.offendingValue;
    this.expected = options.expected;
    this.correction = options.correction;
    this.details = options.details;
  }
}

export function asAriadneError(error: unknown, fallback: Omit<AriadneErrorOptions, "message">): AriadneError {
  if (error instanceof AriadneError) {
    return error;
  }

  return new AriadneError({
    ...fallback,
    message: error instanceof Error ? error.message : String(error),
    cause: error
  });
}

export function safeValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
  } catch {
    return "[unserializable]";
  }
}

export function formatAriadneError(error: AriadneError, verbose = false): string {
  const lines = [`[${error.code}] ${error.message}`];
  if (error.source) lines.push(`Source: ${error.source}`);
  if (error.fieldPath) lines.push(`Field: ${error.fieldPath}`);
  const offending = safeValue(error.offendingValue);
  if (offending !== undefined) lines.push(`Value: ${offending}`);
  if (error.expected) lines.push(`Expected: ${error.expected}`);
  if (error.correction) lines.push(`Correction: ${error.correction}`);
  if (verbose && error.stack) lines.push("", error.stack);
  return lines.join("\n");
}

