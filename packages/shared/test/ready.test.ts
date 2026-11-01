import { describe, expect, it } from 'vitest';
import { answers } from '../src/ready.js';

describe('answers', () => {
  it('tells a store that replies from one that fails or hangs', async () => {
    expect(await answers(() => Promise.resolve('PONG'))).toBe(true);
    expect(await answers(() => Promise.reject(new Error('down')))).toBe(false);
    expect(await answers(() => new Promise(() => {}), 20)).toBe(false);
  });
});
