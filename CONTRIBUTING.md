# Contributing

Thanks for helping. Bug reports, catalog price updates and pull requests are all welcome.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO), not a CLA. Every commit must carry a sign-off line that matches its author:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. CI rejects commits without one. To fix a branch:
`git rebase --signoff main` and force-push.

By signing off you certify the DCO 1.1: that you wrote the change or have the right to submit it
under the license of the part of the repository it touches.

## Licenses

- Everything outside `ee/` is Apache-2.0 (`LICENSE`).
- `ee/` is under `LICENSE-EE`.
- Code outside `ee/` must never import from `ee/`; CI checks this. The proxy, budget engine,
  caps, kill switch, CLI, catalog data, single-org dashboard and webhooks must work with no
  license present. `ee/` plugs in through the extension points (`ApiDeps.extensions`, the API
  hooks in `apps/api/src/common.ts`, `WorkerDeps.jobs`).

## Before you open a pull request

```sh
pnpm install
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

Tests use Testcontainers, so Docker must be running.

## Catalog prices

Every price needs its source URL and a `verifiedAt` date in the data file. Never guess: a price
you cannot verify stays `null` (the route is then unpriced and denied by default).
