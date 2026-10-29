import { describe, expect, it } from 'vitest';
import { startWorker } from '../src/worker.js';

describe('worker', () => {
  it('starts and stops', async () => {
    const lines: string[] = [];
    const worker = startWorker((m) => lines.push(m));
    await worker.stop();
    expect(lines).toEqual(['worker started', 'worker stopped']);
  });
});
