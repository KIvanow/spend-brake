import { startWorker } from './worker.js';

const worker = startWorker();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void worker.stop().then(() => process.exit(0)));
}
