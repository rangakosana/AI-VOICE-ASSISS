import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

describe('Health Check Endpoint', () => {
  it('GET /health returns 200 with status ok and valid metadata', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);

    const body = JSON.parse(response.body);

    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.uptime >= 0);
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    assert.equal(typeof body.environment, 'string');
    assert.equal(body.version, '0.1.0');

    await app.close();
  });

  it('GET /unmatched-route returns 404 with standard error contract', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/unmatched-route',
    });

    assert.equal(response.statusCode, 404);
    const body = JSON.parse(response.body);

    assert.ok(body.error, 'Response must contain error object');
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.statusCode, 404);
    assert.match(body.error.message, /not found/i);
    assert.ok(body.error.requestId, 'Error should include a requestId for tracing');

    await app.close();
  });
});

