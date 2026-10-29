# @spend-brake/notifier

Turns alert jobs (queued by the worker) into messages: signed outgoing webhooks, with email as the
fallback, and serves the confirm pages behind each alert's action links.

## Webhooks

Configured per org through the admin API (`POST /v1/webhooks`), with a preset that formats the
payload for an incoming-webhook URL, so no app has to be installed anywhere:

| Preset    | Body                                                                | Use with                          |
| --------- | ------------------------------------------------------------------- | --------------------------------- |
| `raw`     | Spend Brake JSON (`id`, `type`, `title`, `text`, `data`, `actions`) | n8n, Zapier, PagerDuty, your code |
| `slack`   | Blocks with link buttons                                            | Slack incoming webhook            |
| `discord` | Embed with markdown links, mentions disabled                        | Discord webhook                   |
| `teams`   | Adaptive card with `Action.OpenUrl`                                 | Teams / Workflows webhook         |

Every delivery is a JSON `POST` signed with the webhook's secret (shown once at creation):

```
X-Brake-Timestamp: 1793275200
X-Brake-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

Receivers should reject timestamps more than 5 minutes off; `verifyWebhook` in
`@spend-brake/shared` does both checks. Failed deliveries are retried with backoff (10 s doubling
to 1 h, then hourly) for about 24 hours; every attempt is in the delivery log
(`GET /v1/webhooks/{id}/deliveries`). Webhook URLs and secrets are envelope-encrypted and never
shown or logged. Hosts that resolve to private addresses are refused unless
`ALLOW_PRIVATE_WEBHOOKS=true`.

With no webhook, alerts go to the org's `alertEmail` (`PUT /v1/org`) over SMTP. Operator alerts
(catalog drift) go to `OPERATOR_EMAIL`.

## Alerts and actions

| Alert                                                               | Actions                                       |
| ------------------------------------------------------------------- | --------------------------------------------- |
| `threshold` (50/80/100%, soft)                                      | Kill · Raise +$25 / +$50 / custom · Mute 24 h |
| `blocked`                                                           | Raise · View                                  |
| `loop`                                                              | Kill key · Reset circuit                      |
| `catalog_underpriced`, `upstream_key_error`, `reservations_expired` | View                                          |
| `catalog_drift`                                                     | View source (operator)                        |

Actions are links, not buttons: `GET /a/<token>` only shows a confirm page (so link previews and
URL scanners change nothing); the form `POST`s to the admin API's `/v1/actions/execute`. Tokens
are HMAC-signed with `BRAKE_ACTION_SECRET` (shared with the API), bound to one org, action, target
and amount, expire after 15 minutes and work once. Every action is in the audit log with the
actor `link:<id>`. Orgs with `requireLoginForRaise` get no raise form; their caps are raised from
the dashboard. Muted scopes (`Mute 24 h`) drop their alerts; caps keep enforcing.

## Configuration (env)

| Variable                                         | Default                                      |
| ------------------------------------------------ | -------------------------------------------- |
| `PORT`                                           | `8082`                                       |
| `DATABASE_URL`, `VALKEY_URL`                     | as the API                                   |
| `BRAKE_ACTION_SECRET`                            | required; same value as the API              |
| `BRAKE_MASTER_KEY` / `BRAKE_KMS_KEY_ID`          | required (decrypts webhook URLs and secrets) |
| `BRAKE_PUBLIC_URL`                               | `http://localhost:8082` (where links point)  |
| `BRAKE_API_URL`                                  | `http://localhost:8081`                      |
| `BRAKE_DASHBOARD_URL`                            | optional, for View links                     |
| `BRAKE_ACTION_TTL_SEC`                           | `900`                                        |
| `BRAKE_MAX_CUSTOM_RAISE_USD`                     | `500`                                        |
| `SMTP_URL`, `BRAKE_EMAIL_FROM`, `OPERATOR_EMAIL` | optional                                     |
| `ALLOW_PRIVATE_WEBHOOKS`                         | `false`                                      |
