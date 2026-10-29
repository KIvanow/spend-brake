export interface Worker {
  stop(): Promise<void>;
}

export function startWorker(log: (msg: string) => void = console.log): Worker {
  log('worker started');
  // Keeps the process alive until real jobs (ledger flush, sweeper, alerts) are registered.
  const timer = setInterval(() => undefined, 60_000);
  return {
    stop() {
      clearInterval(timer);
      log('worker stopped');
      return Promise.resolve();
    },
  };
}
