import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export function buildServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(opts);
  app.get('/healthz', () => ({ ok: true, service: 'api' }));
  return app;
}
