import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.js';
import { realtimeRoutes } from './realtime.js';

/**
 * Main application routes plugin.
 * Aggregates all modular route plugins.
 */
export const appRoutes: FastifyPluginAsync = async (fastify) => {
  // Register health check route
  await fastify.register(healthRoutes);

  // Register realtime WebSocket communication route
  await fastify.register(realtimeRoutes);
};

