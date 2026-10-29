import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { App } from '../src/App.js';

describe('web app', () => {
  it('renders the title', () => {
    expect(renderToString(<App />)).toContain('Spend Brake');
  });
});
