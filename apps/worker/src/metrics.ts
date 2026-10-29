import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Registry } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly ledgerEvents = new Counter({
    name: 'brake_ledger_events_total',
    help: 'Events written to the Postgres ledger',
    labelNames: ['type'],
    registers: [this.registry],
  });
  readonly costMicros = new Counter({
    name: 'brake_cost_micros_total',
    help: 'Committed spend seen by the ledger, in micro-dollars',
    labelNames: ['provider'],
    registers: [this.registry],
  });
  readonly reservationsExpired = new Counter({
    name: 'brake_reservations_expired_total',
    help: 'Reservations the sweeper committed at worst case (the proxy never settled them)',
    registers: [this.registry],
  });
  readonly alertsQueued = new Counter({
    name: 'brake_alerts_queued_total',
    help: 'Alert jobs queued for the notifier',
    labelNames: ['type'],
    registers: [this.registry],
  });
  readonly catalogDrift = new Counter({
    name: 'brake_catalog_drift_total',
    help: 'Catalog source pages that changed since the last check',
    registers: [this.registry],
  });
  readonly lastLoop = new Gauge({
    name: 'brake_worker_last_loop_timestamp_seconds',
    help: 'When each worker loop last finished',
    labelNames: ['loop'],
    registers: [this.registry],
  });

  serve(port: number): Server {
    return createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      void this.registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': this.registry.contentType }).end(body);
      });
    }).listen(port);
  }
}
