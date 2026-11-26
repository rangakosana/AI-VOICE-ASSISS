/**
 * ATLAS Realtime Protocol - Structured JSON Messages
 *
 * Defines the bidirectional WebSocket message protocol contracts between
 * clients (Android, Desktop) and the ATLAS backend server.
 */

export interface BaseMessage {
  type: string;
  requestId?: string;
  sessionId?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client Messages (Client -> Server)
// ---------------------------------------------------------------------------

export type ClientMessageType =
  | 'client.ping'
  | 'client.session.start'
  | 'client.session.end'
  | 'client.cancel'
  | 'client.message.send'
  | ClientVoiceMessageType;

export interface ClientPingMessage extends BaseMessage {
  type: 'client.ping';
  payload?: Record<string, unknown>;
}

export interface ClientSessionStartMessage extends BaseMessage {
  type: 'client.session.start';
  payload?: {
    clientName?: string;
    clientVersion?: string;
    language?: string;
    [key: string]: unknown;
  };
}

export interface ClientSessionEndMessage extends BaseMessage {
  type: 'client.session.end';
  payload?: {
    reason?: string;
    [key: string]: unknown;
  };
}

export interface ClientCancelMessage extends BaseMessage {
  type: 'client.cancel';
  payload?: {
    reason?: string;
    [key: string]: unknown;
  };
}

export interface ClientMessageSendMessage extends BaseMessage {
  type: 'client.message.send';
  payload: {
    text: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Client Voice Messages (Phase C: Real-Time Audio & Control)
// ---------------------------------------------------------------------------

export type ClientVoiceMessageType =
  | 'client.interrupt'
  | 'session.update'
  | 'client.session.update'
  | 'client.voice.commit'
  | 'client.input_audio_buffer.commit';

export interface ClientInterruptMessage extends BaseMessage {
  type: 'client.interrupt';
  payload?: {
    reason?: string;
    sequenceNumber?: number;
    timestampMs?: number;
    [key: string]: unknown;
  };
}

export interface SessionUpdateMessage extends BaseMessage {
  type: 'session.update' | 'client.session.update';
  payload?: {
    audioFormat?: 'pcm16' | 'opus' | 'webm' | string;
    sampleRate?: number;
    channels?: number;
    language?: string;
    vadThreshold?: number;
    [key: string]: unknown;
  };
}

export interface ClientVoiceCommitMessage extends BaseMessage {
  type: 'client.voice.commit' | 'client.input_audio_buffer.commit';
  payload?: {
    text?: string;
    sampleRate?: number;
    chunkCount?: number;
    byteLength?: number;
    language?: string;
    [key: string]: unknown;
  };
}

export type ClientVoiceMessage =
  | ClientInterruptMessage
  | SessionUpdateMessage
  | ClientVoiceCommitMessage;

export type ClientMessage =
  | ClientPingMessage
  | ClientSessionStartMessage
  | ClientSessionEndMessage
  | ClientCancelMessage
  | ClientMessageSendMessage
  | ClientVoiceMessage;

// ---------------------------------------------------------------------------
// Server Messages (Server -> Client)
// ---------------------------------------------------------------------------

export type ServerMessageType =
  | 'server.ready'
  | 'server.pong'
  | 'server.session.started'
  | 'server.session.ended'
  | 'server.error'
  | 'server.cancel.acknowledged'
  | 'server.message.accepted'
  | 'server.response.started'
  | 'server.response.delta'
  | 'server.response.completed'
  | 'server.response.cancelled'
  | ServerVoiceMessageType;

export interface ServerReadyMessage extends BaseMessage {
  type: 'server.ready';
  payload: {
    connectionId: string;
    protocolVersion: string;
    serverTime: string;
  };
}

export interface ServerPongMessage extends BaseMessage {
  type: 'server.pong';
  payload: Record<string, unknown>;
}

export interface ServerSessionStartedMessage extends BaseMessage {
  type: 'server.session.started';
  sessionId: string;
  payload: {
    sessionId: string;
    createdAt: string;
  };
}

export interface ServerSessionEndedMessage extends BaseMessage {
  type: 'server.session.ended';
  sessionId: string;
  payload: {
    sessionId: string;
    endedAt: string;
    reason?: string;
  };
}

export interface ServerCancelAcknowledgedMessage extends BaseMessage {
  type: 'server.cancel.acknowledged';
  payload: {
    acknowledged: boolean;
    details?: string;
    cancelledActiveGeneration?: boolean;
  };
}

export interface ServerMessageAcceptedMessage extends BaseMessage {
  type: 'server.message.accepted';
  payload: {
    messageId: string;
  };
}

export interface ServerResponseStartedMessage extends BaseMessage {
  type: 'server.response.started';
  payload: {
    responseId: string;
  };
}

export interface ServerResponseDeltaMessage extends BaseMessage {
  type: 'server.response.delta';
  payload: {
    delta: string;
    index: number;
    responseId: string;
  };
}

export interface ServerResponseCompletedMessage extends BaseMessage {
  type: 'server.response.completed';
  payload: {
    responseId: string;
    text: string;
  };
}

export interface ServerResponseCancelledMessage extends BaseMessage {
  type: 'server.response.cancelled';
  payload: {
    reason: string;
    responseId?: string;
  };
}

export interface ServerErrorMessage extends BaseMessage {
  type: 'server.error';
  payload: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Server Voice Messages (Phase C: Real-Time Audio & Control)
// ---------------------------------------------------------------------------

export type ServerVoiceMessageType =
  | 'server.transcript'
  | 'server.generation_cancelled'
  | 'server.session.updated'
  | 'server.audio.chunk';

export interface ServerTranscriptMessage extends BaseMessage {
  type: 'server.transcript';
  payload: {
    text: string;
    isFinal: boolean;
    role?: 'user' | 'assistant';
    confidence?: number;
    language?: string;
    [key: string]: unknown;
  };
}

export interface ServerGenerationCancelledMessage extends BaseMessage {
  type: 'server.generation_cancelled';
  payload: {
    reason: string;
    responseId?: string;
    [key: string]: unknown;
  };
}

export interface ServerSessionUpdatedMessage extends BaseMessage {
  type: 'server.session.updated';
  payload: {
    sessionId: string;
    updatedAt: string;
    [key: string]: unknown;
  };
}

export interface ServerAudioChunkMessage extends BaseMessage {
  type: 'server.audio.chunk';
  payload: {
    responseId: string;
    index: number;
    audio: string; // base64 encoded audio
    mimeType: string; // e.g. 'audio/mp3'
    text: string;
    isFinal?: boolean;
    format?: string;
    language?: 'te' | 'en';
    voice?: string;
    intent?: string;
    [key: string]: unknown;
  };
}

export type ServerVoiceMessage =
  | ServerTranscriptMessage
  | ServerGenerationCancelledMessage
  | ServerSessionUpdatedMessage
  | ServerAudioChunkMessage;

export type ServerMessage =
  | ServerReadyMessage
  | ServerPongMessage
  | ServerSessionStartedMessage
  | ServerSessionEndedMessage
  | ServerCancelAcknowledgedMessage
  | ServerMessageAcceptedMessage
  | ServerResponseStartedMessage
  | ServerResponseDeltaMessage
  | ServerResponseCompletedMessage
  | ServerResponseCancelledMessage
  | ServerErrorMessage
  | ServerVoiceMessage;

// ---------------------------------------------------------------------------
// Type Guard Helpers
// ---------------------------------------------------------------------------

export function isClientVoiceMessage(msg: ClientMessage): msg is ClientVoiceMessage {
  return (
    msg.type === 'client.interrupt' ||
    msg.type === 'session.update' ||
    msg.type === 'client.session.update' ||
    msg.type === 'client.voice.commit' ||
    msg.type === 'client.input_audio_buffer.commit'
  );
}

export function isServerVoiceMessage(msg: ServerMessage): msg is ServerVoiceMessage {
  return (
    msg.type === 'server.transcript' ||
    msg.type === 'server.generation_cancelled' ||
    msg.type === 'server.session.updated' ||
    msg.type === 'server.audio.chunk'
  );
}

export function isClientInterruptMessage(msg: ClientMessage): msg is ClientInterruptMessage {
  return msg.type === 'client.interrupt';
}

export function isSessionUpdateMessage(msg: ClientMessage): msg is SessionUpdateMessage {
  return msg.type === 'session.update' || msg.type === 'client.session.update';
}

export function isServerTranscriptMessage(msg: ServerMessage): msg is ServerTranscriptMessage {
  return msg.type === 'server.transcript';
}

export function isServerGenerationCancelledMessage(
  msg: ServerMessage
): msg is ServerGenerationCancelledMessage {
  return msg.type === 'server.generation_cancelled';
}

export function isServerAudioChunkMessage(msg: ServerMessage): msg is ServerAudioChunkMessage {
  return msg.type === 'server.audio.chunk';
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

const SUPPORTED_CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'client.ping',
  'client.session.start',
  'client.session.end',
  'client.cancel',
  'client.message.send',
  'client.interrupt',
  'session.update',
  'client.session.update',
  'client.voice.commit',
  'client.input_audio_buffer.commit',
]);

export interface ValidationResult {
  success: boolean;
  message?: ClientMessage;
  code?: string;
  errorMessage?: string;
  requestId?: string;
  sessionId?: string;
}

/**
 * Validates whether an incoming raw parsed object satisfies the ClientMessage protocol contract.
 */
export function validateClientMessage(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      success: false,
      code: 'INVALID_MESSAGE_FORMAT',
      errorMessage: 'Message must be a non-null JSON object.',
    };
  }

  const candidate = raw as Record<string, unknown>;

  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId : undefined;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined;

  if (typeof candidate.type !== 'string' || candidate.type.trim() === '') {
    return {
      success: false,
      code: 'MISSING_MESSAGE_TYPE',
      errorMessage: 'Field "type" must be a non-empty string.',
      requestId,
      sessionId,
    };
  }

  if (!SUPPORTED_CLIENT_MESSAGE_TYPES.has(candidate.type)) {
    return {
      success: false,
      code: 'UNKNOWN_MESSAGE_TYPE',
      errorMessage: `Unsupported message type "${candidate.type}". Supported types: ${Array.from(SUPPORTED_CLIENT_MESSAGE_TYPES).join(', ')}.`,
      requestId,
      sessionId,
    };
  }

  // Validate or assign default ISO timestamp
  const timestamp = typeof candidate.timestamp === 'string' && !Number.isNaN(Date.parse(candidate.timestamp))
    ? candidate.timestamp
    : new Date().toISOString();

  // Validate payload
  let payload: Record<string, unknown> | undefined;
  if (candidate.payload !== undefined && candidate.payload !== null) {
    if (typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
      return {
        success: false,
        code: 'INVALID_PAYLOAD',
        errorMessage: 'Field "payload" must be a JSON object when specified.',
        requestId,
        sessionId,
      };
    }
    payload = candidate.payload as Record<string, unknown>;
  } else {
    payload = {};
  }

  // Specific validation for client.message.send: payload.text must be non-empty string
  if (candidate.type === 'client.message.send') {
    const text = payload.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return {
        success: false,
        code: 'EMPTY_MESSAGE',
        errorMessage: 'Field "payload.text" must be a non-empty string.',
        requestId,
        sessionId,
      };
    }
  }

  const validMessage = {
    type: candidate.type as ClientMessageType,
    requestId,
    sessionId,
    timestamp,
    payload,
  } as ClientMessage;

  return {
    success: true,
    message: validMessage,
  };
}
