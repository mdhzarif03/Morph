import { Worker } from 'node:worker_threads';
import { MorphError, cancelledError } from '../../shared/errors';
import type { Executor } from '../executor';
import type { WorkerInbound, WorkerOutbound } from './worker';

const FORCE_TERMINATE_AFTER_MS = 8000;

/**
 * Creates an executor that runs each conversion in its own worker thread, so decoding, encoding and
 * process supervision never block the Electron main process (and with it the UI and shortcut).
 */
export function createWorkerExecutor(workerFile: string): Executor {
  return (request, onEvent, signal, log) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      const worker = new Worker(workerFile);
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        signal.removeEventListener('abort', onAbort);
        void worker.terminate();
        action();
      };

      const onAbort = () => {
        // Ask the worker to abort cleanly (this kills child processes); force-stop if it does not respond.
        worker.postMessage({ type: 'abort' } satisfies WorkerInbound);
        forceTimer = setTimeout(() => finish(() => reject(cancelledError())), FORCE_TERMINATE_AFTER_MS);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (message: WorkerOutbound) => {
        switch (message.type) {
          case 'event':
            onEvent(message.event);
            break;
          case 'log':
            log[message.level](message.message, message.meta);
            break;
          case 'done':
            finish(() => resolve(message.result));
            break;
          case 'error':
            finish(() => reject(new MorphError(message.error.code, message.error.message, message.error.detail === undefined ? undefined : { detail: message.error.detail })));
            break;
        }
      });
      worker.on('error', (error) => finish(() => reject(new MorphError('INTERNAL', 'The conversion process crashed.', { detail: error.message }))));
      worker.on('exit', (code) => {
        if (!settled) finish(() => reject(new MorphError('INTERNAL', 'The conversion process stopped unexpectedly.', { detail: `exit code ${code}` })));
      });
      worker.postMessage({ type: 'run', request } satisfies WorkerInbound);
    });
}
