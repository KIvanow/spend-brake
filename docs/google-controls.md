---
title: Google's controls vs Spend Brake
nav_order: 5
description: How Google Cloud budgets, Maps Platform quotas and spend caps compare with Spend Brake.
---

# Google's controls vs Spend Brake

Budgets alert. Quotas count requests. Spend Brake stops dollars.

|                               | Google Cloud budgets      | Maps Platform quotas                       | Google spend caps                                         | Spend Brake                                                                    |
| ----------------------------- | ------------------------- | ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Stops spend                   | No, alerts only           | Yes                                        | Yes                                                       | Yes, before the request leaves                                                 |
| Unit                          | Dollars                   | Requests per API per minute/day            | Dollars                                                   | Dollars (micro-dollar exact)                                                   |
| Covers Maps Platform          | Yes                       | Yes                                        | No, per Google's docs at the time of writing; check yours | Yes                                                                            |
| Knows SKU tiers (field masks) | After billing             | No: a $0.04 request counts like a free one | After billing                                             | Yes, priced per field mask                                                     |
| Delay                         | Hours (billing data)      | Real time                                  | Billing data                                              | Real time                                                                      |
| Granularity                   | Project / billing account | Project, per API                           | Billing account                                           | Org, key, SKU, environment, agent, session; day and month                      |
| Loop / runaway detection      | No                        | No                                         | No                                                        | Yes, trips a circuit                                                           |
| Kill switch                   | No                        | Set quota to 0 by hand                     | No                                                        | One call, link or button; immediate                                            |
| Alerts with actions           | Email, Pub/Sub            | No                                         | No                                                        | Webhooks (Slack, Discord, Teams, raw) and email with Kill / Raise / Mute links |

Keep Google's own budgets and quotas on as a backstop. Spend Brake is the part that acts before
the money is spent.

## Make the proxy the only way to spend

Caps only hold if nothing reaches Google without the proxy. Restrict the real key in Google
Cloud (APIs & Services → Credentials):

- **Application restrictions:** IP addresses, set to the proxy's outbound addresses. The
  dashboard shows them after you add a Google key. On a self-hosted install, `brake init` prints
  the steps, console and `gcloud`, with the addresses you pass in `--egress-ip`.
- **API restrictions:** only the Maps APIs you use, for example Places API (New), Geocoding API
  and Routes API.

Google takes up to 5 minutes to apply the change. After that, calls from your own servers with
the real key fail: send them through Spend Brake.

## Your bill is the record

Overshoot is bounded by one request's worst case, and Google's bill remains the authoritative
record of what you spent. On a self-hosted Business or Enterprise install, connect the Google
Cloud Billing export and the worker compares the ledger with Google's bill every day, per SKU
family; drift above 5% raises an alert (see [CLI: reconcile](../cli/#admin-commands)).

## Leaving Google Maps

`brake estimate` (or **Migration** in the dashboard) prices your last 30 days of Google usage on
Geoapify, Stadia Maps, Open Places API, Mapbox and HERE side by side, and shows what would stay
on Google.
