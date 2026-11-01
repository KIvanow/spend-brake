import { describe, expect, it } from 'vitest';
import { shutdown } from '../src/shutdown.js';

function recorder() {
  const codes: number[] = [];
  const errors: string[] = [];
  return {
    codes,
    errors,
    opts: (timeoutMs: number) => ({
      timeoutMs,
      onError: (_err: unknown, msg: string) => errors.push(msg),
      exit: (code: number) => codes.push(code),
    }),
  };
}

describe('shutdown', () => {
  it('exits 0 once stopped', async () => {
    const r = recorder();
    await shutdown(async () => {}, r.opts(1_000));
    expect(r.codes).toEqual([0]);
    expect(r.errors).toEqual([]);
  });

  it('exits 1 when stopping fails', async () => {
    const r = recorder();
    await shutdown(() => Promise.reject(new Error('quit failed')), r.opts(1_000));
    expect(r.codes).toEqual([1]);
    expect(r.errors).toEqual(['shutdown failed']);
  });

  it('forces an exit when stopping hangs', async () => {
    const r = recorder();
    void shutdown(() => new Promise(() => {}), r.opts(20));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.codes).toEqual([1]);
    expect(r.errors).toEqual(['forced exit']);
  });
});
