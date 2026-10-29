import type { FastifyReply, FastifyRequest } from 'fastify';

/** Outcome label per request for brake_requests_total; set by sendError or the success path. */
export const outcomes = new WeakMap<FastifyRequest, string>();

export type BrakeError =
  | 'invalid_key'
  | 'budget_exceeded'
  | 'unpriced_route'
  | 'killed'
  | 'sku_not_allowed'
  | 'loop_detected'
  | 'budget_unavailable'
  | 'unknown_route'
  | 'invalid_request'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'internal_error';

const STATUS: Record<BrakeError, number> = {
  invalid_key: 401,
  budget_exceeded: 402,
  unpriced_route: 402,
  killed: 403,
  sku_not_allowed: 403,
  loop_detected: 429,
  budget_unavailable: 503,
  unknown_route: 404,
  invalid_request: 400,
  upstream_timeout: 504,
  upstream_unavailable: 502,
  internal_error: 500,
};

/**
 * Send a proxy error. Bodies are JSON an agent can read; `message` is one line telling it what
 * to do. Error bodies never echo request data, so they cannot leak a secret.
 */
export function sendError(
  reply: FastifyReply,
  error: BrakeError,
  message: string,
  extra: Record<string, unknown> = {},
): FastifyReply {
  outcomes.set(reply.request, error);
  // A request that reached the provider may already carry its cost; everything else cost nothing.
  if (!reply.hasHeader('x-brake-cost-micros')) reply.header('x-brake-cost-micros', '0');
  return reply
    .code(STATUS[error])
    .header('content-type', 'application/json; charset=utf-8')
    .send(JSON.stringify({ error, message, ...extra }));
}
