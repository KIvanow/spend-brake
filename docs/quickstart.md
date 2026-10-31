---
title: Quickstart (hosted)
nav_order: 2
description: Sign up, add a provider key, create a Spend Brake key, set a cap and make the first call.
---

# Quickstart (hosted)

The hosted service runs the dashboard and admin API at `https://app.spendbrake.dev` and the
proxy at `https://proxy.spendbrake.dev`. To run your own instead, see
[Self-hosting](../self-hosting/).

## 1. Create an account

Open [app.spendbrake.dev/#/signup](https://app.spendbrake.dev/#/signup), enter your work email
and a team or project name, and pick a plan. The Free plan needs no card. We email you a
sign-in link; open it to sign in. There is no password.

The dashboard opens on **Get started**, which walks through the next four steps and ticks each
one off.

## 2. Add your provider key

Pick the provider and paste your own key. It is stored encrypted, used only to call the
provider for you, and never shown again.

| Provider             | What to paste                                        |
| -------------------- | ---------------------------------------------------- |
| Google Maps Platform | API key (`AIza…`)                                    |
| Mapbox               | Access token (`pk.…` or `sk.…`)                      |
| HERE                 | API key                                              |
| Twilio (SMS, Verify) | `AccountSid:AuthToken` (or `ApiKeySid:ApiKeySecret`) |
| Tavily               | API key (`tvly-…`)                                   |
| Exa                  | API key                                              |
| Brave Search         | Subscription token                                   |
| SerpApi              | API key                                              |

For a Google key, Spend Brake asks Google whether the key is restricted. If it is not, the page
shows the exact Google Cloud changes: restrict the key to the proxy's IP addresses and to the
Maps APIs you use. Do it. Caps only hold if the proxy is the only way to spend with that key.

## 3. Create a key for your app

Name the key (for example `web app (production)`) and tick the providers it can call. The
`sb_live_…` token is shown once: copy it now.

## 4. Set your caps

Under **Caps**, set a hard cap per day and/or per month for the org, and optionally a soft
limit that only alerts. A new Free account starts with a $50/month hard cap, the most Free
protects. The same form caps other scopes too: a single key (`key:<id>`), a SKU
(`sku:google-maps:geocoding`), an environment, an agent or an agent session.

## 5. Change two things in your app

Swap the provider's base URL for the proxy's, and put the Spend Brake key where the provider's
key went.

| Provider      | Base URL                                                                                                                                                    | Where the Spend Brake key goes                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Google Maps   | `https://proxy.spendbrake.dev/google-maps`                                                                                                                  | `key=` parameter or `X-Goog-Api-Key`                     |
| Google Places | `https://proxy.spendbrake.dev/google-places`                                                                                                                | `X-Goog-Api-Key`                                         |
| Google Routes | `https://proxy.spendbrake.dev/google-routes`                                                                                                                | `X-Goog-Api-Key`                                         |
| Mapbox        | `https://proxy.spendbrake.dev/mapbox`                                                                                                                       | `access_token` parameter                                 |
| HERE          | `https://proxy.spendbrake.dev/here-geocode` (and `here-revgeocode`, `here-discover`, `here-autosuggest`, `here-autocomplete`, `here-router`, `here-matrix`) | `apiKey` parameter or `Authorization: Bearer`            |
| Twilio        | `https://proxy.spendbrake.dev/twilio`, `/twilio-verify`                                                                                                     | `X-Brake-Key` header (leave out your Twilio credentials) |
| Tavily        | `https://proxy.spendbrake.dev/tavily`                                                                                                                       | `Authorization: Bearer`                                  |
| Exa           | `https://proxy.spendbrake.dev/exa`                                                                                                                          | `X-Api-Key`                                              |
| Brave Search  | `https://proxy.spendbrake.dev/brave`                                                                                                                        | `X-Subscription-Token`                                   |
| SerpApi       | `https://proxy.spendbrake.dev/serpapi`                                                                                                                      | `api_key` parameter                                      |

For example:

```diff
- https://maps.googleapis.com/maps/api/geocode/json?address=Sofia&key=AIza…
+ https://proxy.spendbrake.dev/google-maps/maps/api/geocode/json?address=Sofia&key=sb_live_…

- https://places.googleapis.com/v1/places:searchText     X-Goog-Api-Key: AIza…
+ https://proxy.spendbrake.dev/google-places/v1/places:searchText    X-Goog-Api-Key: sb_live_…
```

The `X-Brake-Key` header works for every provider, if you prefer it to the provider's own key
slot.

## 6. Make a call

```sh
curl -i "https://proxy.spendbrake.dev/google-maps/maps/api/geocode/json?address=Sofia&key=sb_live_…"
```

Every response carries `X-Brake-Request-Id` and `X-Brake-Cost-Micros` (1 USD = 1,000,000
micros). When something is capped, `X-Brake-Remaining-Micros` says how much headroom is left.
The Get started page ticks off the last step when the first call succeeds; **Spend** and
**Events** show it.

When a call would cross a cap, the proxy answers `402 budget_exceeded` and the provider never
sees the request. See [How it works](../how-it-works/#responses) for every status the proxy can
return.

## Next

- Get alerts before a cap is reached: [Alerts and webhooks](../alerts/).
- Run an agent inside its own budget: [Capping an AI agent](../agents/).
- Plans and limits are on the [pricing page](https://spendbrake.dev/#pricing).
