import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';

describe('sdk', () => {
  it('loads', () => {
    expect(packageName).toBe('@spend-brake/sdk');
  });
});
