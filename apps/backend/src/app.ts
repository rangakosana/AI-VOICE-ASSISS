import fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type Database from 'better-sqlite3';
import { config } from './config/index.js';
import { appRoutes } from './routes/index.js';
import { closeDatabase, initDatabase } from './db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db?: Database.Database;
  }
}

export interface AppOptions extends FastifyServerOptions {
  // Allow passing custom options for testing or configuration overrides
  db?: Database.Database;
  skipDb?: boolean;
}

/**
 * Builds and configures the Fastify application instance.
 * Decoupled from server listening to facilitate automated testing.
 */
export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const server = fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
    },
    ...opts,
  });

  // Database initialization & cleanup hook
  if (!opts.skipDb) {
    const db = opts.db ?? initDatabase().db;
    server.decorate('db', db);
    server.addHook('onClose', async () => {
      closeDatabase(db);
    });
  }

  // Global Not Found handler
  server.setNotFoundHandler((request, reply) => {
    request.log.warn({ url: request.raw.url, method: request.raw.method }, 'Route not found');
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
        requestId: request.id,
      },
    });
  });

  // Global Error handler
  server.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

    request.log.error(
      {
        err: error,
        requestId: request.id,
        url: request.raw.url,
        method: request.raw.method,
      },
      error.message
    );

    // Sanitize 500 errors in production so internal stack or sensitive details aren't leaked
    const message = statusCode === 500 && config.isProduction
      ? 'An unexpected internal server error occurred.'
      : error.message;

    return reply.status(statusCode).send({
      error: {
        code: error.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'),
        message,
        statusCode,
        requestId: request.id,
      },
    });
  });

  // Register WebSocket plugin before registering routes
  server.register(fastifyWebsocket, {
    options: {
      maxPayload: 65536, // 64 KB limit for JSON-only protocol
    },
  });

  // Register application routes
  server.register(appRoutes);

  return server;
}
