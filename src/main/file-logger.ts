import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * A small synchronous local log file with one rotation. Logs never leave the machine and never
 * contain file contents; callers pass identifiers and error codes, not user data.
 */
export function createFileLogger(logDirectory: string, debug = false): Logger & { file: string } {
  const file = path.join(logDirectory, 'morph.log');
  try {
    mkdirSync(logDirectory, { recursive: true });
  } catch {
    /* logging is best effort */
  }

  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    try {
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
      } catch {
        /* no file yet */
      }
      const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
      appendFileSync(file, line, 'utf8');
    } catch {
      /* ignore */
    }
  };

  return {
    file,
    debug: (m, meta) => {
      if (debug) write('DEBUG', m, meta);
    },
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
