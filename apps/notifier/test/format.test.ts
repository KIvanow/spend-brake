import { verifyAction } from '@spend-brake/shared';
import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/deliver.js';
import { type LinkOptions, buildMessage, killTargetFor, usd } from '../src/message.js';
import { render } from '../src/presets.js';
import { redactActionPath } from '../src/server.js';

const SECRET = 'x'.repeat(40);
const links: LinkOptions = {
  publicUrl: 'https://brake.example.com',
  dashboardUrl: 'https://app.example.com',
  actionSecret: SECRET,
  ttlSec: 900,
  maxCustomMicros: 500_000_000n,
  now: () => new Date('2026-10-29T12:00:00Z'),
};
const token = (url: string) => url.split('/a/')[1]!;

describe('alert messages', () => {
  it('threshold: kill, raise +25/+50/custom and mute links bound to the scope', () => {
    const m = buildMessage(
      'a1',
      { type: 'threshold', orgId: 'o1', scope: 'key:k1', window: 'd:20261029', mark: '80' },
      links,
    );
    expect(m.title).toBe('Spend at 80% of cap: key:k1 (today)');
    expect(m.actions.map((a) => a.id)).toEqual([
      'kill',
      'raise_25',
      'raise_50',
      'raise_custom',
      'mute',
    ]);
    const claims = m.actions.map((a) => {
      const r = verifyAction(SECRET, token(a.url), 1793275200);
      if (!r.ok) throw new Error(r.reason);
      return r.claims;
    });
    expect(claims[0]).toMatchObject({ org: 'o1', act: 'kill', target: 'key:k1', alert: 'a1' });
    expect(claims[1]).toMatchObject({
      act: 'raise',
      target: 'key:k1',
      kind: 'd',
      amount: '25000000',
    });
    expect(claims[3]).toMatchObject({ amount: 'custom', max: '500000000' });
    expect(claims[4]).toMatchObject({ act: 'mute', target: 'key:k1' });
    // 15-minute expiry, unique ids.
    expect(claims[0]!.exp).toBe(Math.floor(links.now().getTime() / 1000) + 900);
    expect(new Set(claims.map((c) => c.jti)).size).toBe(5);
  });

  it('monthly windows raise the monthly cap', () => {
    const m = buildMessage(
      'a',
      { type: 'blocked', orgId: 'o', scope: 'org', window: 'm:202610', worstMicros: '32000' },
      links,
    );
    expect(m.text).toContain('$0.03');
    const r = verifyAction(SECRET, token(m.actions[0]!.url), 1793275200);
    expect(r.ok && r.claims.kind).toBe('m');
    expect(m.actions.at(-1)).toEqual({
      id: 'view',
      label: 'View',
      url: 'https://app.example.com/caps',
    });
  });

  it('loop: kill key and reset circuit', () => {
    const m = buildMessage('a', { type: 'loop', orgId: 'o', keyId: 'k9', session: 's1' }, links);
    expect(m.actions.map((a) => a.label)).toEqual(['Kill key', 'Reset circuit']);
    const reset = verifyAction(SECRET, token(m.actions[1]!.url), 1793275200);
    expect(reset.ok && reset.claims).toMatchObject({ act: 'reset', target: 'k9' });
  });

  it('maps scopes to the kill target that stops them', () => {
    expect(killTargetFor('key:k1')).toBe('key:k1');
    expect(killTargetFor('sess:s1')).toBe('sess:s1');
    expect(killTargetFor('sku:google-maps:geocoding')).toBe('prov:google-maps');
    expect(killTargetFor('env:ci')).toBe('org');
    expect(killTargetFor('org')).toBe('org');
  });

  it('formats micros as dollars', () => {
    expect(usd(25_000_000)).toBe('$25.00');
    expect(usd('2830')).toBe('$0.00');
    expect(usd('32000')).toBe('$0.03');
    expect(usd('1234567')).toBe('$1.23');
  });
});

describe('presets', () => {
  const m = buildMessage(
    'a1',
    { type: 'threshold', orgId: 'o1', scope: 'key:<b>&k', window: 'd:20261029', mark: '50' },
    links,
  );

  it('raw is the message itself', () => {
    expect(render('raw', m)).toBe(m);
  });

  it('slack: escaped mrkdwn section and link buttons', () => {
    const s = render('slack', m) as {
      text: string;
      blocks: {
        type: string;
        text?: { text: string };
        elements?: { url: string; style?: string }[];
      }[];
    };
    expect(s.text).toBe(m.title);
    expect(s.blocks[0]!.text!.text).toContain('key:&lt;b&gt;&amp;k');
    expect(s.blocks[1]!.elements!.map((e) => e.url)).toEqual(m.actions.map((a) => a.url));
    expect(s.blocks[1]!.elements![0]!.style).toBe('danger');
  });

  it('discord: no mentions, markdown links', () => {
    const d = render('discord', m) as {
      allowed_mentions: unknown;
      embeds: { description: string }[];
    };
    expect(d.allowed_mentions).toEqual({ parse: [] });
    expect(d.embeds[0]!.description).toContain(`[Mute 24 h](${m.actions.at(-1)!.url})`);
  });

  it('teams: adaptive card with open-URL actions', () => {
    const t = render('teams', m) as {
      attachments: { content: { actions: { type: string; url: string }[] } }[];
    };
    expect(t.attachments[0]!.content.actions.every((a) => a.type === 'Action.OpenUrl')).toBe(true);
    expect(t.attachments[0]!.content.actions).toHaveLength(m.actions.length);
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('logs', () => {
  it('redact action tokens in paths', () => {
    expect(redactActionPath('/a/eyJ2IjoxfQ.c2ln?x=1')).toBe('/a/[redacted]?x=1');
  });
});
