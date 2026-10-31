---
title: Alerts and webhooks
nav_order: 9
description: Signed webhooks with Slack, Discord and Teams presets, email alerts, and one-click Kill, Raise and Mute links.
---

# Alerts and webhooks

Spend Brake tells you before a cap is reached, when it stops a call, and when something looks
wrong. Each alert carries action links, so you can kill or raise from your phone.

## Alerts

| Alert                  | When                                                                        | Actions                                       |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| `threshold`            | Spend passes 50%, 80% or 100% of a cap, or a soft limit                     | Kill · Raise +$25 / +$50 / custom · Mute 24 h |
| `blocked`              | A call was refused at a cap (first per scope per hour)                      | Raise · View                                  |
| `loop`                 | The loop breaker opened a key's circuit                                     | Kill key · Reset circuit                      |
| `catalog_underpriced`  | A provider settled above the price Spend Brake reserved                     | View                                          |
| `upstream_key_error`   | The provider refused your real key (first per provider per hour)            | View                                          |
| `reservations_expired` | Reservations the proxy never settled were committed at worst case           | View                                          |
| `reconcile_drift`      | The ledger and Google's bill differ by more than 5% (Business / Enterprise) | View                                          |

Muting a scope for 24 hours drops its alerts; its caps keep enforcing.

## Where alerts go

Add webhooks under **Webhooks** in the dashboard, or with `POST /v1/webhooks`. A preset formats
the payload for an incoming-webhook URL, so no app has to be installed anywhere:

| Preset    | Body                                                                | Use with                          |
| --------- | ------------------------------------------------------------------- | --------------------------------- |
| `raw`     | Spend Brake JSON (`id`, `type`, `title`, `text`, `data`, `actions`) | n8n, Zapier, PagerDuty, your code |
| `slack`   | Blocks with link buttons                                            | Slack incoming webhook            |
| `discord` | Embed with markdown links, mentions disabled                        | Discord webhook                   |
| `teams`   | Adaptive card with `Action.OpenUrl`                                 | Teams / Workflows webhook         |

A webhook takes every alert unless you list the ones it wants (`events`). With no webhook, alerts go by email to
the org's alert address (`alertEmail`, set under **Webhooks** or with `PUT /v1/org`).

```sh
curl -X POST https://app.spendbrake.dev/v1/webhooks \
  -H "Authorization: Bearer sbt_…" -H "Content-Type: application/json" \
  -d '{"name":"ops","url":"https://hooks.slack.com/services/…","preset":"slack","events":["threshold","blocked","loop"]}'
```

Webhook URLs and secrets are encrypted and never shown or logged again.

## Verifying a delivery

Every delivery is a JSON `POST` signed with the webhook's secret, shown once when the webhook is
created:

```
X-Brake-Timestamp: 1793275200
X-Brake-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

Check the signature against the raw body, and reject timestamps more than 5 minutes off. In
Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, timestamp, signature, secret) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
```

Failed deliveries are retried with backoff (10 s, doubling to 1 h, then hourly) for about 24
hours. Every attempt is in the delivery log (`GET /v1/webhooks/{id}/deliveries`, or
**Deliveries** in the dashboard).

## Action links

Actions are links, not buttons. Opening one only shows a confirm page, so link previews and URL
scanners change nothing; confirming runs the action. Each link:

- is signed, bound to one org, action, target and amount;
- expires after 15 minutes and works once;
- is recorded in the audit log with the actor `link:<id>`.

Orgs that set `requireLoginForRaise` get no raise form in alerts; their caps are raised from the
dashboard.

## Self-hosted

Alerts are queued by the worker and sent by the notifier. Email needs `SMTP_URL` and
`BRAKE_EMAIL_FROM`; action links point at `BRAKE_PUBLIC_URL`. Webhook hosts that resolve to
private addresses are refused unless `ALLOW_PRIVATE_WEBHOOKS=true` on the notifier. Operator
alerts (catalog price drift) go to `OPERATOR_EMAIL`. See [Configuration](../configuration/).
