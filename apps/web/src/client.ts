import type {
  AssistantState,
  BaseProtocolMessage,
  ClientInterruptMessage,
  ClientMessageSendMessage,
  ClientSessionEndMessage,
  ClientSessionStartMessage,
  ClientVoiceCommitMessage,
  ConnectionStatus,
  LogEntry,
  SessionUpdateMessage,
} from './types.js';

export interface ClientCallbacks {
  onStatusChange: (status: ConnectionStatus) => void;
  onAssistantStateChange: (state: AssistantState) => void;
  onSessionChange: (sessionId: string | null) => void;
  onStreamingDelta: (delta: string, fullText: string) => void;
  onStreamingComplete: (fullText: string) => void;
  onTranscript?: (text: string, isFinal: boolean, role?: string) => void;
  onAudioChunk?: (payload: {
    responseId: string;
    index: number;
    audio: string;
    mimeType: string;
    text?: string;
    isFinal?: boolean;
  }) => void;
  onLog: (entry: LogEntry) => void;
}

export class AtlasWebClient {
  private socket: WebSocket | null = null;
  private url: string;
  private callbacks: ClientCallbacks;

  private connectionStatusInternal: ConnectionStatus = 'DISCONNECTED';
  private assistantStateInternal: AssistantState = 'IDLE';
  private currentSessionIdInternal: string | null = null;
  private currentStreamingTextInternal = '';
  private reconnectTimeoutId: number | null = null;
  private currentBackoffMs = 1000;
  private isExplicitDisconnect = false;
  private outgoingAudioChunksCount = 0;
  private outgoingAudioBytesCount = 0;

  constructor(callbacks: ClientCallbacks, url?: string) {
    this.callbacks = callbacks;
    // Prefer direct or Vite proxied WS URL
    if (url) {
      this.url = url;
    } else {
      const isHttps = window.location.protocol === 'https:';
      const wsProtocol = isHttps ? 'wss:' : 'ws:';
      // If served via Vite on 5173, /v1/realtime is proxied to 3000
      this.url = `${wsProtocol}//${window.location.host}/v1/realtime`;
    }
  }

  get connectionStatus(): ConnectionStatus {
    return this.connectionStatusInternal;
  }

  get assistantState(): AssistantState {
    return this.assistantStateInternal;
  }

  get currentSessionId(): string | null {
    return this.currentSessionIdInternal;
  }

  get currentStreamingText(): string {
    return this.currentStreamingTextInternal;
  }

  connect(customUrl?: string): void {
    if (customUrl) {
      this.url = customUrl;
    }

    this.isExplicitDisconnect = false;
    if (this.reconnectTimeoutId) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    this.setStatus('CONNECTING');
    this.log('SYS', 'Connecting to ' + this.url);

    try {
      this.socket = new WebSocket(this.url);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.setStatus('CONNECTED');
        this.currentBackoffMs = 1000;
        this.log('SYS', 'WebSocket connection established');
      };

      this.socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          this.handleTextMessage(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          this.log('IN', 'binary_audio_frame', { byteLength: event.data.byteLength });
        }
      };

      this.socket.onclose = (event: CloseEvent) => {
        this.setStatus('DISCONNECTED');
        this.log('SYS', `WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
        if (!this.isExplicitDisconnect) {
          this.scheduleReconnect();
        }
      };

      this.socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.setStatus('DISCONNECTED');
        this.log('SYS', 'WebSocket connection error');
      };
    } catch (e: unknown) {
      this.setStatus('DISCONNECTED');
      this.log('SYS', 'Failed to initialize WebSocket: ' + String(e));
      if (!this.isExplicitDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  disconnect(): void {
    this.isExplicitDisconnect = true;
    if (this.reconnectTimeoutId) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    if (this.currentSessionIdInternal) {
      this.endSession('user_disconnected');
    }

    if (this.socket) {
      this.socket.close(1000, 'User requested disconnect');
      this.socket = null;
    }

    this.setStatus('DISCONNECTED');
    this.setAssistantState('IDLE');
    this.setSessionId(null);
  }

  startSession(language = 'en'): void {
    const msg: ClientSessionStartMessage = {
      type: 'client.session.start',
      timestamp: new Date().toISOString(),
      payload: {
        clientName: 'ATLAS-Web-Tester',
        clientVersion: '0.1.0',
        language,
      },
    };
    this.sendJson(msg);
  }

  endSession(reason = 'user_reset'): void {
    if (!this.currentSessionIdInternal) return;

    const msg: ClientSessionEndMessage = {
      type: 'client.session.end',
      sessionId: this.currentSessionIdInternal,
      timestamp: new Date().toISOString(),
      payload: { reason },
    };
    this.sendJson(msg);
  }

  sendMessage(text: string): boolean {
    if (!this.currentSessionIdInternal) {
      this.log('SYS', 'Cannot send message: No active session. Start a session first.');
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) return false;

    const msg: ClientMessageSendMessage = {
      type: 'client.message.send',
      sessionId: this.currentSessionIdInternal,
      timestamp: new Date().toISOString(),
      payload: { text: trimmed },
    };

    const sent = this.sendJson(msg);
    if (sent) {
      this.setAssistantState('THINKING');
    }
    return sent;
  }

  sendInterrupt(reason = 'user_barge_in'): boolean {
    if (!this.currentSessionIdInternal) return false;

    const msg: ClientInterruptMessage = {
      type: 'client.interrupt',
      sessionId: this.currentSessionIdInternal,
      timestamp: new Date().toISOString(),
      payload: {
        reason,
        timestampMs: Date.now(),
      },
    };

    const sent = this.sendJson(msg);
    if (sent) {
      this.setAssistantState('IDLE');
      this.log('SYS', 'Barge-in interrupt dispatched');
    }
    return sent;
  }

  sendSessionUpdate(audioFormat = 'pcm16', sampleRate = 16000): void {
    if (!this.currentSessionIdInternal) return;

    const msg: SessionUpdateMessage = {
      type: 'session.update',
      sessionId: this.currentSessionIdInternal,
      timestamp: new Date().toISOString(),
      payload: {
        audioFormat,
        sampleRate,
        channels: 1,
      },
    };
    this.sendJson(msg);
  }

  sendAudioChunk(buffer: ArrayBuffer): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(buffer);
    this.outgoingAudioChunksCount++;
    this.outgoingAudioBytesCount += buffer.byteLength;

    // Log audio frames periodically so the Protocol Inspector shows streaming data
    if (this.outgoingAudioChunksCount === 1 || this.outgoingAudioChunksCount % 10 === 0) {
      this.log('OUT', 'binary.audio.chunk', {
        chunkIndex: this.outgoingAudioChunksCount,
        bytes: buffer.byteLength,
        totalBytes: this.outgoingAudioBytesCount,
      });
    }
    return true;
  }

  sendVoiceCommit(text?: string | null): boolean {
    if (!this.currentSessionIdInternal) {
      this.log('SYS', 'Cannot commit voice turn: No active session.');
      return false;
    }

    const trimmed = (text || '').trim();
    const chunkCount = this.outgoingAudioChunksCount;
    const byteLength = this.outgoingAudioBytesCount;

    // Reset counters for next voice turn
    this.outgoingAudioChunksCount = 0;
    this.outgoingAudioBytesCount = 0;

    const msg: ClientVoiceCommitMessage = {
      type: 'client.voice.commit',
      sessionId: this.currentSessionIdInternal,
      timestamp: new Date().toISOString(),
      payload: {
        text: trimmed,
        chunkCount,
        byteLength,
      },
    };

    const sent = this.sendJson(msg);
    if (sent && trimmed) {
      this.setAssistantState('THINKING');
    }
    return sent;
  }

  setAssistantState(state: AssistantState): void {
    this.assistantStateInternal = state;
    this.callbacks.onAssistantStateChange(state);
  }

  private setStatus(status: ConnectionStatus): void {
    this.connectionStatusInternal = status;
    this.callbacks.onStatusChange(status);
  }

  private setSessionId(sessionId: string | null): void {
    this.currentSessionIdInternal = sessionId;
    this.callbacks.onSessionChange(sessionId);
  }

  private sendJson(msg: BaseProtocolMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.log('SYS', `Cannot send ${msg.type}: WebSocket not OPEN`);
      return false;
    }

    const json = JSON.stringify(msg);
    this.socket.send(json);
    this.log('OUT', msg.type, msg.payload);
    return true;
  }

  private handleTextMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const type = msg.type || 'unknown';
      this.log('IN', type, msg.payload);

      switch (type) {
        case 'server.ready':
          // Auto-start session on ready
          this.startSession();
          break;

        case 'server.session.started':
          this.setSessionId(msg.sessionId || msg.payload?.sessionId);
          this.sendSessionUpdate('pcm16', 16000);
          break;

        case 'server.session.ended':
          this.setSessionId(null);
          this.setAssistantState('IDLE');
          break;

        case 'server.transcript':
          if (msg.payload?.text) {
            this.callbacks.onTranscript?.(
              msg.payload.text,
              Boolean(msg.payload.isFinal),
              msg.payload.role as string | undefined
            );
          }
          break;

        case 'server.audio.chunk':
          if (msg.payload?.audio) {
            this.callbacks.onAudioChunk?.(msg.payload);
            this.log('IN', 'server.audio.chunk', {
              index: msg.payload.index,
              language: msg.payload.language,
              voice: msg.payload.voice,
              intent: msg.payload.intent,
              text: msg.payload.text,
              isFinal: msg.payload.isFinal,
              audioBytes: Math.round(msg.payload.audio.length * 0.75),
            });
          }
          break;

        case 'server.response.started':
          this.currentStreamingTextInternal = '';
          this.setAssistantState('SPEAKING');
          this.callbacks.onStreamingDelta('', '');
          break;

        case 'server.response.delta':
          if (msg.payload?.delta) {
            this.currentStreamingTextInternal += msg.payload.delta;
            this.callbacks.onStreamingDelta(msg.payload.delta, this.currentStreamingTextInternal);
          }
          break;

        case 'server.response.completed':
          this.currentStreamingTextInternal = msg.payload?.text || this.currentStreamingTextInternal;
          this.setAssistantState('IDLE');
          this.callbacks.onStreamingComplete(this.currentStreamingTextInternal);
          break;

        case 'server.response.cancelled':
        case 'server.generation_cancelled':
          this.setAssistantState('IDLE');
          this.log('SYS', 'Generation cancelled by server.');
          break;

        case 'server.error':
          this.log('SYS', `Error [${msg.payload?.code}]: ${msg.payload?.message}`);
          break;
      }
    } catch (e) {
      console.error('Failed to parse incoming server message:', e, raw);
    }
  }

  private scheduleReconnect(): void {
    this.setStatus('RECONNECTING');
    this.log('SYS', `Reconnecting in ${this.currentBackoffMs}ms...`);

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, 16000);
      this.connect();
    }, this.currentBackoffMs);
  }

  private log(direction: 'IN' | 'OUT' | 'SYS', type: string, payload?: unknown): void {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      direction,
      type,
      payload,
    };
    this.callbacks.onLog(entry);
  }
}
