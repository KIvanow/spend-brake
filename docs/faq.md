---
title: FAQ
nav_order: 15
description: Short answers about overshoot, outages, latency, what is stored, and what happens at a cap.
---

# FAQ

## Can spend go over a cap?

By at most one request's worst case. Each request reserves its worst-case cost against every
cap before it is forwarded, so parallel requests cannot slip past together. The actual cost
replaces the reservation afterwards.

## What happens when a cap is reached?

The proxy answers `402 budget_exceeded` with the scope, the cap, what was spent and when the
window resets. The provider never sees the request. If you set up alerts, you get a `blocked`
alert with a Raise link. See [How it works](../how-it-works/#responses).

## What if Valkey is down?

The proxy refuses requests with `503 budget_unavailable` (fail closed), unless a key opts into a
small fail-open allowance. Fail-open spend is recorded as soon as Valkey answers again.

## What if Postgres is down?

The proxy keeps enforcing caps: its config is cached in Valkey. The API and the ledger wait for
Postgres.

## How much latency does it add?

In a local load test at 2,000 requests per second, the median added latency was under 0.5 ms.
The [proxy README](https://github.com/KIvanow/spend-brake/tree/main/apps/proxy#load-test) has the
numbers and how to run it yourself.

## Does Spend Brake cache or store responses?

No. Responses stream through and are never stored to answer later requests. Spend Brake keeps
request metadata (SKU, units, cost, status, a hash), never bodies or query strings.

## Where does my provider key live?

Encrypted in Spend Brake, bound to your org. It is decrypted only to forward a request, and it is
never returned, logged or shown again. Your apps and agents hold virtual keys you can revoke.

## Does it cover the Maps JavaScript API?

No. Client-side Maps (the Maps JavaScript API, tiles and widgets) is out of scope: Spend Brake
proxies server-side APIs.

## Should I turn off Google's budgets and quotas?

No. Keep them on as a backstop. See [Google's controls vs Spend Brake](../google-controls/).

## Can an agent raise its own cap?

Not with a session key: it can only spend. Keep admin tokens out of its reach. Run it as a
different OS user than the one that ran `brake init`. See
[Capping an AI agent](../agents/#keep-the-admin-token-away-from-the-agent).

## What happens if my plan lapses?

Downgrades and failed payments only block creating new keys, providers and sessions. Existing
keys and caps keep enforcing. On a self-hosted install, an expired license turns its features
read-only after 14 days; the proxy and caps never stop.
