# ATLAS: System Architecture

## 1. Overview

ATLAS uses a decoupled client-server architecture organized as a lightweight monorepo. During development, the Node.js backend runs on the developer's Apple Silicon MacBook, while the mobile client (Android) communicates over the local network via REST and WebSockets.

```
+--------------------------------------------------------+
|                      Clients                           |
|   +-----------------------+   +--------------------+   |
|   |  Android Application  |   |  Desktop Client    |   |
|   |  (Kotlin/Compose)     |   |  (MacBook, later)  |   |
|   +-----------+-----------+   +---------+----------+   |
+---------------|-------------------------|--------------+
                | HTTP / WebSocket (/v1/realtime)
                v                         v
+--------------------------------------------------------+
|                 ATLAS Backend (Fastify)                |
|                                                        |
|   +------------------------------------------------+   |
|   | Routes (/health, /v1/realtime)                 |   |
|   +------------------------------------------------+   |
|   | WebSocket Engine (@fastify/websocket - 64 KB)  |   |
|   +------------------------------------------------+   |
|   | Middleware (Error Handler, Logger, NotFound)   |   |
|   +------------------------------------------------+   |
|   | Conversation Engine (Turn & Context Manager)   |   |
|   +------------------------------------------------+   |
|   | Provider-Agnostic AI Interface (AIProvider)    |   |
|   |   -> Mock Provider (deterministic offline test) |   |
|   |   -> Gemini Provider (@google/genai - ₹0 Free) |   |
|   |   -> Provider Factory (Dynamic Config Switch)  |   |
|   |   -> Future Live Providers (Local LLM, etc.)   |   |
|   +------------------------------------------------+   |
|   | Session Registry (In-Memory Session Manager)   |   |
|   +------------------------------------------------+   |
|   | Types & Protocol Validators (JSON Protocol)    |   |
|   +------------------------------------------------+   |
|   | Config & Environment Validation                |   |
|   +------------------------------------------------+   |
|                           |                            |
|                           v                            |
|   +------------------------------------------------+   |
|   | SQLite Persistent Storage (Phase 5)            |   |
|   +------------------------------------------------+   |
+--------------------------------------------------------+
```

---

## 2. Directory Structure

```
ATLAS/
├── apps/
│   ├── backend/               # Node.js + TypeScript Fastify server
│   │   ├── src/
│   │   │   ├── config/        # Typed environment configuration & validation
│   │   │   │   └── index.ts
│   │   │   ├── db/            # SQLite storage & database management (better-sqlite3)
│   │   │   │   ├── connection.ts   # Connection factory with WAL, foreign keys, busy timeout
│   │   │   │   ├── migrations/     # Transactional migration runner and schema versions
│   │   │   │   │   ├── 001_initial_schema.ts
│   │   │   │   │   ├── 002_memories_schema.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── repositories/   # Prepared-statement repositories
│   │   │   │   │   ├── messageRepository.ts
│   │   │   │   │   ├── sessionRepository.ts
│   │   │   │   │   └── memoryRepository.ts
│   │   │   │   └── index.ts
│   │   │   ├── routes/        # Modular HTTP and WebSocket route handlers
│   │   │   │   ├── health.ts  # GET /health
│   │   │   │   ├── realtime.ts# GET /v1/realtime (WebSocket)
│   │   │   │   └── index.ts   # Route plugin aggregator
│   │   │   ├── services/      # Business logic and domain services
│   │   │   │   ├── ai/        # AI conversation engine & provider abstraction
│   │   │   │   │   ├── types.ts              # AIProvider, ChatMessage, StreamChunk
│   │   │   │   │   ├── mockProvider.ts       # Deterministic test mock provider
│   │   │   │   │   ├── geminiProvider.ts     # Google Gemini API provider (@google/genai)
│   │   │   │   │   ├── providerFactory.ts    # AI provider resolution from config
│   │   │   │   │   ├── conversationHistory.ts# SQLite-backed session dialogue history
│   │   │   │   │   └── conversationEngine.ts # Turn manager & generation controller
│   │   │   │   ├── memory/    # Personal memory domain service
│   │   │   │   │   ├── types.ts              # Memory domain types & DTOs
│   │   │   │   │   ├── memoryService.ts      # Core memory business logic & sanitization
│   │   │   │   │   └── index.ts
│   │   │   │   ├── sessionRegistry.ts        # SQLite-backed persistent session registry
│   │   │   │   └── index.ts                  # Services aggregator
│   │   │   ├── types/         # Strongly-typed protocol definitions
│   │   │   │   └── protocol.ts# Bidirectional JSON protocol & validator
│   │   │   ├── app.ts         # Fastify app builder (decoupled for testing)
│   │   │   └── server.ts      # Server lifecycle and process entry point
│   │   ├── test/              # Automated unit and integration tests
│   │   │   ├── ai.test.ts     # AI provider & conversation engine unit tests
│   │   │   ├── conversationEngineMemory.test.ts # Ephemeral memory integration tests
│   │   │   ├── db.test.ts     # SQLite foundation & migration unit tests
│   │   │   ├── gemini.test.ts # Gemini provider & configuration unit tests
│   │   │   ├── health.test.ts # Health check endpoint tests
│   │   │   ├── memoryRepository.test.ts # Personal memory repository & schema tests
│   │   │   ├── memoryService.test.ts    # Personal memory domain service tests
│   │   │   ├── persistence.test.ts # Conversation & session persistence tests
│   │   │   └── realtime.test.ts # Realtime WebSocket integration tests
│   │   ├── .env.example       # Example environment variables
│   │   ├── package.json       # Backend dependencies and scripts
│   │   ├── tsconfig.json      # Strict TypeScript compilation config (emits src/ to dist/)
│   │   └── tsconfig.test.json # Typechecking config (checks src/ + test/ without emitting)
│   └── android/               # Future Android client (Kotlin + Jetpack Compose)
│       └── README.md
├── docs/                      # Architectural & project documentation
│   ├── PRODUCT_VISION.md
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACT.md
│   ├── TECHNICAL_DECISIONS.md
│   └── DEVELOPMENT_LOG.md
├── .gitignore
├── package.json               # Root monorepo workspace configuration
└── README.md                  # Developer quickstart and guide
```

---

## 3. Backend Component Responsibilities

### 3.1 Server Lifecycle (`server.ts`)
- Initializes the application by calling `buildApp()`.
- Resolves host and port bindings from the validated configuration.
- Listens on `0.0.0.0` by default so that Android emulators (using `10.0.2.2`) or physical Android phones on the same local Wi-Fi network can connect to the MacBook.
- Listens for process signals (`SIGINT`, `SIGTERM`) to trigger clean Fastify server shutdown.
- Catches unhandled promise rejections and uncaught exceptions to prevent silent process crashes.

### 3.2 Application Factory (`app.ts`)
- Decouples server creation from network socket listening. This pattern allows integration tests to execute requests in-memory via `app.inject()` and `app.injectWS()` without opening network ports.
- Configures structured Pino logging with level adaptation per environment.
- Registers `@fastify/websocket` with a strict `maxPayload: 65536` (64 KB) buffer limit before routes are mounted.
- Configures a global `setNotFoundHandler` providing a consistent JSON schema for 404 responses.
- Configures a centralized `setErrorHandler` that logs internal diagnostics, maps HTTP status codes, and sanitizes 500 error outputs in production.
- Registers route plugins modularly.

### 3.3 Realtime WebSocket Engine (`routes/realtime.ts`)
- Manages duplex WebSocket connections mounted on `GET /v1/realtime`.
- Issues a `server.ready` greeting immediately upon connection containing a fresh `connectionId`.
- Enforces strict message structure: requires JSON encoding, validates message types, verifies required timestamps, and sanitizes error payloads.
- Dispatches client intents (`client.ping`, `client.session.start`, `client.session.end`, `client.cancel`, `client.message.send`) to internal services.
- Connects streaming output from `ConversationEngine` directly to client WebSocket frames (`server.message.accepted`, `server.response.started`, `server.response.delta`, `server.response.completed`, `server.response.cancelled`).
- Ensures connection-level errors or client misbehaviors never crash the backend server process.

### 3.4 Conversation Engine (`services/ai/conversationEngine.ts`)
- Orchestrates multi-turn conversations completely decoupled from transport protocols.
- Receives user prompts, appends them to session history, and invokes the configured `AIProvider`.
- Manages active generations using an internal registry of `AbortController` instances.
- Allows immediate, non-blocking cancellation of in-flight generations upon receiving `client.cancel`.
- Accumulates streamed chunks and registers the finalized assistant message into dialogue history.

### 3.5 Provider-Agnostic AI Interface (`services/ai/types.ts`)
- Defines standard `AIProvider` contract: `generateResponse()` and `streamResponse()`.
- Establishes a common `ChatMessage` structure (`role`, `content`, `timestamp`).
- Standardizes provider error handling via `AIProviderError`.
- Ensures zero provider lock-in; future models (Gemini, local LLMs) drop in seamlessly without touching the conversation engine or route handlers.

### 3.6 In-Memory Conversation History (`services/ai/conversationHistory.ts`)
- Maintains volatile session dialogue turns in memory.
- Enforces strict isolation: Session A's messages are physically segmented from Session B's messages.
- Cleans up conversation state when sessions conclude or clients disconnect.

### 3.7 Deterministic Mock AI Provider (`services/ai/mockProvider.ts`)
- Test provider generating predictable, deterministic multi-chunk stream responses.
- Explicitly identifies itself as test tooling and does not impersonate a real model.
- Simulates realistic chunk delays and responds immediately to `AbortSignal` cancellation.
- Provides error simulation triggers (`[simulate_error]`) for test verification.

### 3.8 Google Gemini Provider (`services/ai/geminiProvider.ts`)
- Implements `AIProvider` using Google's official `@google/genai` TypeScript SDK.
- **Model Selection:** `gemini-2.5-flash` (free-tier eligible multimodal model via Google AI Studio).
- **Zero Cost (₹0 Free Tier):** Relies solely on Google AI Studio's free tier without paid billing accounts or credit cards.
- **System Instructions:** Prepends voice-first conversational guidance instructing the model to remain concise, direct, and natural for spoken audio.
- **Role Transformation:** Converts internal `ChatMessage` structures (`user`, `assistant`) to Gemini `Content` objects (`user`, `model`).
- **Streaming Pipeline:** Streams chunks via `ai.models.generateContentStream()` and transforms them to standard `StreamChunk` formats.
- **Cancellation Semantics:**
  - *Local Stream Cancellation:* AbortSignal immediately halts stream iteration in Node.js, cleans up generators, and triggers turn rollback.
  - *Provider-Side Distinction:* In accordance with `@google/genai` specifications, `AbortSignal` operates client-side and does not guarantee instantaneous termination of remote model inference.
- **Error Mapping:** Converts Google API errors into structured `AIProviderError` objects:
  - HTTP 429 / `RESOURCE_EXHAUSTED` -> `GEMINI_QUOTA_EXCEEDED` (retryable).
  - HTTP 401 / 403 / `API_KEY_INVALID` -> `GEMINI_AUTH_FAILED` (non-retryable).
  - HTTP 500 / 503 -> `GEMINI_SERVICE_ERROR` (retryable).
- **Secret Sanitization:** Automatically redacts `GEMINI_API_KEY` and Google key signatures from error messages to prevent credential leakage.

### 3.9 AI Provider Factory (`services/ai/providerFactory.ts`)
- Dynamically instantiates the active provider based on `AI_PROVIDER`:
  - `AI_PROVIDER=mock`: Returns `MockAIProvider` (zero credentials needed).
  - `AI_PROVIDER=gemini`: Validates `GEMINI_API_KEY` and initializes `GeminiProvider`.
- Decouples server startup and testing from third-party API availability.

### 3.10 Session Registry (`services/sessionRegistry.ts`)
- Bridges volatile in-memory WebSocket connections with persistent SQLite storage:
  - Maintains fast in-memory mappings between live `connectionId`s and active `sessionId`s.
  - Automatically records session creation and termination in SQLite via `SessionRepository`.
  - Ensures clean state recovery on backend restarts by marking dangling active sessions as ended.
  - Allows multiple independent clients to hold distinct sessions concurrently.

### 3.11 Configuration & Environment Discovery (`config/index.ts`)
- Implements a deterministic, multi-directory environment file resolution strategy:
  1. `apps/backend/.env` (backend package-level configuration).
  2. `process.cwd()/.env` (current working directory configuration).
  3. `../../.env` (repository root configuration).
- **Precedence & Safety:** Variables already present in the runtime environment take highest precedence and are never overwritten by `.env`.
- Enforces strict type casting and validation on all config values.

### 3.12 SQLite Persistence Layer (`src/db/`)
- Powered by `better-sqlite3` on Node.js 24 + Apple Silicon macOS.
- **Connection Factory (`src/db/connection.ts`):**
  - Applies mandatory high-concurrency pragmas: `foreign_keys = ON`, `busy_timeout = 5000`, and `journal_mode = WAL`.
  - Safely creates missing parent directories for disk-based databases.
  - Transparently switches to `:memory:` in `test` environment to ensure total test isolation.
- **Migrations Engine (`src/db/migrations/`):**
  - Executes schema changes within individual ACID transactions.
  - Tracks migration IDs in `_migrations` to ensure idempotency.
- **Repositories (`src/db/repositories/`):**
  - `MessageRepository`: Manages dialogue history using prepared statements, preserving chronological turn order (`rowid ASC`), session-scoped deletions, and turn rollback.
  - `SessionRepository`: Manages session lifecycle records, startup recovery of dangling active sessions, and metadata persistence.
  - `MemoryRepository`: Manages personal facts, preferences, goals, and context with backend UUID generation, user/profile ownership, and prepared statement filtering.
- **Fastify Lifecycle Hook:**
  - Fastify instance is decorated with `db` and clean shutdown closes the database via `onClose` hook, flushing WAL logs.

---

## 4. Error Handling Architecture

All API responses adhere to a consistent JSON error envelope:

```json
{
  "error": {
    "code": "STRING_ERROR_CODE",
    "message": "Human readable explanation",
    "statusCode": 404,
    "requestId": "req-1"
  }
}
```

Similarly, all WebSocket error events conform to the standard `server.error` protocol message:
```json
{
  "type": "server.error",
  "requestId": "req-123",
  "sessionId": "session-456",
  "timestamp": "2026-11-12T09:10:00.000Z",
  "payload": {
    "code": "ERROR_CODE",
    "message": "Descriptive error message"
  }
}
```

---

## 5. Security & Isolation

- **No Secrets in Code:** Environment configuration manages all ports, keys, and environments.
- **Payload Limits:** Fastify enforces a strict 64 KB cap on WebSocket frames to defend against memory exhaustion attacks.
- **Sanitized Errors:** Internal stack traces and database details are suppressed from production HTTP and WebSocket error messages.
- **Payload Privacy in Logs:** Complete message payload bodies and user queries are intentionally omitted from standard server logs to protect private conversational data.

---

## 6. Client Networking & Security Boundary (Android & Desktop)

### 6.1 Android Cleartext HTTP Restriction (API 28+)
Modern Android versions (Android 9 / API level 28 and above) disable cleartext HTTP traffic by default. Without explicit configuration, any networking call from an Android application to an `http://` or plain `ws://` endpoint triggers a runtime exception (`java.io.IOException: Cleartext HTTP traffic not permitted`).

### 6.2 Local Development Environment
- During development, the Node.js backend runs on the developer's MacBook without a Certificate Authority (CA) signed SSL certificate.
- To allow the upcoming Android application to connect during local testing, the Android app will use an Android Network Security Config (`res/xml/network_security_config.xml`) that permits cleartext traffic **strictly in debug builds** for local targets (`10.0.2.2` for the Android emulator, or the local LAN IP for a physical Android test device).
- **Controlled Boundary:** Cleartext HTTP and plain WebSockets are acceptable solely within this private, controlled local development environment (loopback or private local subnet behind a developer router).

### 6.3 Mandatory Production Encryption (HTTPS & WSS)
- ATLAS processes real-time voice audio, user instructions, personal facts, and document operations.
- In any non-local or production environment, cleartext HTTP and plain WebSockets are strictly prohibited. Production communication must use **HTTPS** (TLS 1.3) and **WSS** with valid, trusted certificates to prevent passive eavesdropping, active packet tampering, and man-in-the-middle attacks.
