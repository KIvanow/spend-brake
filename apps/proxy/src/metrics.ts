import { createServer, type Server } from 'node:http';
import { Counter, Histogram, Registry } from 'prom-client';

const MS_BUCKETS = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50, 100, 250, 1000, 5000];

/** Design doc core metrics for the request path. Served on a separate port, not the proxy's. */
export class ProxyMetrics {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'brake_requests_total',
    help: 'Proxied requests by provider, primary SKU and outcome (ok or the error code)',
    labelNames: ['provider', 'sku', 'outcome'],
    registers: [this.registry],
  });
  readonly cost = new Counter({
    name: 'brake_cost_micros_total',
    help: 'Actual cost settled by this proxy, in micro-dollars',
    labelNames: ['provider'],
    registers: [this.registry],
  });
  readonly reserveLatency = new Histogram({
    name: 'brake_reserve_latency_ms',
    help: 'Latency of the atomic loop check + reserve call',
    buckets: MS_BUCKETS,
    registers: [this.registry],
  });
  readonly upstreamLatency = new Histogram({
    name: 'brake_upstream_latency_ms',
    help: 'Time to the provider response headers',
    labelNames: ['provider'],
    buckets: MS_BUCKETS,
    registers: [this.registry],
  });
  readonly failOpenReplayed = new Counter({
    name: 'brake_fail_open_replayed_total',
    help: 'Fail-open requests recorded in Valkey after an outage',
    registers: [this.registry],
  });

  serve(port: number, host = '0.0.0.0'): Server {
    return createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      void this.registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': this.registry.contentType }).end(body);
      });
    }).listen(port, host);
  }
}
