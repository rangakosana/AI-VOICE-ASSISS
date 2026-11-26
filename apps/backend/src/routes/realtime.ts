import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { conversationEngine } from '../services/ai/conversationEngine.js';
import { sessionRegistry } from '../services/sessionRegistry.js';
import { ttsService } from '../services/tts/index.js';
import {
  type ClientMessage,
  type ServerMessage,
  validateClientMessage,
} from '../types/protocol.js';

/**
 * Realtime WebSocket Route (/v1/realtime)
 *
 * IMPORTANT SECURITY NOTE:
 * This endpoint is currently unauthenticated and intended strictly for local development
 * and testing between the local client (e.g., Android emulator/device) and MacBook host.
 * It MUST NOT be exposed publicly without an authentication layer and TLS encryption.
 */
export const realtimeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: 'GET',
    url: '/v1/realtime',
    handler: async (request, reply) => {
      // Standard HTTP requests that do not perform WebSocket upgrade are rejected
      return reply.status(426).send({
        error: {
          code: 'UPGRADE_REQUIRED',
          message: 'This endpoint requires a WebSocket connection (Upgrade: websocket).',
          statusCode: 426,
          requestId: request.id,
        },
      });
    },
    wsHandler: (socket: WebSocket, request) => {
      const connectionId = crypto.randomUUID();
      const audioTrackers = new Map<string, { chunkCount: number; byteCount: number; startedAt: number }>();
      const ttsControllers = new Map<string, AbortController>();

      const ABBREVIATIONS = new Set([
        'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'vs', 'etc',
        'eg', 'ie', 'no', 'vol', 'approx', 'dept', 'est', 'govt', 'inc', 'ltd'
      ]);

      const extractNextSentence = (
        buffer: string,
        isFinal = false
      ): { sentence: string; remaining: string } | null => {
        if (!buffer || buffer.trim().length === 0) return null;

        // 1. Paragraph / multi-line breaks: double newline or newline before list markers (\n- , \n• , \n\d+\. )
        const multiLineBreak = buffer.match(/^([\s\S]+?)(?:\r?\n\s*\r?\n|\r?\n(?=[-•*]|\d+\.\s+))([\s\S]*)$/);
        if (multiLineBreak && multiLineBreak[1] && multiLineBreak[1].trim().length >= 10) {
          return {
            sentence: multiLineBreak[1].trim(),
            remaining: (multiLineBreak[2] || '').replace(/^[\s,;:–—"'“‘”’]+/, ''),
          };
        }

        // 2. Match sentence-ending punctuation [.!?।॥] followed by optional closing quotes/parens and whitespace
        const sentenceRegex = /([^0-9\s][.!?\u0964\u0965]+["'\u201d\u2019)\]]*)\s+/g;
        let match: RegExpExecArray | null;

        while ((match = sentenceRegex.exec(buffer)) !== null) {
          const matchedGroup = match[1];
          if (!matchedGroup) continue;
          const splitIndex = match.index + matchedGroup.length;
          const candidate = buffer.slice(0, splitIndex).trim();

          // Check if candidate ends with an abbreviation
          const lastWordMatch = candidate.match(/([a-zA-Z]+)[.!?]+["'\u201d\u2019)\]]*$/);
          const lastWord = lastWordMatch?.[1]?.toLowerCase() ?? '';

          if (ABBREVIATIONS.has(lastWord)) {
            continue;
          }

          // Combine tiny 1-word fragments (e.g. "No." or 1-word Telugu) with following phrase unless final
          if (candidate.length < 12 && !candidate.includes(' ') && !isFinal) {
            continue;
          }

          const remaining = buffer.slice(match.index + match[0].length).replace(/^[\s,;:–—"'“‘”’]+/, '');
          return { sentence: candidate, remaining };
        }

        // 3. For long continuous sentences without punctuation (> 120 chars), break at natural comma/clause boundary
        if (!isFinal && buffer.length > 120) {
          const clauseMatch = buffer.match(/^([\s\S]{40,110}[,;:\-])\s+([\s\S]*)$/);
          if (clauseMatch && clauseMatch[1] && clauseMatch[2]) {
            return {
              sentence: clauseMatch[1].trim(),
              remaining: clauseMatch[2].replace(/^[\s,;:–—"'“‘”’]+/, '').trim(),
            };
          }
        }

        if (isFinal) {
          const candidate = buffer.trim();
          if (candidate.length > 0) {
            return { sentence: candidate, remaining: '' };
          }
        }

        return null;
      };

      const createSentenceTtsStreamer = (
        sessionId: string,
        responseId: string,
        requestId: string | undefined
      ) => {
        // Abort previous TTS synthesis for this session
        const prevCtrl = ttsControllers.get(sessionId);
        if (prevCtrl) {
          prevCtrl.abort();
        }

        const abortController = new AbortController();
        ttsControllers.set(sessionId, abortController);

        let textBuffer = '';
        let chunkIndex = 0;
        let ttsChain = Promise.resolve();

        const dispatchSentence = (sentence: string, isFinal = false) => {
          const trimmed = sentence.trim();
          if (!trimmed || trimmed.length < 2) return;
          const idx = chunkIndex++;

          ttsChain = ttsChain.then(async () => {
            if (abortController.signal.aborted) return;
            try {
              const res = await ttsService.synthesizeWithMetadata(trimmed, {
                signal: abortController.signal,
              });
              if (!res || abortController.signal.aborted) return;

              send({
                type: 'server.audio.chunk',
                requestId,
                sessionId,
                timestamp: new Date().toISOString(),
                payload: {
                  responseId,
                  index: idx,
                  audio: res.audio.toString('base64'),
                  mimeType: 'audio/mp3',
                  text: trimmed,
                  isFinal,
                  language: res.language,
                  voice: res.voice,
                  intent: res.intent,
                },
              });
            } catch (err: unknown) {
              request.log.warn(
                { sessionId, responseId, err: (err as Error)?.message },
                'TTS synthesis warning'
              );
            }
          });
        };

        return {
          onDelta: (delta: string) => {
            if (abortController.signal.aborted) return;
            textBuffer += delta;

            let extracted: ReturnType<typeof extractNextSentence>;
            while ((extracted = extractNextSentence(textBuffer, false)) !== null) {
              textBuffer = extracted.remaining;
              dispatchSentence(extracted.sentence, false);
            }
          },
          onComplete: (_fullText: string) => {
            if (abortController.signal.aborted) return;
            let extracted: ReturnType<typeof extractNextSentence>;
            while ((extracted = extractNextSentence(textBuffer, true)) !== null) {
              textBuffer = extracted.remaining;
              dispatchSentence(extracted.sentence, true);
            }
            ttsChain.finally(() => {
              if (ttsControllers.get(sessionId) === abortController) {
                ttsControllers.delete(sessionId);
              }
            });
          },
          onCancel: () => {
            abortController.abort();
            ttsControllers.delete(sessionId);
          },
        };
      };

      request.log.info({ connectionId }, 'Realtime WebSocket client connected');

      const send = (msg: ServerMessage): void => {
        if (socket.readyState === 1 /* WebSocket.OPEN */) {
          socket.send(JSON.stringify(msg));
        }
      };

      const sendError = (
        code: string,
        message: string,
        requestId?: string,
        sessionId?: string
      ): void => {
        send({
          type: 'server.error',
          requestId,
          sessionId,
          timestamp: new Date().toISOString(),
          payload: { code, message },
        });
      };

      // 1. Send server.ready event immediately upon connection
      send({
        type: 'server.ready',
        timestamp: new Date().toISOString(),
        payload: {
          connectionId,
          protocolVersion: '1.0.0',
          serverTime: new Date().toISOString(),
        },
      });

      // 2. Process incoming messages (JSON text frames and raw PCM audio binary frames)
      socket.on('message', (data: Buffer | string, isBinary: boolean) => {
        // Handle incoming binary audio frames (Phase C: raw PCM audio chunks)
        if (isBinary) {
          const activeSession = sessionRegistry.getActiveSessionForConnection(connectionId);
          if (!activeSession) {
            request.log.warn({ connectionId }, 'Received binary audio chunk without active session');
            sendError(
              'SESSION_NOT_FOUND',
              'Cannot stream audio without an active session. Call client.session.start first.'
            );
            return;
          }

          const audioBuffer = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as unknown as ArrayBuffer);

          let tracker = audioTrackers.get(activeSession.sessionId);
          if (!tracker) {
            tracker = { chunkCount: 0, byteCount: 0, startedAt: Date.now() };
            audioTrackers.set(activeSession.sessionId, tracker);
          }
          tracker.chunkCount++;
          tracker.byteCount += audioBuffer.byteLength;

          request.log.debug(
            {
              connectionId,
              sessionId: activeSession.sessionId,
              byteLength: audioBuffer.byteLength,
              totalChunks: tracker.chunkCount,
              totalBytes: tracker.byteCount,
            },
            'Accepted binary audio frame'
          );

          // Voice pipeline hook: audio buffer is accepted and tracked
          return;
        }

        let rawText: string;
        try {
          rawText = typeof data === 'string' ? data : data.toString('utf-8');
        } catch {
          sendError('INVALID_ENCODING', 'Payload could not be decoded as UTF-8 string.');
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          request.log.warn({ connectionId }, 'Rejected malformed JSON WebSocket payload');
          sendError('INVALID_JSON', 'Payload is not valid JSON.');
          return;
        }

        const validation = validateClientMessage(parsed);
        if (!validation.success) {
          request.log.warn(
            { connectionId, code: validation.code },
            'Rejected invalid client message structure'
          );
          sendError(
            validation.code || 'BAD_REQUEST',
            validation.errorMessage || 'Invalid message structure.',
            validation.requestId,
            validation.sessionId
          );
          return;
        }

        const message = validation.message as ClientMessage;

        // Log message metadata only; avoid logging sensitive private payload bodies
        request.log.debug(
          {
            connectionId,
            type: message.type,
            requestId: message.requestId,
            sessionId: message.sessionId,
          },
          'Processed WebSocket protocol message'
        );

        switch (message.type) {
          case 'client.ping': {
            send({
              type: 'server.pong',
              requestId: message.requestId,
              sessionId: message.sessionId,
              timestamp: new Date().toISOString(),
              payload: {},
            });
            break;
          }

          case 'client.session.start': {
            const session = sessionRegistry.createSession(connectionId, message.payload);
            send({
              type: 'server.session.started',
              requestId: message.requestId,
              sessionId: session.sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: session.sessionId,
                createdAt: session.createdAt.toISOString(),
              },
            });
            break;
          }

          case 'client.session.end': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (!targetSessionId) {
              sendError(
                'SESSION_NOT_FOUND',
                'No active session found for this connection.',
                message.requestId,
                message.sessionId
              );
              return;
            }

            conversationEngine.cleanupSession(targetSessionId);
            const ended = sessionRegistry.endSession(
              targetSessionId,
              (message.payload?.reason as string) || 'client_requested'
            );

            if (!ended) {
              sendError(
                'SESSION_NOT_FOUND',
                `Session "${targetSessionId}" is not active or does not exist.`,
                message.requestId,
                targetSessionId
              );
              return;
            }

            send({
              type: 'server.session.ended',
              requestId: message.requestId,
              sessionId: ended.sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: ended.sessionId,
                endedAt: ended.endedAt ? ended.endedAt.toISOString() : new Date().toISOString(),
                reason: (message.payload?.reason as string) || 'client_requested',
              },
            });
            break;
          }

          case 'client.cancel': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (targetSessionId) {
              const ttsCtrl = ttsControllers.get(targetSessionId);
              if (ttsCtrl) {
                ttsCtrl.abort();
                ttsControllers.delete(targetSessionId);
              }
            }

            // Target generation requestId comes from payload if explicitly provided.
            // Note: message.requestId is the envelope correlation ID for the cancel command itself.
            const targetRequestId =
              (message.payload?.targetRequestId as string) ||
              (message.payload?.requestId as string) ||
              undefined;

            const cancelledActive = targetSessionId
              ? conversationEngine.cancelGeneration(targetSessionId, targetRequestId)
              : false;

            send({
              type: 'server.cancel.acknowledged',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: {
                acknowledged: true,
                details: cancelledActive
                  ? 'Active generation cancelled.'
                  : targetRequestId
                  ? 'No matching active generation in progress.'
                  : 'No active generation in progress.',
                cancelledActiveGeneration: cancelledActive,
              },
            });
            break;
          }

          case 'client.interrupt': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (targetSessionId) {
              const ttsCtrl = ttsControllers.get(targetSessionId);
              if (ttsCtrl) {
                ttsCtrl.abort();
                ttsControllers.delete(targetSessionId);
              }
            }

            const cancelledActive = targetSessionId
              ? conversationEngine.cancelGeneration(targetSessionId)
              : false;

            if (cancelledActive && targetSessionId) {
              send({
                type: 'server.generation_cancelled',
                requestId: message.requestId,
                sessionId: targetSessionId,
                timestamp: new Date().toISOString(),
                payload: {
                  reason: (message.payload?.reason as string) || 'client_interrupted',
                },
              });
            }

            send({
              type: 'server.cancel.acknowledged',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: {
                acknowledged: true,
                details: cancelledActive
                  ? 'Active generation cancelled via voice interruption.'
                  : 'No active generation in progress to interrupt.',
                cancelledActiveGeneration: cancelledActive,
              },
            });
            break;
          }

          case 'session.update':
          case 'client.session.update': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (!targetSessionId) {
              sendError(
                'SESSION_NOT_FOUND',
                'No active session found for this connection.',
                message.requestId,
                message.sessionId
              );
              return;
            }

            const session = sessionRegistry.getSession(targetSessionId);
            if (session) {
              session.metadata = {
                ...session.metadata,
                ...message.payload,
              };
            }

            send({
              type: 'server.session.updated',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: {
                sessionId: targetSessionId,
                updatedAt: new Date().toISOString(),
                ...message.payload,
              },
            });
            break;
          }

          case 'client.message.send': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (!targetSessionId) {
              sendError(
                'SESSION_NOT_FOUND',
                'No active session found. Start a session before sending messages.',
                message.requestId,
                message.sessionId
              );
              return;
            }

            const activeSession = sessionRegistry.getSession(targetSessionId);
            if (!activeSession || activeSession.status !== 'active') {
              sendError(
                'SESSION_NOT_FOUND',
                `Session "${targetSessionId}" is no longer active.`,
                message.requestId,
                targetSessionId
              );
              return;
            }

            // Reject concurrent requests in the same session
            if (conversationEngine.hasActiveGeneration(targetSessionId)) {
              sendError(
                'CONCURRENT_REQUEST_NOT_ALLOWED',
                'An active generation is already in progress for this session. Wait for it to complete or cancel it first.',
                message.requestId,
                targetSessionId
              );
              return;
            }

            const text = (message.payload.text as string).trim();
            if (!text) {
              sendError(
                'EMPTY_MESSAGE',
                'Message content cannot be empty.',
                message.requestId,
                targetSessionId
              );
              return;
            }

            // 1. Acknowledge receipt of user message
            const messageId = crypto.randomUUID();
            send({
              type: 'server.message.accepted',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: { messageId },
            });

            // Log metadata without leaking content
            request.log.info(
              {
                connectionId,
                sessionId: targetSessionId,
                requestId: message.requestId,
                messageId,
                textLength: text.length,
              },
              'User message accepted for AI generation'
            );

            // 2. Stream generation via conversation engine
            let ttsStreamer: ReturnType<typeof createSentenceTtsStreamer> | null = null;

            conversationEngine.processUserMessage(
              targetSessionId,
              text,
              {
                onStart: (responseId) => {
                  ttsStreamer = createSentenceTtsStreamer(
                    targetSessionId,
                    responseId,
                    message.requestId
                  );

                  send({
                    type: 'server.response.started',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { responseId },
                  });
                },
                onDelta: (delta, index, responseId) => {
                  ttsStreamer?.onDelta(delta);

                  send({
                    type: 'server.response.delta',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { delta, index, responseId },
                  });
                },
                onComplete: (fullText, responseId) => {
                  ttsStreamer?.onComplete(fullText);

                  request.log.info(
                    {
                      connectionId,
                      sessionId: targetSessionId,
                      responseId,
                      textLength: fullText.length,
                    },
                    'AI generation completed successfully'
                  );

                  send({
                    type: 'server.response.completed',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { responseId, text: fullText },
                  });
                },
                onCancelled: (responseId) => {
                  ttsStreamer?.onCancel();

                  request.log.info(
                    { connectionId, sessionId: targetSessionId, responseId },
                    'AI generation cancelled during stream'
                  );

                  send({
                    type: 'server.response.cancelled',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: {
                      reason: 'client_cancellation',
                      responseId,
                    },
                  });
                },
                onError: (err) => {
                  ttsStreamer?.onCancel();

                  request.log.error(
                    { connectionId, sessionId: targetSessionId, err: err.message },
                    'AI generation encountered error'
                  );

                  sendError(
                    'AI_GENERATION_ERROR',
                    err.message,
                    message.requestId,
                    targetSessionId
                  );
                },
              },
              { requestId: message.requestId, userId: activeSession.userId }
            );
            break;
          }

          case 'client.voice.commit':
          case 'client.input_audio_buffer.commit': {
            const targetSessionId =
              message.sessionId ||
              sessionRegistry.getActiveSessionForConnection(connectionId)?.sessionId;

            if (!targetSessionId) {
              sendError(
                'SESSION_NOT_FOUND',
                'No active session found. Start a session before committing voice turns.',
                message.requestId,
                message.sessionId
              );
              return;
            }

            const activeSession = sessionRegistry.getSession(targetSessionId);
            if (!activeSession || activeSession.status !== 'active') {
              sendError(
                'SESSION_NOT_FOUND',
                `Session "${targetSessionId}" is no longer active.`,
                message.requestId,
                targetSessionId
              );
              return;
            }

            const tracker = audioTrackers.get(targetSessionId);
            const chunkCount = (message.payload?.chunkCount as number) || tracker?.chunkCount || 0;
            const byteLength = (message.payload?.byteLength as number) || tracker?.byteCount || 0;

            audioTrackers.delete(targetSessionId);

            const spokenPrompt = (message.payload?.text as string)?.trim();
            if (!spokenPrompt) {
              send({
                type: 'server.transcript',
                requestId: message.requestId,
                sessionId: targetSessionId,
                timestamp: new Date().toISOString(),
                payload: {
                  text: '',
                  isFinal: true,
                  role: 'user',
                  chunkCount,
                  byteLength,
                },
              });
              return;
            }

            // 1. Emit recognized user transcript event
            send({
              type: 'server.transcript',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: {
                text: spokenPrompt,
                isFinal: true,
                role: 'user',
                chunkCount,
                byteLength,
              },
            });

            // 2. Reject concurrent requests in the same session
            if (conversationEngine.hasActiveGeneration(targetSessionId)) {
              sendError(
                'CONCURRENT_REQUEST_NOT_ALLOWED',
                'An active generation is already in progress for this session. Wait for it to complete or cancel it first.',
                message.requestId,
                targetSessionId
              );
              return;
            }

            // 3. Acknowledge message receipt
            const messageId = crypto.randomUUID();
            send({
              type: 'server.message.accepted',
              requestId: message.requestId,
              sessionId: targetSessionId,
              timestamp: new Date().toISOString(),
              payload: { messageId },
            });

            request.log.info(
              {
                connectionId,
                sessionId: targetSessionId,
                chunkCount,
                byteLength,
                textLength: spokenPrompt.length,
              },
              'Voice turn committed and accepted for AI generation'
            );

            // 4. Stream response via conversation engine
            let voiceTtsStreamer: ReturnType<typeof createSentenceTtsStreamer> | null = null;

            conversationEngine.processUserMessage(
              targetSessionId,
              spokenPrompt,
              {
                onStart: (responseId) => {
                  voiceTtsStreamer = createSentenceTtsStreamer(
                    targetSessionId,
                    responseId,
                    message.requestId
                  );

                  send({
                    type: 'server.response.started',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { responseId },
                  });
                },
                onDelta: (delta, index, responseId) => {
                  voiceTtsStreamer?.onDelta(delta);

                  send({
                    type: 'server.response.delta',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { delta, index, responseId },
                  });
                },
                onComplete: (fullText, responseId) => {
                  voiceTtsStreamer?.onComplete(fullText);

                  send({
                    type: 'server.response.completed',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: { responseId, text: fullText },
                  });
                },
                onCancelled: (responseId) => {
                  voiceTtsStreamer?.onCancel();

                  send({
                    type: 'server.response.cancelled',
                    requestId: message.requestId,
                    sessionId: targetSessionId,
                    timestamp: new Date().toISOString(),
                    payload: {
                      reason: 'client_cancellation',
                      responseId,
                    },
                  });
                },
                onError: (err) => {
                  voiceTtsStreamer?.onCancel();
                  sendError(
                    'AI_GENERATION_ERROR',
                    err.message,
                    message.requestId,
                    targetSessionId
                  );
                },
              },
              { requestId: message.requestId, userId: activeSession.userId }
            );
            break;
          }
        }
      });

      // 3. Handle connection disconnect
      socket.on('close', (code: number, reason: Buffer) => {
        // Abort any in-flight TTS synthesis
        for (const ctrl of ttsControllers.values()) {
          ctrl.abort();
        }
        ttsControllers.clear();

        const activeSession = sessionRegistry.getActiveSessionForConnection(connectionId);
        if (activeSession) {
          conversationEngine.cleanupSession(activeSession.sessionId);
        }
        sessionRegistry.handleDisconnect(connectionId);

        request.log.info(
          { connectionId, code, reason: reason.toString() },
          'Realtime WebSocket connection closed'
        );
      });

      // 4. Handle socket errors
      socket.on('error', (err: Error) => {
        request.log.error({ connectionId, err: err.message }, 'Realtime WebSocket socket error');
      });
    },
  });
};
