import type { z } from 'zod';
import { MorphError } from '../shared/errors';

export interface SenderLike {
  /** URL of the frame that sent the message. */
  senderFrame?: { url: string; parent?: unknown } | null;
}

export interface TrustedOrigins {
  /** `file://` URL of the packaged renderer's index.html (compared by prefix of its directory). */
  fileUrlPrefix: string;
  /** Dev server origin, only set when running unpackaged. */
  devServerOrigin?: string;
}

/**
 * IPC senders must be Morph's own top-level page. This blocks any other frame, window or injected
 * content (for example a future <webview>) from reaching privileged handlers.
 */
export function isTrustedSender(event: SenderLike, trusted: TrustedOrigins): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false; // missing, or not the top-level frame
  const url = frame.url;
  if (trusted.devServerOrigin && (url === trusted.devServerOrigin || url.startsWith(`${trusted.devServerOrigin}/`))) return true;
  return url.startsWith(trusted.fileUrlPrefix);
}

/** Validates an IPC payload against its schema; the error is safe to return to the renderer. */
export function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new MorphError('INVALID_INPUT', 'The request was not valid.', { detail: result.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ') });
  }
  return result.data;
}
