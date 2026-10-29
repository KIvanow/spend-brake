// Load with `node --import @spend-brake/shared/telemetry-register dist/main.js` so tracing
// patches http, undici, ioredis and pg before the app imports them. A no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { startTelemetry } from './telemetry.js';

await startTelemetry(process.env.OTEL_SERVICE_NAME ?? 'spend-brake');
