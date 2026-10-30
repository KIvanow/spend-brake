# @spend-brake/worker

Background loops (several workers can run side by side):

| Loop          | Every | What                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ledger        | 0.5 s | Each org's `bk:{o:ORG}:events` stream → `usage_events` via a consumer group; insert, then ack. Replays are absorbed by the primary key; entries a dead worker left pending are claimed after 60 s. After each batch the stream is trimmed up to the oldest unacked entry, never further                                                                                         |
| sweep         | 10 s  | Commit reservations the proxy never settled at worst case; metric + alert                                                                                                                                                                                                                                                                                                       |
| partitions    | 6 h   | Create this and next month's `usage_events` partition                                                                                                                                                                                                                                                                                                                           |
| twilio-settle | 60 s  | Settle queued Twilio sends at the price Twilio reports for the message (polled 2 min after the send, then every 10 min); the difference to the committed worst case moves spend in the original windows as an `adjustment` event. Failed or canceled messages settle at 0; a price above the worst case raises `catalog_underpriced`. After 48 h unpriced, the worst case stays |
| drift         | 24 h  | Hash the pricing tables on each catalog source page; alert (and optionally open a GitHub issue) on change                                                                                                                                                                                                                                                                       |

Alerts are queued as BullMQ jobs (`alerts` queue, prefix `{brake-alerts}`) for the notifier
(Phase 5): `threshold`, `blocked` (first per scope per hour), `loop`, `catalog_underpriced`,
`upstream_key_error` (first per provider per hour), `reservations_expired`, `catalog_drift`,
`reconcile_drift`.

Billing reconciliation (Google billing export, Twilio Usage Records), audit export and the
verified catalog feed are Business / Enterprise loops in `ee/` (see `ee/README.md`); they plug in
through `WorkerDeps.jobs` and run from `ee/dist/main-worker.js`.

Prometheus metrics on `:9464/metrics`: `brake_ledger_events_total`, `brake_cost_micros_total`,
`brake_reservations_expired_total`, `brake_alerts_queued_total`, `brake_ledger_lag_events`, `brake_catalog_drift_total`, `brake_reconcile_drift_ratio`,
`brake_worker_last_loop_timestamp_seconds`.

Env: `DATABASE_URL`, `VALKEY_URL`, `METRICS_PORT`, `WORKER_ID`, `SWEEP_INTERVAL_MS`,
`LEDGER_INTERVAL_MS`, `DRIFT_INTERVAL_MS`, and optionally `GITHUB_TOKEN` + `GITHUB_REPO` for drift
issues.
