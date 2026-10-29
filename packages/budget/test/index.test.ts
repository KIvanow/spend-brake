import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';

describe('budget', () => {
  it('loads', () => {
    expect(packageName).toBe('@spend-brake/budget');
  });
});
