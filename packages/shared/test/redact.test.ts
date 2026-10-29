import { describe, expect, it } from 'vitest';
import { MICROS_PER_USD, REDACTED, redactHeaders, redactText, redactUrl } from '../src/index.js';

describe('shared', () => {
  it('defines micros per dollar as a bigint', () => {
    expect(MICROS_PER_USD).toBe(1_000_000n);
  });
});

describe('redactUrl', () => {
  it('redacts credential query parameters and keeps the rest', () => {
    expect(redactUrl('/google-maps/maps/api/geocode/json?address=Sofia&key=AIzaSyREAL')).toBe(
      `/google-maps/maps/api/geocode/json?address=Sofia&key=${REDACTED}`,
    );
    expect(redactUrl('/x?KEY=a&Signature=b&access_token=c&q=1')).toBe(
      `/x?KEY=${REDACTED}&Signature=${REDACTED}&access_token=${REDACTED}&q=1`,
    );
    expect(redactUrl('/x?%6Bey=secret')).toBe(`/x?%6Bey=${REDACTED}`);
    expect(redactUrl('/no/query')).toBe('/no/query');
  });

  it('redacts virtual keys anywhere in the URL', () => {
    expect(redactUrl('/x/sb_live_abcDEF123?q=sb_live_zzz')).toBe(`/x/${REDACTED}?q=${REDACTED}`);
  });
});

describe('redactHeaders', () => {
  it('redacts credential headers case-insensitively', () => {
    expect(
      redactHeaders({
        'X-Brake-Key': 'sb_live_x',
        'x-goog-api-key': 'AIza',
        Authorization: 'Bearer t',
        accept: 'application/json',
      }),
    ).toEqual({
      'X-Brake-Key': REDACTED,
      'x-goog-api-key': REDACTED,
      Authorization: REDACTED,
      accept: 'application/json',
    });
  });
});

describe('redactText', () => {
  it('removes virtual keys and listed secrets', () => {
    expect(redactText('bad key sb_live_abc and AIzaSECRET', ['AIzaSECRET'])).toBe(
      `bad key ${REDACTED} and ${REDACTED}`,
    );
  });
});
