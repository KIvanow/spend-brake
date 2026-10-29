import { describe, expect, it } from 'vitest';
import { countSegments } from '../src/twilio/segments.js';

const golden: [string, string, 'GSM-7' | 'UCS-2', number][] = [
  ['empty', '', 'GSM-7', 1],
  ['short', 'Your code is 123456', 'GSM-7', 1],
  ['160 GSM', 'a'.repeat(160), 'GSM-7', 1],
  ['161 GSM', 'a'.repeat(161), 'GSM-7', 2],
  ['306 GSM', 'a'.repeat(306), 'GSM-7', 2],
  ['307 GSM', 'a'.repeat(307), 'GSM-7', 3],
  ['80 euro signs (2 septets each) = 160', '€'.repeat(80), 'GSM-7', 1],
  ['81 euro signs = 162 septets', '€'.repeat(81), 'GSM-7', 2],
  ['escape not split at 153', `${'a'.repeat(152)}€${'a'.repeat(10)}`, 'GSM-7', 2],
  ['GSM accented letters stay GSM', 'Café à Zürich: ÄÖÑÜ', 'GSM-7', 1],
  ['70 UCS-2', 'ж'.repeat(70), 'UCS-2', 1],
  ['71 UCS-2', 'ж'.repeat(71), 'UCS-2', 2],
  ['134 UCS-2', 'ж'.repeat(134), 'UCS-2', 2],
  ['135 UCS-2', 'ж'.repeat(135), 'UCS-2', 3],
  ['one emoji forces UCS-2', `${'a'.repeat(69)}😀`, 'UCS-2', 2],
  ['35 emoji = 70 units', '😀'.repeat(35), 'UCS-2', 1],
  ['surrogate pair not split at 67', `${'a'.repeat(66)}😀${'a'.repeat(66)}`, 'UCS-2', 3],
  ['curly quote is not GSM', 'It’s here', 'UCS-2', 1],
];

describe('SMS segments', () => {
  it.each(golden)('%s', (_name, body, encoding, segments) => {
    expect(countSegments(body)).toEqual({ encoding, segments });
  });
});
