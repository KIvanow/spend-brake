import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Auth, type Authenticator, type Role, atLeast } from './auth.js';

extendZodWithOpenApi(z);

export const errorSchema = z
  .object({ error: z.string(), message: z.string(), issues: z.array(z.unknown()).optional() })
  .openapi('Error');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

interface RouteDef<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI-style path, e.g. `/v1/keys/{id}`. */
  path: string;
  role: Role;
  summary: string;
  tag: string;
  body?: B;
  query?: Q;
  params?: P;
  response: z.ZodType;
  status?: number;
  handler: (ctx: {
    auth: Auth;
    body: z.output<B>;
    query: z.output<Q>;
    params: z.output<P>;
    req: FastifyRequest;
    reply: FastifyReply;
  }) => Promise<unknown>;
}

/**
 * One definition registers the Fastify route (auth, role check, Zod validation) and its OpenAPI
 * path, so the spec cannot drift from what the server accepts.
 */
export class Router {
  readonly registry = new OpenAPIRegistry();

  constructor(
    private readonly app: FastifyInstance,
    private readonly auth: Authenticator,
  ) {
    this.registry.registerComponent('securitySchemes', 'bearer', {
      type: 'http',
      scheme: 'bearer',
      description: 'Admin API token (sbt_...)',
    });
  }

  add<
    B extends z.ZodType = z.ZodUndefined,
    Q extends z.ZodType = z.ZodUndefined,
    P extends z.ZodType = z.ZodUndefined,
  >(def: RouteDef<B, Q, P>): void {
    const status = def.status ?? 200;
    this.registry.registerPath({
      method: def.method,
      path: def.path,
      summary: `${def.summary} (${def.role})`,
      tags: [def.tag],
      security: [{ bearer: [] }],
      request: {
        ...(def.body ? { body: { content: { 'application/json': { schema: def.body } } } } : {}),
        ...(def.query ? { query: def.query as never } : {}),
        ...(def.params ? { params: def.params as never } : {}),
      },
      responses: {
        [status]: {
          description: 'OK',
          content: { 'application/json': { schema: def.response } },
        },
        400: {
          description: 'Invalid request',
          content: { 'application/json': { schema: errorSchema } },
        },
        401: {
          description: 'Missing or invalid token',
          content: { 'application/json': { schema: errorSchema } },
        },
        403: {
          description: 'Role too low',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    });

    this.app.route({
      method: def.method.toUpperCase(),
      url: def.path.replace(/\{(\w+)\}/g, ':$1'),
      handler: async (req, reply) => {
        const auth = await this.auth.authenticate(req);
        if (!auth) throw new ApiError(401, 'unauthorized', 'Missing or invalid API token.');
        if (!atLeast(auth.role, def.role)) {
          throw new ApiError(403, 'forbidden', `This needs the ${def.role} role.`);
        }
        const parse = <T extends z.ZodType>(
          schema: T | undefined,
          value: unknown,
          where: string,
        ) => {
          if (!schema) return undefined as z.output<T>;
          const r = schema.safeParse(value ?? {});
          if (!r.success) {
            // Report where and why, never the submitted values (they may hold secrets).
            const issues = r.error.issues.map((i) => ({
              in: where,
              path: i.path.join('.'),
              message: i.message,
            }));
            throw Object.assign(
              new ApiError(400, 'invalid_request', 'Request failed validation.'),
              {
                issues,
              },
            );
          }
          return r.data;
        };
        const result = await def.handler({
          auth,
          body: parse(def.body, req.body, 'body'),
          query: parse(def.query, req.query, 'query'),
          params: parse(def.params, req.params, 'params'),
          req,
          reply,
        });
        reply.code(status);
        return result;
      },
    });
  }

  document(): object {
    return new OpenApiGeneratorV31(this.registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: {
        title: 'Spend Brake admin API',
        version: '1.0.0',
        description: 'Keys, caps, kill switch, provider credentials, spend and events.',
      },
      servers: [{ url: '/' }],
    });
  }
}
