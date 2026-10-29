// SMS segments as carriers bill them. GSM-7 text: 160 septets in one segment, 153 per segment
// when concatenated; extension characters take two septets and never split across segments.
// Anything outside GSM-7 sends the whole message as UCS-2: 70 code units in one segment, 67 per
// segment when concatenated, surrogate pairs kept together.

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENSION = '\f^{}\\[~]|€';

const basic = new Set(GSM_BASIC);
const extension = new Set(GSM_EXTENSION);

export type Encoding = 'GSM-7' | 'UCS-2';

export interface SegmentCount {
  encoding: Encoding;
  segments: number;
}

export function countSegments(body: string): SegmentCount {
  const chars = [...body];
  if (chars.every((c) => basic.has(c) || extension.has(c))) {
    const costs = chars.map((c) => (extension.has(c) ? 2 : 1));
    const total = costs.reduce((a, b) => a + b, 0);
    if (total <= 160) return { encoding: 'GSM-7', segments: 1 };
    return { encoding: 'GSM-7', segments: pack(costs, 153) };
  }
  const units = chars.map((c) => c.length); // code points: 1 or 2 UTF-16 units
  const total = units.reduce((a, b) => a + b, 0);
  if (total <= 70) return { encoding: 'UCS-2', segments: 1 };
  return { encoding: 'UCS-2', segments: pack(units, 67) };
}

/** Greedy packing that never splits one character's units across segments. */
function pack(costs: number[], capacity: number): number {
  let segments = 1;
  let used = 0;
  for (const c of costs) {
    if (used + c > capacity) {
      segments++;
      used = 0;
    }
    used += c;
  }
  return segments;
}
