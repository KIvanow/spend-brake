import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildServer({ logger: true });
await app.listen({ port, host });
