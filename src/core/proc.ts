import { spawn, type ChildProcess } from 'node:child_process';
import { MorphError, cancelledError } from '../shared/errors';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Upper bound of captured stdout / stderr, in bytes. Output beyond this is discarded. */
  maxCaptureBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const isWindows = process.platform === 'win32';

/** Kills a process and all of its descendants. FFmpeg and other tools may spawn helpers of their own. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (isWindows) {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Runs an executable *without a shell*. `args` is passed as an argv array, so file names and option
 * values can never be interpreted as shell syntax.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { signal, timeoutMs, onStdoutLine, onStderrLine } = options;
  const maxCapture = options.maxCaptureBytes ?? 1_000_000;

  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }

    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };

    const onAbort = () => {
      killTree(child);
      finish(() => reject(cancelledError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killTree(child);
        finish(() => reject(new MorphError('TIMEOUT', 'The conversion took too long and was stopped.', { detail: `Timed out after ${Math.round(timeoutMs / 1000)}s` })));
      }, timeoutMs);
    }

    const lineSplitter = (cb: ((line: string) => void) | undefined) => {
      let pending = '';
      return (chunk: string) => {
        if (!cb) return;
        pending += chunk;
        let idx: number;
        while ((idx = pending.indexOf('\n')) >= 0) {
          cb(pending.slice(0, idx).replace(/\r$/, ''));
          pending = pending.slice(idx + 1);
        }
        if (pending.length > 65_536) pending = pending.slice(-4096);
      };
    };
    const outLines = lineSplitter(onStdoutLine);
    const errLines = lineSplitter(onStderrLine);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxCapture) stdout += chunk.slice(0, maxCapture - stdout.length);
      outLines(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      // Keep the *tail* of stderr: the error is almost always at the end.
      if (stderr.length > maxCapture) stderr = stderr.slice(-maxCapture);
      errLines(chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new MorphError('TOOL_MISSING', 'A required helper program could not be started.', { detail: `${command}: ${error.message}` }));
        } else if (error.code === 'EACCES' || error.code === 'EPERM') {
          reject(new MorphError('PERMISSION_DENIED', 'Morph is not allowed to run a required helper program.', { detail: `${command}: ${error.message}` }));
        } else {
          reject(error);
        }
      });
    });

    child.on('close', (code, sig) => {
      finish(() => resolve({ code, signal: sig, stdout, stderr }));
    });
  });
}

/** Last `n` non-empty lines, used to attach concise tool diagnostics to errors. */
export function tailLines(text: string, n = 8): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n');
}
