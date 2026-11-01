# Switching hosted billing to Stripe live mode

Operator runbook for the hosted service (app.spendbrake.dev). Not part of the public docs. Do
the steps in order. Nothing here needs a price ID or any other value from the seed in `.env`.

Where a live key appears, it is typed into your own shell with `read -rs` (not echoed, not in
shell history) and never pasted into a file, chat or ticket.

## 0. Before you start

- The droplet runs a release that includes the live-mode changes (`webhook-setup`, automatic
  tax, `BILLING_AUTOMATIC_TAX`). Deploy it the usual way first.
- A local checkout of the repo at the same commit, with Node and pnpm.
- Your accountant has confirmed which VAT registrations to add to Stripe Tax (step 1.3) and
  how invoices must be numbered (step 1.6).

## 1. Stripe dashboard (live mode)

Turn off **Test mode** in the dashboard header for all of this.

1. **Activate the account**: Settings → Business → Account details, finish activation as an
   individual registered in Bulgaria: legal name, address, date of birth, ID check, bank
   account for payouts, and the VAT number.
2. **Public business information**: Settings → Business → Public details:
   - Public business name: `Spend Brake`
   - Support email: `support@spendbrake.dev`
   - Support website / URL: `https://spendbrake.dev`
   - Privacy policy: `https://spendbrake.dev/privacy`, Terms of service:
     `https://spendbrake.dev/terms`
   - Statement descriptor: `SPENDBRAKE` (what shows on the card statement)
3. **Stripe Tax**: Settings → Tax:
   - Origin address: your registered business address in Bulgaria.
   - Default tax behavior: **Exclusive** (prices exclude tax; the seed also sets it on every
     price).
   - Preset product tax code: **Software as a service (SaaS) - business use**.
   - Registrations: add every registration your accountant gives you (at least Bulgaria; the
     EU One Stop Shop if you sell to consumers in other EU countries; any others). Stripe Tax
     only charges tax where a registration is active. A business buyer with a valid VAT ID in
     another EU country gets reverse charge.
4. **Revenue recovery**: Settings → Billing → Revenue recovery:
   - Retries: turn on **Smart Retries** (the default, e.g. up to 8 tries within 2 weeks).
   - Emails: turn on emails to customers when a card payment fails, and about expiring cards,
     with the link to update the card (the customer portal).
   - **If all retries for a payment fail**: choose **Cancel the subscription**. Billing receives
     `customer.subscription.deleted` and moves the org to Free. While retrying, the org is
     `past_due`: existing keys and caps keep working, and new keys, providers and sessions are
     blocked until it is paid.
5. **Customer emails**: Settings → Business → Customer emails: turn on **Successful payments**
   and **Refunds**. These emails are the receipts. Leave the sender as Stripe unless you have set
   up a custom email domain.
6. **Invoices**: Settings → Billing → Invoices:
   - Invoice numbering: set a prefix (e.g. `SPENDBRAKE`), numbered sequentially across the
     account. Bulgarian VAT invoices are usually expected to carry a 10-digit sequential number:
     confirm with your accountant whether Stripe's invoices and numbering are acceptable, or
     whether you issue the VAT invoices from your accounting software (keep the Stripe invoices
     as receipts then).
   - Your VAT number shows on invoices (Settings → Tax, or Account details).
   - Turn on emailing finalized invoices and links to the customer portal.
7. **Customer portal**: leave the dashboard's default configuration as it is. The seed creates
   the configuration billing uses (step 2), and billing names it on every portal session.
8. **API keys**: Developers → API keys → **Create restricted key**, twice:
   - `spend-brake-setup` (used once, then deleted): **Write** on Products, Prices, Customer
     portal, Webhook Endpoints.
   - `spend-brake-billing` (the service): **Write** on Customers, Checkout Sessions, Customer
     portal; **Read** on Products and Prices. If a test checkout later fails with a permission
     error that names another resource (e.g. Tax), add read access to just that resource.

   Copy each key straight into the prompt in step 2 or step 3. Don't save it anywhere else.

## 2. Seed products, prices and portal, and create the webhook endpoint (on your machine)

From the repo checkout:

```sh
git pull
pnpm install --frozen-lockfile

read -rs STRIPE_SECRET_KEY        # paste the rk_live_ key of spend-brake-setup, then Enter
export STRIPE_SECRET_KEY
export BRAKE_STRIPE_ALLOW_LIVE=1
export BRAKE_DASHBOARD_URL=https://app.spendbrake.dev

pnpm --filter @spend-brake/billing seed
pnpm --filter @spend-brake/billing webhook-setup

unset STRIPE_SECRET_KEY BRAKE_STRIPE_ALLOW_LIVE
```

What `seed` prints, and what to check:

- `Stripe LIVE mode`, then the 5 products (indie, team, agents, business, enterprise), the 4
  prices (`spend_brake_<plan>_monthly`: $9, $49, $149, $299 a month, VAT exclusive) and the
  portal configuration (`bpc_...`).
- The portal lets customers switch between Indie, Team and Agents, cancel at period end,
  update card, name, email, address and tax ID, and see invoices. It links the privacy policy
  and terms and returns to `https://app.spendbrake.dev/#/billing`.
- Nothing to copy into `.env`. Running it again is safe and creates nothing.

What `webhook-setup` prints:

- The endpoint `https://app.spendbrake.dev/v1/billing/webhook`, API version
  `2026-07-29.dahlia`, and the 6 events (`checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`).
- The **signing secret `whsec_...`, shown once**. Keep the terminal open until it is in the
  droplet's `.env` (step 3). If you lose it: run `webhook-setup --recreate` (with the key
  exported as above) for a new endpoint and secret, or roll the secret in the dashboard
  (Developers → Webhooks → the endpoint → Roll secret).

Then delete the `spend-brake-setup` key (Developers → API keys → ⋯ → Delete) and close the
terminal.

## 3. Configure the droplet

```sh
ssh <you>@<droplet>
cd /opt/spend-brake
cp -p infra/.env infra/.env.test-mode     # for rollback; it holds test secrets: keep it 600
chmod 600 infra/.env infra/.env.test-mode
nano infra/.env
```

Set (replacing the test values):

```sh
STRIPE_SECRET_KEY=rk_live_...       # the spend-brake-billing key
STRIPE_WEBHOOK_SECRET=whsec_...     # printed by webhook-setup
BILLING_LIVE_MODE=true
BILLING_AUTOMATIC_TAX=              # empty = true in live mode (Stripe Tax on Checkout)
BRAKE_DASHBOARD_URL=https://app.spendbrake.dev
```

No price IDs: billing finds prices by lookup key and the portal configuration by its metadata.

Restart billing:

```sh
docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.tls.yml -f infra/docker-compose.hosted.yml up -d --no-build --wait billing
```

Billing refuses to start if the key and `BILLING_LIVE_MODE` don't match (a test key with
`true`, or a live key with `false`); `--wait` then fails and the logs say which.

## 4. Smoke checks

```sh
DC="docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.tls.yml -f infra/docker-compose.hosted.yml"

$DC ps billing                                     # Up ... (healthy)
$DC exec billing printenv BILLING_LIVE_MODE        # true
$DC logs --since 10m billing | grep -iE '"level":(40|50)|error' || echo 'no warnings'

curl -fsS https://app.spendbrake.dev/v1/billing/plans | head -c 300; echo
# The webhook route reaches billing and checks signatures: expect 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.spendbrake.dev/v1/billing/webhook \
  -H 'content-type: application/json' -d '{}'
```

The only expected warning is `no license signing key` if `BRAKE_LICENSE_SIGNING_KEY_FILE` is
not set (then Business purchases issue no license).

## 5. Real-card test

Use your own card and a fresh org: sign up at `https://app.spendbrake.dev/#/signup` with your
email on the Free plan, and sign in from the emailed link. The sign-up page says "Prices exclude
VAT where applicable." Then find the org id (the sign-up name, slugged, plus a random suffix):
`q "select id, name from orgs where name = '<the name you entered>'"` (with `q` from below).

Useful on the droplet (with `DC` from step 4):

```sh
ORG=<org id>
q() { $DC exec -T postgres psql -U brake -d brake -c "$1"; }
q "select plan, status, stripe_customer_id, stripe_subscription_id, current_period_end from org_entitlements where org_id = '$ORG'"
q "select type, id, processed_at from stripe_events order by processed_at desc limit 10"
q "select at, actor, action, target, data from audit_log where org_id = '$ORG' and action like 'billing.%' order by at desc"
```

How to check webhooks were delivered: Stripe dashboard → Developers → Webhooks →
`https://app.spendbrake.dev/v1/billing/webhook` → **Event deliveries**. Each event should show
`200` with the response `{"received":true,"outcome":"applied"}`. `"duplicate"` is a retry of an
event already applied, and is fine. A `400 bad_signature` means `STRIPE_WEBHOOK_SECRET` is wrong.
A `5xx` or timeout: check `$DC logs billing`, fix it, then **Resend** the event from its page.
The events also appear in the `stripe_events` query.

### 5.1 Buy Indie

Dashboard → Billing → tick the terms → **Buy Indie**. On the Stripe page: a billing address is
required, there is a VAT ID field, and the total is $9.00 plus VAT for your address (with a
Bulgarian address and no VAT ID, 20%: $10.80). Pay.

- Dashboard Billing: **Indie**, "renews <date a month out>", limits 2 providers, 100 agent
  sessions, 100,000 requests.
- `org_entitlements`: `indie`, `active`, `cus_...`, `sub_...`.
- Audit: `billing.terms_accepted`, target `plan:indie`, with `termsVersion` and
  `withdrawalWaiver: true` (also in Events → audit log CSV).
- Stripe: a $10.80 payment. The customer has your address (and VAT ID if given). The
  subscription is active with automatic tax on. The invoice is paid with a VAT line, and the
  receipt email arrives.
- Webhook deliveries (all 200): `checkout.session.completed`, `customer.subscription.created`,
  `invoice.paid`, and possibly `customer.subscription.updated`.

### 5.2 Upgrade to Team in the portal

Billing → **Manage billing** → Update subscription → **Team** → confirm.

- Dashboard: **Team**, 5 providers, 500 sessions, 1,000,000 requests, 30 days.
- `org_entitlements`: `team`, same `sub_...`.
- Stripe: the subscription item is now the Team price. A proration for the rest of the period
  is added to the next invoice (no charge right now). The portal's upcoming invoice shows it with
  VAT.
- Webhook: `customer.subscription.updated` (200).

### 5.3 Downgrade to Indie

Manage billing → Update subscription → **Indie** → confirm.

- Dashboard: **Indie** again. Existing keys and caps keep working even where they exceed the
  Indie limits; only creating new ones is limited.
- Stripe: a proration credit on the next invoice.
- Webhook: `customer.subscription.updated` (200).

### 5.4 Cancel

Manage billing → **Cancel subscription** → confirm.

- The portal shows the plan cancels at the end of the period. The dashboard still shows **Indie**
  until then (the plan was paid for).
- Webhook: `customer.subscription.updated` (`cancel_at_period_end: true`) (200).
- To see the drop to Free now instead of at period end: Stripe dashboard → Subscriptions → the
  subscription → **Cancel subscription** → **Immediately**. Then `customer.subscription.deleted`
  (200) arrives, the dashboard shows **Free** (1 key, $50/month of protected spend), and
  `org_entitlements` shows `free` with no subscription. The same happens when the final payment
  retry fails (step 1.4).

### 5.5 Refund

Stripe dashboard → Payments → the $10.80 payment → **Refund** → full amount.

- Stripe: the payment shows Refunded, and the refund email reaches you if Refunds emails are on.
  The money returns to the card in 5-10 days.
- Spend Brake: nothing changes. Refunds are not a webhook billing listens to
  (`charge.refunded` is not subscribed, so no delivery appears for it). The plan follows the
  subscription only: cancel it (5.4) when refunding a customer who should lose the plan.

## 6. Rollback (back to test mode)

On the droplet:

```sh
cd /opt/spend-brake
cp -p infra/.env infra/.env.live                  # keep the live values (600)
cp -p infra/.env.test-mode infra/.env             # test key, test whsec_, BILLING_LIVE_MODE=false
grep -E '^(BILLING_LIVE_MODE|BILLING_AUTOMATIC_TAX)=' infra/.env   # false, and empty or false
docker compose --env-file infra/.env -f infra/docker-compose.yml -f infra/docker-compose.tls.yml -f infra/docker-compose.hosted.yml up -d --no-build --wait billing
```

In the Stripe dashboard (live mode): Developers → Webhooks → the endpoint → **Disable**.
Otherwise Stripe keeps retrying live events that billing now rejects (wrong secret), and emails
you about failures.

Be aware:

- Live subscriptions keep billing in Stripe while billing listens to test mode, and their plan
  changes no longer reach Spend Brake. Cancel them in the live dashboard (and refund if needed)
  before rolling back, or don't roll back while customers pay.
- Orgs that bought in live mode keep a live `stripe_customer_id`, which test mode doesn't know.
  Their Manage billing fails until you switch back to live.

To go live again: restore `infra/.env.live`, restart billing as in step 3, and enable the
webhook endpoint again.
