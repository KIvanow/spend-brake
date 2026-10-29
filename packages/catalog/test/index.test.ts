import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.js';

describe('catalog', () => {
  it('loads', () => {
    expect(packageName).toBe('@spend-brake/catalog');
  });
});
