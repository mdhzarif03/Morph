import { parentPort } from 'node:worker_threads';
import { toErrorInfo, type ErrorInfo } from '../../shared/errors';
import { executeInProcess, type ExecEvent, type ExecRequest } from '../executor';
import type { EngineResult } from '../engines/types';
import type { Logger } from '../logger';
import { setHtmlPrinter, type PrintRequest } from '../print';
import { MorphError, cancelledError } from '../../shared/errors';

export type WorkerInbound =
  | { type: 'run'; request: ExecRequest }
  | { type: 'abort' }
  | { type: 'printed'; id: number; error?: ErrorInfo };
export type WorkerOutbound =
  | { type: 'event'; event: ExecEvent }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta?: Record<string, unknown> }
  | { type: 'print'; id: number; request: PrintRequest }
  | { type: 'print-cancel'; id: number }
  | { type: 'done'; result: EngineResult }
  | { type: 'error'; error: ErrorInfo };

const port = parentPort;
if (!port) throw new Error('worker.ts must run inside a worker thread');

const controller = new AbortController();
const post = (message: WorkerOutbound) => port.postMessage(message);

const log: Logger = {
  debug: (message, meta) => post({ type: 'log', level: 'debug', message, ...(meta ? { meta } : {}) }),
  info: (message, meta) => post({ type: 'log', level: 'info', message, ...(meta ? { meta } : {}) }),
  warn: (message, meta) => post({ type: 'log', level: 'warn', message, ...(meta ? { meta } : {}) }),
  error: (message, meta) => post({ type: 'log', level: 'error', message, ...(meta ? { meta } : {}) }),
};

// HTML -> PDF needs Chromium, which only exists in the main process: ask it and wait for the answer.
const pendingPrints = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let nextPrintId = 1;
setHtmlPrinter((request, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const id = nextPrintId++;
    pendingPrints.set(id, { resolve, reject });
    signal.addEventListener(
      'abort',
      () => {
        if (pendingPrints.delete(id)) {
          post({ type: 'print-cancel', id });
          reject(cancelledError());
        }
      },
      { once: true },
    );
    post({ type: 'print', id, request });
  }),
);

port.on('message', (message: WorkerInbound) => {
  if (message.type === 'abort') {
    controller.abort();
    return;
  }
  if (message.type === 'printed') {
    const pending = pendingPrints.get(message.id);
    pendingPrints.delete(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new MorphError(message.error.code, message.error.message, message.error.detail === undefined ? undefined : { detail: message.error.detail }));
    else pending.resolve();
    return;
  }
  executeInProcess(message.request, (event) => post({ type: 'event', event }), controller.signal, log).then(
    (result) => post({ type: 'done', result }),
    (error: unknown) => post({ type: 'error', error: toErrorInfo(error) }),
  );
});
