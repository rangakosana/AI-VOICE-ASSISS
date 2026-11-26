import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config/index.js';

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
}

const healthSchema = {
  description: 'Service health check endpoint',
  tags: ['System'],
  response: {
    200: {
      type: 'object',
      required: ['status', 'timestamp', 'uptime', 'environment', 'version'],
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', example: '2026-11-12T08:42:00.000Z' },
        uptime: { type: 'number', example: 12.34 },
        environment: { type: 'string', example: 'development' },
        version: { type: 'string', example: '0.1.0' },
      },
    },
  },
};

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Root status endpoint for browser and cloud container probes
  fastify.get('/', async (_request, reply) => {
    return reply.status(200).send({
      name: 'ATLAS AI Voice Assistant Gateway',
      status: 'online',
      version: '0.1.0',
      environment: config.nodeEnv,
      endpoints: {
        health: '/health',
        realtime: '/v1/realtime (WebSocket)',
      },
    });
  });

  fastify.get('/health', { schema: healthSchema }, async (_request, reply) => {
    const response: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.nodeEnv,
      version: '0.1.0',
    };

    return reply.status(200).send(response);
  });
};
