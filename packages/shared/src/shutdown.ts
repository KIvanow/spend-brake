/**
 * Graceful shutdown for a service: run `stop` once, then exit 0. A `stop` that fails exits 1
 * instead of leaving the process up with half its connections closed, and one that hangs is cut
 * off after `timeoutMs` so the orchestrator never has to kill it mid-write.
 */
export async function shutdown(
  stop: () => Promise<unknown>,
  opts: {
    timeoutMs: number;
    onError: (err: unknown, msg: string) => void;
    exit?: (code: number) => void;
  },
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timer = setTimeout(() => {
    opts.onError(new Error(`still stopping after ${opts.timeoutMs} ms`), 'forced exit');
    exit(1);
  }, opts.timeoutMs);
  timer.unref();
  try {
    await stop();
    clearTimeout(timer);
    exit(0);
  } catch (err) {
    clearTimeout(timer);
    opts.onError(err, 'shutdown failed');
    exit(1);
  }
}

/** Run `shutdown` on the first SIGINT or SIGTERM. */
export function onShutdownSignal(
  stop: () => Promise<unknown>,
  opts: { timeoutMs: number; onError: (err: unknown, msg: string) => void },
): void {
  let started = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (started) return;
      started = true;
      void shutdown(stop, opts);
    });
  }
}
