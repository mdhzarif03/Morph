import { parentPort } from 'node:worker_threads';
import { toErrorInfo, type ErrorInfo } from '../../shared/errors';
import { executeInProcess, type ExecEvent, type ExecRequest } from '../executor';
import type { EngineResult } from '../engines/types';
import type { Logger } from '../logger';

export type WorkerInbound = { type: 'run'; request: ExecRequest } | { type: 'abort' };
export type WorkerOutbound =
  | { type: 'event'; event: ExecEvent }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta?: Record<string, unknown> }
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

port.on('message', (message: WorkerInbound) => {
  if (message.type === 'abort') {
    controller.abort();
    return;
  }
  executeInProcess(message.request, (event) => post({ type: 'event', event }), controller.signal, log).then(
    (result) => post({ type: 'done', result }),
    (error: unknown) => post({ type: 'error', error: toErrorInfo(error) }),
  );
});
