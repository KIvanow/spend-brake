import { describe, expect, it } from 'vitest';
import { MICROS_PER_USD } from '../src/index.js';

describe('shared', () => {
  it('defines micros per dollar as a bigint', () => {
    expect(MICROS_PER_USD).toBe(1_000_000n);
  });
});
