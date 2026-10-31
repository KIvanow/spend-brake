# @spend-brake/billing

Hosted plans and license sales through Stripe, **test mode only** (`sk_test_` / `rk_test_`
keys; a live key is refused at start).

| Plan       | Price                       | What                                                                                         |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| Free       | $0                          | 1 key, $50/month of protected spend                                                          |
| Indie      | $9/month                    | 2 providers, 100 agent sessions, 100k requests, 7 days                                       |
| Team       | $49/month                   | 5 providers, 500 sessions, 1M requests, 30 days                                              |
| Agents     | $149/month                  | Unlimited providers and sessions, 10M requests, 1 year, session analytics, custom loop rules |
| Business   | $299/month                  | Self-hosted license (ee/), 3 orgs                                                            |
| Enterprise | from $10,000/year, invoiced | Self-hosted license, 25 orgs (or `org_units` on the product)                                 |

Limits live in `src/plans.ts` and are written to `org_entitlements`; the admin API enforces
them, never the proxy. Orgs without a row (every self-hosted install) have no limits.
Downgrades and failed payments only block creating keys, providers and sessions: existing keys
and caps keep enforcing. When Stripe's dunning ends (subscription cancelled), the org drops to
Free limits.

## Endpoints (behind the dashboard at `/v1/billing`)

| Method | Path                   | Who    | What                                                                                                                  |
| ------ | ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/billing/signup`   | public | Create a Free org and email its owner a sign-in link; a paid plan returns a Checkout URL (`BRAKE_HOSTED_SIGNUP=true`) |
| GET    | `/v1/billing/plans`    | public | Plans with monthly prices and limits (the sign-up page and website read it)                                           |
| GET    | `/v1/billing`          | viewer | Plan, status, usage against limits, licenses                                                                          |
| POST   | `/v1/billing/checkout` | owner  | Stripe Checkout for a plan (first purchase)                                                                           |
| POST   | `/v1/billing/portal`   | owner  | Stripe Customer Portal: card, plan change, cancel                                                                     |
| GET    | `/v1/billing/license`  | owner  | The latest license file                                                                                               |
| POST   | `/v1/billing/webhook`  | Stripe | Signed events, each applied once                                                                                      |

A paid plan (sign-up or checkout) needs `"acceptTerms": true`: the buyer agrees to the Terms of
Service and Privacy Policy and asks for the plan to start now, waiving the 14-day right of
withdrawal. Without it the answer is 400 `terms_required`. The consent is written to the org's
audit log (`billing.terms_accepted`, with the plan and terms version), passed to Stripe as
subscription metadata (`terms_version`, `withdrawal_waiver`), and restated on the Checkout page
and in the welcome email.

Webhook events: `checkout.session.completed`, `customer.subscription.created`, `.updated`,
`.deleted`, `invoice.paid` (clears a failed payment; issues or renews the license for Business
and Enterprise lines, valid to the end of the paid period, emailed through the notifier and
downloadable in the dashboard), `invoice.payment_failed`.

Enterprise is sold by hand: create the customer with metadata `orgId` (an org created through
sign-up), then a Stripe invoice with a line on the "Spend Brake Enterprise" product (set
`org_units` in the product metadata, or leave the default). Paying the invoice issues the
license.

## Setting up Stripe (test mode)

```sh
STRIPE_SECRET_KEY=sk_test_... pnpm --filter @spend-brake/billing seed
```

creates the products, monthly prices (lookup keys `spend_brake_<plan>_monthly`) and the
Customer Portal configuration; running it again changes nothing.

Live mode, once, by hand: create a restricted live key (`rk_live_`, write access to Products,
Prices and Customer portal), then

```sh
STRIPE_SECRET_KEY=rk_live_... BRAKE_STRIPE_ALLOW_LIVE=true pnpm --filter @spend-brake/billing seed
```

The billing service itself still refuses live keys (test mode only).

## Local testing with the Stripe CLI

```sh
stripe login
stripe listen --forward-to localhost:8083/v1/billing/webhook   # prints whsec_...
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... BRAKE_HOSTED_SIGNUP=true \
  BRAKE_LICENSE_SIGNING_KEY_FILE=~/.config/spend-brake/license-ed25519.pem \
  pnpm --filter @spend-brake/billing dev
# sign up and buy Indie: open the returned checkout URL and pay with card 4242 4242 4242 4242
curl -s localhost:8083/v1/billing/signup -H 'content-type: application/json' \
  -d '{"orgId":"acme","name":"Acme","email":"you@example.com","plan":"indie","acceptTerms":true}'
stripe trigger invoice.payment_failed       # other events, for a quick look
```

Card `4000 0000 0000 0341` attaches but fails on payment, which exercises `past_due`.
