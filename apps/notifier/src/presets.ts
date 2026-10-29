import type { Message } from './message.js';

export type Preset = 'raw' | 'slack' | 'discord' | 'teams';

// Slack mrkdwn needs &, < and > escaped; links are buttons, so the text never carries URLs.
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Discord markdown: keep user data from forming links or mentions.
const discordEscape = (s: string) => s.replace(/([\\[\]()*_~`>|@])/g, '\\$1');

/** Render a message for an incoming-webhook URL: no app install is needed for any of them. */
export function render(preset: Preset, m: Message): unknown {
  switch (preset) {
    case 'raw':
      return m;
    case 'slack':
      return {
        text: m.title,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${slackEscape(m.title)}*\n${slackEscape(m.text)}` },
          },
          ...(m.actions.length
            ? [
                {
                  type: 'actions',
                  elements: m.actions.map((a) => ({
                    type: 'button',
                    action_id: a.id,
                    text: { type: 'plain_text', text: a.label },
                    url: a.url,
                    ...(a.id === 'kill' ? { style: 'danger' } : {}),
                  })),
                },
              ]
            : []),
        ],
      };
    case 'discord':
      return {
        content: `**${discordEscape(m.title)}**`,
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: m.title.slice(0, 256),
            description: [
              discordEscape(m.text),
              m.actions.map((a) => `[${a.label}](${a.url})`).join(' · '),
            ]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 4096),
            color: m.type === 'threshold' || m.type === 'catalog_drift' ? 0xf5a623 : 0xd0021b,
            timestamp: m.occurredAt,
          },
        ],
      };
    case 'teams':
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: m.title, weight: 'Bolder', wrap: true },
                { type: 'TextBlock', text: m.text, wrap: true },
              ],
              actions: m.actions.map((a) => ({
                type: 'Action.OpenUrl',
                title: a.label,
                url: a.url,
              })),
            },
          },
        ],
      };
  }
}
