---
title: Home
layout: home
nav_order: 1
description: Hard dollar caps, enforced in real time, for the paid APIs your apps, test suites and AI agents call.
permalink: /
---

# Spend Brake

Hard dollar caps, enforced in real time, for every paid API your apps, test suites and AI agents
call. Spend Brake is an egress proxy: swap one base URL and one key, and every request is priced
before it leaves, checked against your caps in one atomic step, and refused with a clear `402`
once a cap would be crossed.

You keep your provider account and your own key. The real key never leaves Spend Brake; clients
only ever hold revocable virtual keys (`sb_live_…`).

```diff
- https://maps.googleapis.com/maps/api/geocode/json?address=Sofia&key=AIza…
+ https://proxy.spendbrake.dev/google-maps/maps/api/geocode/json?address=Sofia&key=sb_live_…
```

Every response carries `X-Brake-Cost-Micros`. Past a cap, the request gets this instead of a bill:

```json
HTTP/1.1 402 Payment Required
{"error":"budget_exceeded","message":"Spend cap reached for org. Stop and ask the user to raise the cap.",
 "scope":"org","window":"d:20261029","cap":5000000,"spent":4990000,"resetsAt":"2026-10-30T00:00:00.000Z"}
```

## Two ways to run it

- **Hosted:** sign up at [app.spendbrake.dev](https://app.spendbrake.dev/#/signup). The proxy is
  `https://proxy.spendbrake.dev`. See the [Quickstart](quickstart/).
- **Self-hosted:** the Apache-2.0 core runs on one Docker host. See
  [Self-hosting](self-hosting/).

## Providers

Built in: Google Maps Platform (Places, Geocoding, Routes), Twilio Messaging and Verify, Mapbox,
HERE, and the agent search APIs Tavily, Exa, Brave and SerpApi. Any other API can be added as a
[custom API](custom-apis/), priced per request or at the cost it reports.

## Where to go next

| If you want to                                | Read                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| Put a cap on your first API in a few minutes  | [Quickstart (hosted)](quickstart/)                   |
| Give a coding agent a budget it cannot exceed | [Capping an AI agent](agents/)                       |
| Know what happens to a request                | [How it works](how-it-works/)                        |
| Compare with Google's budgets and quotas      | [Google's controls vs Spend Brake](google-controls/) |
| Run it on your own server                     | [Self-hosting](self-hosting/)                        |
| Get alerts in Slack, Discord, Teams or email  | [Alerts and webhooks](alerts/)                       |
| Feed Prometheus or an OpenTelemetry collector | [Telemetry](telemetry/)                              |
| Script it                                     | [API reference](api/) and [CLI](cli/)                |
