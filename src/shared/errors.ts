export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_INPUT'
  | 'CORRUPT_INPUT'
  | 'PASSWORD_PROTECTED'
  | 'INPUT_TOO_LARGE'
  | 'TOOL_MISSING'
  | 'ENCODER_MISSING'
  | 'TOOL_FAILED'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL'
  | 'INVALID_OPTIONS'
  | 'SOURCE_CHANGED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERNAL';

/** Serializable error description that can cross the worker and IPC boundaries. */
export interface ErrorInfo {
  code: ErrorCode;
  /** Short, user-facing explanation. */
  message: string;
  /** Technical detail (tool stderr etc.). Never contains file contents. */
  detail?: string;
}

export class MorphError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { detail?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MorphError';
    this.code = code;
    this.detail = options?.detail;
  }

  toInfo(): ErrorInfo {
    return this.detail === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof MorphError && error.code === 'CANCELLED') ||
    (error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR'))
  );
}

/** Converts any thrown value to a safe, serializable ErrorInfo. */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof MorphError) return error.toInfo();
  if (isAbortError(error)) return { code: 'CANCELLED', message: 'The conversion was cancelled.' };
  const errno = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return { code: 'PERMISSION_DENIED', message: 'Morph does not have permission to read or write there.', detail: message };
    case 'ENOSPC':
      return { code: 'DISK_FULL', message: 'The disk is full.', detail: message };
    case 'ENOENT':
      return { code: 'INVALID_INPUT', message: 'The file could not be found. It may have been moved or deleted.', detail: message };
    default:
      return { code: 'INTERNAL', message: 'Something went wrong during the conversion.', detail: message };
  }
}

export function cancelledError(): MorphError {
  return new MorphError('CANCELLED', 'The conversion was cancelled.');
}
