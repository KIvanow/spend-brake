# @spend-brake/billing

Hosted plans and license sales through Stripe, **test mode by default** (`sk_test_` /
`rk_test_` keys). Live mode takes `BILLING_LIVE_MODE=true` and a live key (`sk_live_` /
`rk_live_`); the service refuses to start on a mismatch either way (a live key without the
flag, or a test key with it).

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

## Tax

Prices exclude VAT (`tax_behavior: exclusive` on every price; the sign-up page says so). Checkout
always asks for the billing address and offers a VAT ID field, saving both on the customer
(`customer_update: { address: 'auto', name: 'auto' }`, which Stripe requires with an existing
customer). With `BILLING_AUTOMATIC_TAX=true`, the default in live mode, it also turns on Stripe
Tax (`automatic_tax`), which adds VAT on top where it applies (a valid business VAT ID in another
EU country makes it reverse charge); the subscription keeps automatic tax, so portal plan
changes and renewals are taxed the same way. Stripe Tax needs the account's origin address and
registrations set up first, so test mode leaves it off unless asked for.

A price's tax behavior can be set only once. The seed gives `exclusive` to an existing price
that has none (`unspecified`), and replaces one that is `inclusive`: the new price takes over
the lookup key, the old one is archived and its subscriptions keep it until the customer changes
plan. Billing looks prices up by lookup key, so nothing else changes.

## Setting up Stripe

```sh
STRIPE_SECRET_KEY=sk_test_... pnpm --filter @spend-brake/billing seed
```

creates the products, monthly prices (lookup keys `spend_brake_<plan>_monthly`) and the
Customer Portal configuration (metadata `spend_brake_portal=1`), and prints their ids. Running
it again creates nothing: a price that no longer matches `src/plans.ts` is replaced (the new one
takes over the lookup key, the old one is archived and keeps its subscribers), and the portal
configuration is rewritten so it lists the current prices. Nothing from the output goes into
`.env`: the service finds prices by lookup key and the portal configuration by its metadata,
and names it on every portal session (a configuration created through the API is never the
account's default).

The portal lets customers switch between Indie, Team and Agents (prorated), cancel at the end of
the period, update their card, name, email, address and tax ID, and see their invoices; it links
the Privacy Policy and Terms (`https://spendbrake.dev/privacy`, `/terms`) and returns to
`$BRAKE_DASHBOARD_URL/#/billing` (default `https://app.spendbrake.dev`).

Live mode: the scripts refuse a live key unless `BRAKE_STRIPE_ALLOW_LIVE=1`. Use a restricted
live key (`rk_live_`) with write access to Products, Prices and Customer portal:

```sh
read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY   # paste rk_live_..., not echoed
BRAKE_STRIPE_ALLOW_LIVE=1 pnpm --filter @spend-brake/billing seed
```

The webhook endpoint, test or live (same key rules; the live key also needs write access to
Webhook endpoints):

```sh
BRAKE_STRIPE_ALLOW_LIVE=1 pnpm --filter @spend-brake/billing webhook-setup
```

creates `$BRAKE_DASHBOARD_URL/v1/billing/webhook` (default
`https://app.spendbrake.dev/v1/billing/webhook`; Caddy hands the app domain to the dashboard's
nginx, which passes `/v1/billing/` to billing unchanged), subscribed to exactly the events
above (`HANDLED_EVENTS` in `src/webhooks.ts`) and pinned to the API version of the Stripe SDK
billing uses. It prints the signing secret once, for `STRIPE_WEBHOOK_SECRET`. Running it again
finds the endpoint (metadata `spend_brake_webhook=1`, or its URL) and only puts its URL and
events back in line; the secret is not shown again. `webhook-setup --recreate` deletes and recreates it
(a new secret), for a lost secret or an endpoint on another API version.

The billing service takes a live key only with `BILLING_LIVE_MODE=true` (and then refuses a
test key). Its key needs write access to Customers, Checkout Sessions and Customer portal, and
read access to Products and Prices.

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
