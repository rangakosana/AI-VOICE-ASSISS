# ATLAS: API Contract Specification

## 1. Overview & General Conventions

- **Base URL (Local Development):** `http://<host>:<port>` (Default: `http://localhost:3000` or `http://0.0.0.0:3000`)
- **WebSocket URL (Local Development):** `ws://<host>:<port>` (Default: `ws://localhost:3000` or `ws://0.0.0.0:3000`)
- **Content-Type / Serialization:** `application/json` (UTF-8)
- **Date/Time Format:** ISO 8601 strings (e.g., `2026-11-12T08:42:00.000Z`)
- **Standard HTTP Error Envelope:**
  ```json
  {
    "error": {
      "code": "STRING_IDENTIFIER",
      "message": "Human readable description",
      "statusCode": 404,
      "requestId": "req-1"
    }
  }
  ```

---

## 2. HTTP Endpoints

### 2.1 Health Check

Retrieves service operational status and runtime metadata.

- **Path:** `/health`
- **Method:** `GET`
- **Authentication:** None (Public)

#### Response: 200 OK
- **Body Schema:**
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `status` | string | Constant `'ok'` indicating operational state |
  | `timestamp` | string | Current server time in ISO 8601 format |
  | `uptime` | number | Process uptime in seconds |
  | `environment` | string | Current runtime environment (`development`, `production`, `test`) |
  | `version` | string | Application semantic version (`0.1.0`) |

- **Example 200 Response:**
  ```json
  {
    "status": "ok",
    "timestamp": "2026-11-12T08:45:55.016Z",
    "uptime": 7.177,
    "environment": "development",
    "version": "0.1.0"
  }
  ```

---

## 3. Realtime WebSocket Protocol (`/v1/realtime`)

> [!WARNING]
> **Development-Only Endpoint:** This endpoint is currently unauthenticated and intended strictly for local development between the mobile client and local backend. It must **never** be exposed publicly without TLS/WSS encryption and an authentication layer.

### 3.1 Connection & Handshake
- **Endpoint:** `GET /v1/realtime`
- **Protocol:** WebSocket (`ws://` in local development, `wss://` in production)
- **HTTP Fallback:** Standard HTTP `GET` requests without the `Upgrade: websocket` header receive `426 Upgrade Required`.
- **Maximum Payload Size:** 64 KB (`65,536` bytes) for JSON control frames.
- **Binary Frames:** Disallowed in this milestone; binary messages are safely rejected with `server.error`.

---

### 3.2 Protocol Envelope Specification

Every WebSocket message exchanged conforms to the standard JSON envelope:

```json
{
  "type": "message.type",
  "requestId": "optional-client-assigned-correlation-id",
  "sessionId": "optional-session-identifier",
  "timestamp": "2026-11-12T09:10:00.000Z",
  "payload": {}
}
```

| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `type` | string | Yes | Message type identifier (e.g. `client.ping`, `server.ready`) |
| `requestId` | string | No | Correlation identifier passed through by server responses |
| `sessionId` | string | No | Target session identifier |
| `timestamp` | string | Yes | ISO 8601 creation timestamp |
| `payload` | object | Yes | Type-specific message payload |

---

### 3.3 Client Messages (Client -> Server)

| Message Type | Description | Payload Schema |
| :--- | :--- | :--- |
| `client.ping` | Connection heartbeat | `{}` |
| `client.session.start` | Initiates an interactive conversation session | `{"clientName"?: string, "clientVersion"?: string, "language"?: string}` |
| `client.session.end` | Explicitly concludes an active session | `{"reason"?: string}` |
| `client.cancel` | Cancels any active AI generation or in-flight processing | `{"reason"?: string}` |
| `client.message.send` | Dispatches a user conversation turn for AI generation | `{"text": string}` *(non-empty)* |

---

### 3.4 Server Messages (Server -> Client)

| Message Type | Trigger | Payload Schema |
| :--- | :--- | :--- |
| `server.ready` | Sent immediately upon connection | `{"connectionId": string, "protocolVersion": "1.0.0", "serverTime": string}` |
| `server.pong` | Response to `client.ping` | `{}` |
| `server.session.started` | Response to valid `client.session.start` | `{"sessionId": string, "createdAt": string}` |
| `server.session.ended` | Response to valid `client.session.end` | `{"sessionId": string, "endedAt": string, "reason": string}` |
| `server.cancel.acknowledged` | Response to `client.cancel` | `{"acknowledged": boolean, "details": string, "cancelledActiveGeneration"?: boolean}` |
| `server.message.accepted` | Immediate acknowledgment of `client.message.send` | `{"messageId": string}` |
| `server.response.started` | Emitted when AI provider begins streaming | `{"responseId": string}` |
| `server.response.delta` | Streamed text chunk from the AI provider | `{"delta": string, "index": number, "responseId": string}` |
| `server.response.completed` | Emitted when all stream chunks have completed | `{"responseId": string, "text": string}` |
| `server.response.cancelled` | Emitted when generation is stopped via cancellation | `{"reason": string, "responseId"?: string}` |
| `server.error` | Sent when an error, validation, or protocol violation occurs | `{"code": string, "message": string}` |

---

### 3.5 AI Conversation Lifecycle & Message Flow

```
Client                                                  Server (ATLAS)
  │                                                           │
  │─── client.message.send { text: "Hello Atlas" } ──────────>│
  │                                                           │
  │<── server.message.accepted { messageId: "m-1" } ──────────│
  │<── server.response.started { responseId: "r-1" } ─────────│
  │                                                           │
  │<── server.response.delta { delta: "Hello", index: 0 } ────│
  │<── server.response.delta { delta: " there!", index: 1 } ──│
  │                                                           │
  │<── server.response.completed { text: "Hello there!" } ────│
  │                                                           │
```

#### Mid-Stream Cancellation Flow:
```
Client                                                  Server (ATLAS)
  │                                                           │
  │─── client.message.send { text: "Tell a long story" } ────>│
  │<── server.message.accepted ... ───────────────────────────│
  │<── server.response.started ... ───────────────────────────│
  │<── server.response.delta { delta: "Once upon...", ... } ──│
  │                                                           │
  │─── client.cancel { sessionId: "s-1" } ───────────────────>│
  │                                                           │
  │<── server.cancel.acknowledged { cancelledActive: true } ──│
  │<── server.response.cancelled { reason: "client_cancel" } ─│
  │                                                           │
```

---

### 3.6 Example Payloads

#### `client.message.send`
```json
{
  "type": "client.message.send",
  "requestId": "req-201",
  "sessionId": "a82c40c1-3f62-4217-91de-5fb026d30e52",
  "timestamp": "2026-11-12T09:12:00.000Z",
  "payload": {
    "text": "Can you explain the ATLAS architecture?"
  }
}
```

#### `server.message.accepted`
```json
{
  "type": "server.message.accepted",
  "requestId": "req-201",
  "sessionId": "a82c40c1-3f62-4217-91de-5fb026d30e52",
  "timestamp": "2026-11-12T09:12:00.010Z",
  "payload": {
    "messageId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  }
}
```

#### `server.response.delta`
```json
{
  "type": "server.response.delta",
  "requestId": "req-201",
  "sessionId": "a82c40c1-3f62-4217-91de-5fb026d30e52",
  "timestamp": "2026-11-12T09:12:00.025Z",
  "payload": {
    "responseId": "c4d5e6f7-a8b9-4c0d-1e2f-3a4b5c6d7e8f",
    "index": 0,
    "delta": "ATLAS is "
  }
}
```

#### `server.response.completed`
```json
{
  "type": "server.response.completed",
  "requestId": "req-201",
  "sessionId": "a82c40c1-3f62-4217-91de-5fb026d30e52",
  "timestamp": "2026-11-12T09:12:00.080Z",
  "payload": {
    "responseId": "c4d5e6f7-a8b9-4c0d-1e2f-3a4b5c6d7e8f",
    "text": "ATLAS is a voice-first personal AI thinking partner."
  }
}
```

---

### 3.7 Error Codes

| Error Code | HTTP/WS | Description |
| :--- | :---: | :--- |
| `EMPTY_MESSAGE` | WS | Message payload text is missing or contains only whitespace |
| `SESSION_NOT_FOUND` | WS | Action targeted a session that does not exist or has ended |
| `UNKNOWN_MESSAGE_TYPE` | WS | Message type is unrecognized |
| `INVALID_JSON` | WS | Incoming payload could not be parsed as valid JSON |
| `BINARY_NOT_SUPPORTED` | WS | Binary frames received on a JSON-only endpoint |
| `AI_GENERATION_ERROR` | WS | The underlying AI provider raised an error during generation |
| `CONCURRENT_REQUEST_NOT_ALLOWED` | WS | An active generation is already in progress for this session |
| `UPGRADE_REQUIRED` | HTTP | HTTP client attempted standard GET without WebSocket headers |

---

### 3.8 Current Limitations

1. **In-Memory Volatile History:** Conversation turns and session mappings exist exclusively in memory; restarting the server clears active sessions.
2. **AI Provider Availability:** Supports either `MockAIProvider` (deterministic offline test mock) or `GeminiProvider` (Google Gemini Developer API via `@google/genai`). When running with `AI_PROVIDER=gemini`, usage is bounded by Google AI Studio Free Tier limits (~15 RPM, 250,000 TPM).
3. **JSON Frames Only:** Binary audio transmission (PCM streams or Opus chunks) is not supported in this milestone; all messages are structured JSON.
4. **No Authentication:** Connections are unauthenticated and must be restricted to controlled local development networks.
