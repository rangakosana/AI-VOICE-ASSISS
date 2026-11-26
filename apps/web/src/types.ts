export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';
export type AssistantState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface BaseProtocolMessage {
  type: string;
  timestamp: string;
  sessionId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

export interface ClientSessionStartMessage extends BaseProtocolMessage {
  type: 'client.session.start';
  payload: {
    clientName: string;
    clientVersion: string;
    language: string;
  };
}

export interface ClientMessageSendMessage extends BaseProtocolMessage {
  type: 'client.message.send';
  sessionId: string;
  payload: {
    text: string;
  };
}

export interface ClientInterruptMessage extends BaseProtocolMessage {
  type: 'client.interrupt';
  sessionId: string;
  payload: {
    reason: string;
    timestampMs: number;
  };
}

export interface SessionUpdateMessage extends BaseProtocolMessage {
  type: 'session.update';
  sessionId: string;
  payload: {
    audioFormat: string;
    sampleRate: number;
    channels: number;
  };
}

export interface ClientSessionEndMessage extends BaseProtocolMessage {
  type: 'client.session.end';
  sessionId: string;
  payload: {
    reason: string;
  };
}

export interface ClientVoiceCommitMessage extends BaseProtocolMessage {
  type: 'client.voice.commit' | 'client.input_audio_buffer.commit';
  sessionId: string;
  payload: {
    text: string;
    chunkCount?: number;
    byteLength?: number;
  };
}

export interface ServerAudioChunkMessage extends BaseProtocolMessage {
  type: 'server.audio.chunk';
  payload: {
    responseId: string;
    index: number;
    audio: string;
    mimeType: string;
    text?: string;
    isFinal?: boolean;
    format?: string;
    language?: 'te' | 'en';
    voice?: string;
    intent?: string;
  };
}

export interface LogEntry {
  id: string;
  time: string;
  direction: 'IN' | 'OUT' | 'SYS';
  type: string;
  payload?: unknown;
}
