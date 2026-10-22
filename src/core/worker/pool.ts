import { Worker } from 'node:worker_threads';
import { MorphError, cancelledError } from '../../shared/errors';
import type { Executor } from '../executor';
import { toErrorInfo } from '../../shared/errors';
import type { HtmlPrinter } from '../print';
import type { WorkerInbound, WorkerOutbound } from './worker';

const FORCE_TERMINATE_AFTER_MS = 8000;

/**
 * Creates an executor that runs each conversion in its own worker thread, so decoding, encoding and
 * process supervision never block the Electron main process (and with it the UI and shortcut).
 */
export function createWorkerExecutor(workerFile: string, printer: HtmlPrinter): Executor {
  return (request, onEvent, signal, log) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      const worker = new Worker(workerFile);
      const printControllers = new Map<number, AbortController>();
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        signal.removeEventListener('abort', onAbort);
        for (const c of printControllers.values()) c.abort();
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
          case 'print': {
            const controller = new AbortController();
            printControllers.set(message.id, controller);
            printer(message.request, controller.signal).then(
              () => worker.postMessage({ type: 'printed', id: message.id } satisfies WorkerInbound),
              (error: unknown) => worker.postMessage({ type: 'printed', id: message.id, error: toErrorInfo(error) } satisfies WorkerInbound),
            ).finally(() => printControllers.delete(message.id));
            break;
          }
          case 'print-cancel':
            printControllers.get(message.id)?.abort();
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
