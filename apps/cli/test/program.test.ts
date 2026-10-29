import { describe, expect, it } from 'vitest';
import { VERSION, buildProgram } from '../src/program.js';

describe('brake program', () => {
  it('reports its version', () => {
    const program = buildProgram().exitOverride();
    let out = '';
    program.configureOutput({ writeOut: (s) => (out += s) });
    expect(() => program.parse(['node', 'brake', '--version'])).toThrow();
    expect(out.trim()).toBe(VERSION);
  });
});
