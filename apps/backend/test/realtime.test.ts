import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { conversationEngine } from '../src/services/ai/conversationEngine.js';
import { sessionRegistry } from '../src/services/sessionRegistry.js';
import {
  validateClientMessage,
  isClientVoiceMessage,
  isServerVoiceMessage,
  isClientInterruptMessage,
  isSessionUpdateMessage,
  isServerTranscriptMessage,
  isServerGenerationCancelledMessage,
  isServerAudioChunkMessage,
  type ServerCancelAcknowledgedMessage,
  type ServerErrorMessage,
  type ServerMessageAcceptedMessage,
  type ServerPongMessage,
  type ServerReadyMessage,
  type ServerResponseCancelledMessage,
  type ServerResponseCompletedMessage,
  type ServerResponseDeltaMessage,
  type ServerResponseStartedMessage,
  type ServerSessionEndedMessage,
  type ServerSessionStartedMessage,
  type ServerGenerationCancelledMessage,
  type ServerSessionUpdatedMessage,
  type ServerTranscriptMessage,
  type ServerAudioChunkMessage,
} from '../src/types/protocol.js';

interface TestClient {
  ws: WebSocket;
  nextMessage: <T = Record<string, unknown>>(timeoutMs?: number) => Promise<T>;
  send: (msg: unknown) => void;
  close: () => void;
}

async function createClient(app: ReturnType<typeof buildApp>): Promise<TestClient> {
  const queue: unknown[] = [];
  let waiter: ((msg: unknown) => void) | null = null;
  let waiterTimeout: NodeJS.Timeout | null = null;

  const ws = await app.injectWS('/v1/realtime', {}, {
    onOpen: (client) => {
      client.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          parsed = data.toString();
        }

        if (waiter) {
          if (waiterTimeout) clearTimeout(waiterTimeout);
          const resolve = waiter;
          waiter = null;
          resolve(parsed);
        } else {
          queue.push(parsed);
        }
      });
    },
  });

  return {
    ws,
    nextMessage: <T>(timeoutMs = 2000): Promise<T> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift() as T);
      }
      return new Promise<T>((resolve, reject) => {
        waiterTimeout = setTimeout(() => {
          waiter = null;
          reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = (msg) => resolve(msg as T);
      });
    },
    send: (msg: unknown) => {
      const payload = typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg);
      ws.send(payload);
    },
    close: () => {
      if (waiterTimeout) clearTimeout(waiterTimeout);
      ws.terminate();
    },
  };
}

describe('Realtime WebSocket Layer (/v1/realtime)', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    sessionRegistry.clear();
    conversationEngine.clear();
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    sessionRegistry.clear();
    conversationEngine.clear();
  });

  it('rejects standard HTTP GET with 426 Upgrade Required', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/realtime',
    });

    assert.equal(res.statusCode, 426);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'UPGRADE_REQUIRED');
    assert.match(body.error.message, /requires a websocket connection/i);
  });

  it('1 & 2. Successfully establishes connection and receives server.ready', async () => {
    const client = await createClient(app);

    const ready = await client.nextMessage<ServerReadyMessage>();
    assert.equal(ready.type, 'server.ready');
    assert.ok(ready.payload.connectionId, 'Must include connectionId');
    assert.equal(ready.payload.protocolVersion, '1.0.0');
    assert.ok(!Number.isNaN(Date.parse(ready.payload.serverTime)));

    client.close();
  });

  it('3. Handles client.ping and replies with server.pong', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    const requestId = 'req-ping-123';
    client.send({
      type: 'client.ping',
      requestId,
      timestamp: new Date().toISOString(),
    });

    const pong = await client.nextMessage<ServerPongMessage>();
    assert.equal(pong.type, 'server.pong');
    assert.equal(pong.requestId, requestId);
    assert.ok(pong.timestamp);

    client.close();
  });

  it('4. Handles client.session.start and replies with server.session.started', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    const requestId = 'req-start-1';
    client.send({
      type: 'client.session.start',
      requestId,
      timestamp: new Date().toISOString(),
      payload: { clientName: 'atlas-android-test', language: 'en' },
    });

    const started = await client.nextMessage<ServerSessionStartedMessage>();
    assert.equal(started.type, 'server.session.started');
    assert.equal(started.requestId, requestId);
    assert.ok(started.sessionId, 'Session ID must be returned');
    assert.equal(started.payload.sessionId, started.sessionId);
    assert.ok(started.payload.createdAt);

    assert.equal(sessionRegistry.getActiveSessionCount(), 1);

    client.close();
  });

  it('5. Handles client.session.end and replies with server.session.ended', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send({
      type: 'client.session.start',
      requestId: 'req-start-2',
      timestamp: new Date().toISOString(),
    });
    const started = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = started.sessionId;

    client.send({
      type: 'client.session.end',
      requestId: 'req-end-2',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { reason: 'user_left' },
    });

    const ended = await client.nextMessage<ServerSessionEndedMessage>();
    assert.equal(ended.type, 'server.session.ended');
    assert.equal(ended.sessionId, sessionId);
    assert.equal(ended.payload.reason, 'user_left');
    assert.ok(ended.payload.endedAt);

    assert.equal(sessionRegistry.getActiveSessionCount(), 0);

    client.close();
  });

  it('6. Handles client.cancel and replies with server.cancel.acknowledged', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send({
      type: 'client.cancel',
      requestId: 'req-cancel-3',
      timestamp: new Date().toISOString(),
      payload: { reason: 'user_interruption' },
    });

    const ack = await client.nextMessage<ServerCancelAcknowledgedMessage>();
    assert.equal(ack.type, 'server.cancel.acknowledged');
    assert.equal(ack.requestId, 'req-cancel-3');
    assert.equal(ack.payload.acknowledged, true);

    client.close();
  });

  it('7. Rejects malformed JSON with server.error without crashing the backend', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send('{ invalid-json-payload ');

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'INVALID_JSON');
    assert.match(err.payload.message, /not valid json/i);

    // Verify backend is still healthy and responsive
    client.send({
      type: 'client.ping',
      requestId: 'req-after-error',
      timestamp: new Date().toISOString(),
    });
    const pong = await client.nextMessage<ServerPongMessage>();
    assert.equal(pong.type, 'server.pong');
    assert.equal(pong.requestId, 'req-after-error');

    client.close();
  });

  it('8. Rejects invalid message types with server.error', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send({
      type: 'client.unsupported_action',
      requestId: 'req-unknown',
      timestamp: new Date().toISOString(),
    });

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'UNKNOWN_MESSAGE_TYPE');
    assert.match(err.payload.message, /unsupported message type/i);

    client.close();
  });

  it('9. Handles client disconnection cleanly and cleans up session registry', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const started = await client.nextMessage<ServerSessionStartedMessage>();
    assert.ok(started.sessionId);
    assert.equal(sessionRegistry.getActiveSessionCount(), 1);

    client.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sessionRegistry.getActiveSessionCount(), 0);
  });

  it('10. Supports multiple independent connections concurrently', async () => {
    const clientA = await createClient(app);
    const clientB = await createClient(app);

    const readyA = await clientA.nextMessage<ServerReadyMessage>();
    const readyB = await clientB.nextMessage<ServerReadyMessage>();

    assert.notEqual(
      readyA.payload.connectionId,
      readyB.payload.connectionId,
      'Each connection must have a unique connectionId'
    );

    clientA.send({
      type: 'client.session.start',
      requestId: 'req-A',
      timestamp: new Date().toISOString(),
    });
    const startedA = await clientA.nextMessage<ServerSessionStartedMessage>();

    clientB.send({
      type: 'client.session.start',
      requestId: 'req-B',
      timestamp: new Date().toISOString(),
    });
    const startedB = await clientB.nextMessage<ServerSessionStartedMessage>();

    assert.notEqual(startedA.sessionId, startedB.sessionId, 'Each session must be distinct');
    assert.equal(sessionRegistry.getActiveSessionCount(), 2);

    clientA.close();
    clientB.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sessionRegistry.getActiveSessionCount(), 0);
  });

  // -------------------------------------------------------------------------
  // AI Conversation Engine Integration Tests
  // -------------------------------------------------------------------------

  it('11. Streams AI response chunks sequentially via client.message.send', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    // Start session
    client.send({
      type: 'client.session.start',
      requestId: 'req-session',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    // Send user message
    const requestId = 'req-msg-1';
    client.send({
      type: 'client.message.send',
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Hello Atlas' },
    });

    // 1. server.message.accepted
    const accepted = await client.nextMessage<ServerMessageAcceptedMessage>();
    assert.equal(accepted.type, 'server.message.accepted');
    assert.equal(accepted.requestId, requestId);
    assert.equal(accepted.sessionId, sessionId);
    assert.ok(accepted.payload.messageId);

    // 2. server.response.started
    const started = await client.nextMessage<ServerResponseStartedMessage>();
    assert.equal(started.type, 'server.response.started');
    assert.equal(started.requestId, requestId);
    assert.ok(started.payload.responseId);
    const responseId = started.payload.responseId;

    // 3. Receive streaming deltas
    const deltas: string[] = [];
    let completedMsg: ServerResponseCompletedMessage | null = null;

    while (!completedMsg) {
      const msg = await client.nextMessage<ServerResponseDeltaMessage | ServerResponseCompletedMessage>();
      if (msg.type === 'server.response.delta') {
        assert.equal(msg.requestId, requestId);
        assert.equal(msg.sessionId, sessionId);
        assert.equal(msg.payload.responseId, responseId);
        deltas.push(msg.payload.delta);
      } else if (msg.type === 'server.response.completed') {
        completedMsg = msg as ServerResponseCompletedMessage;
      }
    }

    assert.ok(deltas.length >= 3, 'Should have received multiple stream chunks');
    assert.equal(completedMsg.requestId, requestId);
    assert.equal(completedMsg.sessionId, sessionId);
    assert.equal(completedMsg.payload.responseId, responseId);
    assert.ok(completedMsg.payload.text.includes('Hello Atlas'));

    client.close();
  });

  it('12. Preserves conversation context across multiple turns', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // Consume server.ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    // Turn 1
    client.send({
      type: 'client.message.send',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'First user prompt' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started
    let turn1Done = false;
    while (!turn1Done) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') turn1Done = true;
    }

    // Turn 2
    client.send({
      type: 'client.message.send',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Second user prompt' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started
    let turn2Completed: ServerResponseCompletedMessage | null = null;
    while (!turn2Completed) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        turn2Completed = msg as ServerResponseCompletedMessage;
      }
    }

    // In Mock Provider, Turn count reflects accumulated message history (User1, Asst1, User2 = 3)
    assert.ok(turn2Completed.payload.text.includes('Turn 3'));
    assert.ok(turn2Completed.payload.text.includes('Second user prompt'));

    client.close();
  });

  it('13. Strictly isolates conversation context between different sessions', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    // Session A
    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const sA = await client.nextMessage<ServerSessionStartedMessage>();

    client.send({
      type: 'client.message.send',
      sessionId: sA.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Secret of Session A' },
    });

    let doneA = false;
    while (!doneA) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') doneA = true;
    }

    // Session B
    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const sB = await client.nextMessage<ServerSessionStartedMessage>();

    client.send({
      type: 'client.message.send',
      sessionId: sB.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Hello from Session B' },
    });

    let completedB: ServerResponseCompletedMessage | null = null;
    while (!completedB) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        completedB = msg as ServerResponseCompletedMessage;
      }
    }

    // Turn count in Session B must be 1 (completely clean context)
    assert.ok(completedB.payload.text.includes('Turn 1'));
    assert.ok(!completedB.payload.text.includes('Secret of Session A'));

    client.close();
  });

  it('14. Cancels active generation when client.cancel is received during streaming', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    client.send({
      type: 'client.message.send',
      requestId: 'req-to-cancel',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Generate long response' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started

    // Wait for the first delta, then send cancel immediately
    const firstDelta = await client.nextMessage<ServerResponseDeltaMessage>();
    assert.equal(firstDelta.type, 'server.response.delta');

    client.send({
      type: 'client.cancel',
      requestId: 'req-cancel-active',
      sessionId,
      timestamp: new Date().toISOString(),
    });

    // We should receive both server.cancel.acknowledged and server.response.cancelled
    let gotCancelAck = false;
    let gotResponseCancelled = false;

    for (let i = 0; i < 3; i++) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.cancel.acknowledged') {
        const ack = msg as ServerCancelAcknowledgedMessage;
        assert.equal(ack.payload.cancelledActiveGeneration, true);
        gotCancelAck = true;
      } else if (msg.type === 'server.response.cancelled') {
        const cancelled = msg as ServerResponseCancelledMessage;
        assert.equal(cancelled.sessionId, sessionId);
        assert.equal(cancelled.payload.reason, 'client_cancellation');
        gotResponseCancelled = true;
      }
      if (gotCancelAck && gotResponseCancelled) break;
    }

    assert.ok(gotCancelAck, 'Must receive server.cancel.acknowledged');
    assert.ok(gotResponseCancelled, 'Must receive server.response.cancelled');

    client.close();
  });

  it('15. Rejects empty messages with server.error (EMPTY_MESSAGE)', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();

    client.send({
      type: 'client.message.send',
      requestId: 'req-empty',
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: '   ' },
    });

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'EMPTY_MESSAGE');

    client.close();
  });

  it('16. Rejects message send without active session (SESSION_NOT_FOUND)', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.message.send',
      requestId: 'req-no-session',
      timestamp: new Date().toISOString(),
      payload: { text: 'Hello without session' },
    });

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'SESSION_NOT_FOUND');

    client.close();
  });

  it('17. Handles simulated provider error gracefully without crashing', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();

    client.send({
      type: 'client.message.send',
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Please fail: [simulate_error]' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'AI_GENERATION_ERROR');

    // Confirm socket remains functional
    client.send({
      type: 'client.ping',
      requestId: 'ping-after-ai-error',
      timestamp: new Date().toISOString(),
    });
    const pong = await client.nextMessage<ServerPongMessage>();
    assert.equal(pong.type, 'server.pong');

    client.close();
  });

  it('18. Rejects concurrent message requests in the same session with CONCURRENT_REQUEST_NOT_ALLOWED', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    // Send first message
    client.send({
      type: 'client.message.send',
      requestId: 'req-first',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'First generation message' },
    });

    // Immediately send second message before first finishes
    client.send({
      type: 'client.message.send',
      requestId: 'req-second',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Second rapid message' },
    });

    // First message must be accepted and started
    const acceptedFirst = await client.nextMessage<ServerMessageAcceptedMessage>();
    assert.equal(acceptedFirst.type, 'server.message.accepted');
    assert.equal(acceptedFirst.requestId, 'req-first');

    const startedFirst = await client.nextMessage<ServerResponseStartedMessage>();
    assert.equal(startedFirst.type, 'server.response.started');
    assert.equal(startedFirst.requestId, 'req-first');

    // Second message must be rejected with CONCURRENT_REQUEST_NOT_ALLOWED
    const errSecond = await client.nextMessage<ServerErrorMessage>();
    assert.equal(errSecond.type, 'server.error');
    assert.equal(errSecond.payload.code, 'CONCURRENT_REQUEST_NOT_ALLOWED');
    assert.equal(errSecond.requestId, 'req-second');

    // First message continues to stream and complete cleanly
    let completedFirst: ServerResponseCompletedMessage | null = null;
    while (!completedFirst) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        completedFirst = msg as ServerResponseCompletedMessage;
      }
    }

    assert.equal(completedFirst.requestId, 'req-first');
    assert.ok(completedFirst.payload.text.includes('First generation message'));

    client.close();
  });

  it('19. Disconnecting WebSocket client during generation aborts active generation and cleans up resources', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    client.send({
      type: 'client.message.send',
      requestId: 'req-disconnect',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Start streaming then disconnect' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started
    await client.nextMessage(); // first delta

    assert.equal(conversationEngine.hasActiveGeneration(sessionId), true);

    // Abruptly close client during active streaming
    client.close();

    // Allow event loop to process close event
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(
      conversationEngine.hasActiveGeneration(sessionId),
      false,
      'Active generation must be aborted upon socket disconnection'
    );
    assert.equal(sessionRegistry.getActiveSessionCount(), 0, 'Session must be cleaned up');
  });

  it('20. Subsequent turn executes cleanly after cancellation without orphaned user turn', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    // Start message 1 and cancel it during streaming
    client.send({
      type: 'client.message.send',
      requestId: 'req-turn-cancel',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Cancelled first attempt' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started
    await client.nextMessage(); // delta

    client.send({
      type: 'client.cancel',
      sessionId,
      timestamp: new Date().toISOString(),
    });

    // Drain until response.cancelled is received
    let cancelled = false;
    while (!cancelled) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.cancelled') cancelled = true;
    }

    // Now send Turn 2
    client.send({
      type: 'client.message.send',
      requestId: 'req-turn-next',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Fresh clean question' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started

    let completedNext: ServerResponseCompletedMessage | null = null;
    while (!completedNext) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        completedNext = msg as ServerResponseCompletedMessage;
      }
    }

    // Since cancelled message was rolled back, Turn count must be 1, not 2 or 3
    assert.ok(completedNext.payload.text.includes('Turn 1'));
    assert.ok(completedNext.payload.text.includes('Fresh clean question'));
    assert.ok(!completedNext.payload.text.includes('Cancelled first attempt'));

    client.close();
  });

  it('21. Targeted cancellation with non-matching requestId does not abort active generation', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    client.send({
      type: 'client.message.send',
      requestId: 'req-active-target',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Will not be cancelled by wrong ID' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started

    // Send cancel for a DIFFERENT requestId
    client.send({
      type: 'client.cancel',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { requestId: 'req-different-id' },
    });

    const cancelAck = await client.nextMessage<ServerCancelAcknowledgedMessage>();
    assert.equal(cancelAck.type, 'server.cancel.acknowledged');
    assert.equal(cancelAck.payload.cancelledActiveGeneration, false);

    // Active generation must continue and complete
    let completedMsg: ServerResponseCompletedMessage | null = null;
    while (!completedMsg) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        completedMsg = msg as ServerResponseCompletedMessage;
      }
    }

    assert.equal(completedMsg.requestId, 'req-active-target');
    assert.ok(completedMsg.payload.text.includes('Will not be cancelled by wrong ID'));

    client.close();
  });

  it('22. Ending session while response is active cancels generation and cleans up resources', async () => {
    const client = await createClient(app);
    await client.nextMessage(); // ready

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    client.send({
      type: 'client.message.send',
      requestId: 'req-active-end',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Will be cut short by session end' },
    });

    await client.nextMessage(); // accepted
    await client.nextMessage(); // started
    await client.nextMessage(); // first delta

    assert.equal(conversationEngine.hasActiveGeneration(sessionId), true);

    // End session immediately
    client.send({
      type: 'client.session.end',
      sessionId,
      timestamp: new Date().toISOString(),
    });

    // We should receive session.ended
    let sessionEnded = false;
    while (!sessionEnded) {
      const msg = await client.nextMessage<{ type: string }>();
      if (msg.type === 'server.session.ended') sessionEnded = true;
    }

    assert.ok(sessionEnded);
    assert.equal(conversationEngine.hasActiveGeneration(sessionId), false);
    assert.equal(sessionRegistry.getActiveSessionCount(), 0);

    client.close();
  });

  it('23. Multiple sessions generate concurrently without cross-cancellation', async () => {
    const clientA = await createClient(app);
    const clientB = await createClient(app);

    await clientA.nextMessage(); // ready A
    await clientB.nextMessage(); // ready B

    clientA.send({ type: 'client.session.start', timestamp: new Date().toISOString() });
    clientB.send({ type: 'client.session.start', timestamp: new Date().toISOString() });

    const sessionA = await clientA.nextMessage<ServerSessionStartedMessage>();
    const sessionB = await clientB.nextMessage<ServerSessionStartedMessage>();

    // Start generation on both clients simultaneously
    clientA.send({
      type: 'client.message.send',
      sessionId: sessionA.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Prompt on client A' },
    });

    clientB.send({
      type: 'client.message.send',
      sessionId: sessionB.sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Prompt on client B' },
    });

    await clientA.nextMessage(); // accepted A
    await clientA.nextMessage(); // started A
    await clientB.nextMessage(); // accepted B
    await clientB.nextMessage(); // started B

    // Cancel Session A only
    clientA.send({
      type: 'client.cancel',
      sessionId: sessionA.sessionId,
      timestamp: new Date().toISOString(),
    });

    // Session A receives cancelled
    let cancelledA = false;
    while (!cancelledA) {
      const msg = await clientA.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.cancelled') cancelledA = true;
    }
    assert.ok(cancelledA, 'Session A must be cancelled');

    // Session B must NOT be cancelled and must complete successfully
    let completedB: ServerResponseCompletedMessage | null = null;
    while (!completedB) {
      const msg = await clientB.nextMessage<{ type: string }>();
      if (msg.type === 'server.response.completed') {
        completedB = msg as ServerResponseCompletedMessage;
      }
    }

    assert.ok(completedB);
    assert.ok(completedB.payload.text.includes('Prompt on client B'));

    clientA.close();
    clientB.close();
  });

  it('24. Handles client.interrupt during streaming generation and emits server.generation_cancelled', async () => {
    const client = await createClient(app);
    await client.nextMessage<ServerReadyMessage>();

    // Start session
    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const sessionStarted = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = sessionStarted.payload.sessionId;

    // Send user message that triggers streaming
    client.send({
      type: 'client.message.send',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { text: 'Long streaming message to interrupt' },
    });

    const accepted = await client.nextMessage<ServerMessageAcceptedMessage>();
    assert.equal(accepted.type, 'server.message.accepted');

    const started = await client.nextMessage<ServerResponseStartedMessage>();
    assert.equal(started.type, 'server.response.started');

    // Send client.interrupt mid-generation
    client.send({
      type: 'client.interrupt',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { reason: 'user_barged_in' },
    });

    // Verify server.generation_cancelled is received
    let receivedCancelledEvent = false;
    let receivedCancelAck = false;

    for (let i = 0; i < 5; i++) {
      const msg = await client.nextMessage<{ type: string; payload?: Record<string, unknown> }>();
      if (msg.type === 'server.generation_cancelled') {
        receivedCancelledEvent = true;
        assert.equal(msg.payload?.reason, 'user_barged_in');
      }
      if (msg.type === 'server.cancel.acknowledged') {
        receivedCancelAck = true;
      }
      if (receivedCancelledEvent && receivedCancelAck) break;
    }

    assert.ok(receivedCancelledEvent, 'Must emit server.generation_cancelled');
    assert.ok(receivedCancelAck, 'Must emit server.cancel.acknowledged');
    assert.equal(conversationEngine.hasActiveGeneration(sessionId), false);

    client.close();
  });

  it('25. Handles session.update to update audio metadata and emits server.session.updated', async () => {
    const client = await createClient(app);
    await client.nextMessage<ServerReadyMessage>();

    // Start session
    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const sessionStarted = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = sessionStarted.payload.sessionId;

    // Send session.update
    client.send({
      type: 'session.update',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        audioFormat: 'pcm16',
        sampleRate: 16000,
        channels: 1,
        language: 'te-IN',
      },
    });

    const updated = await client.nextMessage<ServerSessionUpdatedMessage>();
    assert.equal(updated.type, 'server.session.updated');
    assert.equal(updated.payload.sessionId, sessionId);
    assert.equal((updated.payload as any).audioFormat, 'pcm16');
    assert.equal((updated.payload as any).sampleRate, 16000);
    assert.equal((updated.payload as any).language, 'te-IN');

    // Verify sessionRegistry has updated metadata
    const session = sessionRegistry.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.metadata?.audioFormat, 'pcm16');
    assert.equal(session.metadata?.sampleRate, 16000);
    assert.equal(session.metadata?.language, 'te-IN');

    client.close();
  });

  it('26. Accepts binary audio frames during active session and rejects when no session is active', async () => {
    const client = await createClient(app);
    await client.nextMessage<ServerReadyMessage>();

    // 1. Send binary frame WITHOUT session -> Rejected with SESSION_NOT_FOUND
    const testPcmChunk = Buffer.from(new Int16Array([0, 100, -100, 200, -200]).buffer);
    client.send(testPcmChunk);

    const err = await client.nextMessage<ServerErrorMessage>();
    assert.equal(err.type, 'server.error');
    assert.equal(err.payload.code, 'SESSION_NOT_FOUND');

    // 2. Start session
    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    await client.nextMessage<ServerSessionStartedMessage>();

    // 3. Send binary frame WITH active session -> Accepted cleanly (no error received)
    client.send(testPcmChunk);

    // Send ping to verify connection is healthy and responsive
    client.send({
      type: 'client.ping',
      timestamp: new Date().toISOString(),
    });

    const pong = await client.nextMessage<ServerPongMessage>();
    assert.equal(pong.type, 'server.pong');

    client.close();
  });

  it('27. Protocol validators and type guards correctly classify voice and audio control messages', () => {
    // 1. validateClientMessage
    const validInterrupt = validateClientMessage({
      type: 'client.interrupt',
      sessionId: 'sess-voice-1',
      payload: { reason: 'user_barge_in' },
    });
    assert.equal(validInterrupt.success, true);
    assert.ok(validInterrupt.message);
    assert.equal(isClientVoiceMessage(validInterrupt.message), true);
    assert.equal(isClientInterruptMessage(validInterrupt.message), true);

    const validSessionUpdate = validateClientMessage({
      type: 'session.update',
      sessionId: 'sess-voice-2',
      payload: { audioFormat: 'pcm16', sampleRate: 24000 },
    });
    assert.equal(validSessionUpdate.success, true);
    assert.ok(validSessionUpdate.message);
    assert.equal(isClientVoiceMessage(validSessionUpdate.message), true);
    assert.equal(isSessionUpdateMessage(validSessionUpdate.message), true);

    // 2. Server voice type guards
    const transcriptMsg = {
      type: 'server.transcript' as const,
      timestamp: new Date().toISOString(),
      payload: { text: 'Hello from user speech', isFinal: true },
    };
    assert.equal(isServerVoiceMessage(transcriptMsg), true);
    assert.equal(isServerTranscriptMessage(transcriptMsg), true);

    const genCancelledMsg: ServerGenerationCancelledMessage = {
      type: 'server.generation_cancelled',
      timestamp: new Date().toISOString(),
      payload: { reason: 'client_interrupted' },
    };
    assert.equal(isServerVoiceMessage(genCancelledMsg), true);
    assert.equal(isServerGenerationCancelledMessage(genCancelledMsg), true);

    const audioChunkMsg: ServerAudioChunkMessage = {
      type: 'server.audio.chunk',
      timestamp: new Date().toISOString(),
      payload: {
        responseId: 'resp_tts_1',
        index: 0,
        audio: 'AQIDBA==',
        mimeType: 'audio/mp3',
        text: 'Greetings.',
        isFinal: false,
      },
    };
    assert.equal(isServerVoiceMessage(audioChunkMsg), true);
    assert.equal(isServerAudioChunkMessage(audioChunkMsg), true);
  });

  it('28. Handles client.voice.commit after streaming binary audio frames and triggers AI generation', async () => {
    const client = await createClient(app);
    await client.nextMessage<ServerReadyMessage>();

    client.send({
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
    });
    const session = await client.nextMessage<ServerSessionStartedMessage>();
    const sessionId = session.sessionId;

    // Stream binary PCM chunks
    const chunk = Buffer.alloc(3200);
    client.send(chunk);
    client.send(chunk);

    // Commit voice turn with recognized speech text
    client.send({
      type: 'client.voice.commit',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        text: 'What is SQLite WAL mode?',
        chunkCount: 2,
        byteLength: 6400,
      },
    });

    // 1. Receives server.transcript confirming user speech
    const transcript = await client.nextMessage<ServerTranscriptMessage>();
    assert.equal(transcript.type, 'server.transcript');
    assert.equal(transcript.payload.text, 'What is SQLite WAL mode?');
    assert.equal(transcript.payload.isFinal, true);

    // 2. Receives message accepted
    const accepted = await client.nextMessage<{ type: string }>();
    assert.equal(accepted.type, 'server.message.accepted');

    // 3. Receives response started
    const started = await client.nextMessage<{ type: string }>();
    assert.equal(started.type, 'server.response.started');

    // 4. Receives streaming deltas
    const delta = await client.nextMessage<{ type: string }>();
    assert.equal(delta.type, 'server.response.delta');

    client.close();
  });
});
