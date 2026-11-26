# ATLAS: Development Log

All notable architectural changes and milestone completions are recorded here chronologically.

---

## [Milestone 7B.3: ConversationEngine Ephemeral Memory Integration] - 2026-11-13

### Goal
Integrate active, approved personal memories into AI generation requests via `ConversationEngine` using ephemeral in-memory composition. Ensure zero persistent history pollution (memory blocks are never written to SQLite `messages`), maintain strict priority of developer system instructions over user data, preserve turn rollback on abort/failure, and support dynamic memory refreshes across turns.

### Completed Work
1. **ConversationEngine Dependency Injection (`src/services/ai/conversationEngine.ts`):**
   - Added optional `memoryService?: MemoryService` to `ConversationEngineOptions`.
   - Defaults to the active `memoryService` singleton while allowing explicit constructor injection for unit tests.
   - Added support for `options.userId?: string` in `processUserMessage()`.
2. **Ephemeral Context Injection at Request Time:**
   - Retrieves active memory context once per incoming user message via `this.memoryService.buildMemoryPromptContext(options.userId)`.
   - When context exists, prepends an ephemeral `ChatMessage` (`role: 'system'`) to the messages array passed to `provider.streamResponse()`.
   - **Zero-Pollution Guarantee:** The system memory message is NEVER passed to `this.history.addMessage()`, ensuring the SQLite `messages` table stores only legitimate user and assistant dialogue turns.
   - If no active memories exist, provider invocation passes persistent dialogue history untouched.
3. **Turn Rollback & Failure Recovery:**
   - Wrapped memory retrieval in a targeted try-catch block: if memory retrieval throws, the newly registered user turn is rolled back cleanly from SQLite and `callbacks.onError(err)` is notified.
   - Preserved mid-stream AbortSignal cancellation: aborting a generation rolls back the user turn without affecting stored personal memories.
4. **Security & Prompt Priority Enforcement:**
   - Memory context is framed as passive user background data rather than system instructions.
   - Provider architecture remains 100% provider-independent, operating via the common `AIProvider` interface.
5. **Automated Testing Suite (`test/conversationEngineMemory.test.ts`):**
   - Added 9 comprehensive integration tests verifying:
     1. Active memories reaching the provider as an ephemeral system message.
     2. Strict exclusion of suggested, archived, and deleted memories.
     3. Untouched pass-through when no memories exist.
     4. Proof that memory context is never written to SQLite conversation history.
     5. Immediate reflection of memory updates on subsequent turns without session restart.
     6. User profile isolation across sessions.
     7. Clean turn cancellation rollback without affecting memories.
     8. Multi-turn dialogue continuity across consecutive turns.
     9. Failure during memory retrieval safely rolling back the turn without history corruption.
   - Total test suite expanded to **105/105 passing tests** across 11 test suites in ~1.6s.

### Verification Results
- `npm run typecheck`: 0 errors across 24 source files and 10 test suites.
- `npm test`: 105/105 tests passing across 11 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 7B.2: Prompt Context Builder & Budget Management] - 2026-11-13

### Goal
Implement `buildMemoryPromptContext()` within `MemoryService` to generate structured, categorized prompt context blocks strictly from active memories. Exclude suggested, archived, and deleted records, enforce configurable memory count and character limits without partial entry truncation, and frame memory content strictly as user data rather than executable system instructions.

### Completed Work
1. **Prompt Context Builder (`src/services/memory/memoryService.ts`):**
   - Implemented `buildMemoryPromptContext(userId)`:
     - Queries only memories with `status: 'active'`.
     - Strictly excludes `suggested`, `archived`, and deleted memories.
     - Groups memories into 4 categorized markdown sections:
       - `### Personal Facts` (`personal_fact`)
       - `### Preferences` (`preference`)
       - `### Goals` (`goal`)
       - `### Important Context` (`context`)
     - Enforces configurable limits:
       - `maxActiveMemories`: default 20 active memories.
       - `maxContextChars`: default 2,000 characters.
     - Truncation safety: Entire memory entries are either included completely or omitted cleanly; no malformed or half-truncated strings are ever produced.
     - Empty state: Returns `undefined` if no active memories exist or if the character budget is too restrictive to fit any entry.
     - Safety framing: Injects a clear framing header stating the content was provided by the user in past conversations and must be treated strictly as background data/context rather than system instructions.
     - Zero external AI or network calls.
2. **Context Configuration Contracts (`src/services/memory/types.ts`):**
   - Added `MemoryContextConfig` (`maxActiveMemories`, `maxContextChars`) to `MemoryServiceOptions`.
3. **Automated Unit Testing (`test/memoryService.test.ts`):**
   - Added 9 unit tests for Stage 7B.2 covering:
     1. Empty database returning `undefined`.
     2. Retrieval of only active memories and exclusion of suggested and archived records.
     3. Immediate exclusion of hard-deleted memories.
     4. Categorization across all 4 categories with clean markdown and safety framing.
     5. Omission of empty category headings.
     6. `maxActiveMemories` limit enforcement.
     7. `maxContextChars` limit enforcement without partial/malformed entries.
     8. Budget exhaustion returning `undefined` when headers cannot fit.
     9. Multi-user profile isolation for context generation.
   - Total test suite expanded to **96/96 passing tests** across 10 test suites in ~1.5s.

### Verification Results
- `npm run typecheck`: 0 errors across 24 source files and 9 test suites.
- `npm test`: 96/96 tests passing across 10 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 7B.1: Memory Domain Types & Service Core] - 2026-11-13

### Goal
Implement the domain service layer (`MemoryService`) and domain contracts for the Personal Memory System. Encapsulate business logic, constructor dependency injection of `MemoryRepository`, user scoping defaulting to `default_user`, credential/secret detection, explicit vs suggested status guardrails, and input sanitization with zero exposure of raw memory content in server logs.

### Completed Work
1. **Memory Domain Types (`src/services/memory/types.ts`):**
   - Defined `SaveMemoryInput`, `UpdateMemoryInput`, `MemoryListFilter`, and `MemoryServiceOptions`.
   - Re-exported repository memory models (`MemoryCategory`, `MemoryRecord`, `MemorySource`, `MemoryStatus`).
2. **Memory Service Core (`src/services/memory/memoryService.ts`):**
   - Constructor injection pattern accepting `options.repository?: MemoryRepository`, defaulting to singleton repository.
   - User ownership scoping defaulting to `default_user`, preventing payload-level user injection attacks.
   - Implemented service methods:
     - `saveMemory(input, userId)`: Defaults explicit saves to `source: 'explicit_user'`, `status: 'active'`. Enforces that assistant suggested saves remain `suggested`.
     - `getMemory(id, userId)`: Scoped retrieval.
     - `listMemories(filter, userId)`: Filtered listing by category, status, search string, and limit.
     - `updateMemory(id, update, userId)`: Scoped updates with content validation and secret checks.
     - `deleteMemory(id, userId)`: Permanent hard delete scoped to user.
     - `approveSuggestedMemory(id, editedContent, userId)`: Explicit approval transition moving memory from `suggested` to `active`.
   - Security & privacy protection: Scans memory content against credential patterns (Google API keys, private keys, bearer tokens, OpenAI/Anthropic keys, GitHub tokens, AWS keys, password assignments) and rejects them.
   - Exported `memoryService` singleton instance.
3. **Module Aggregators (`src/services/memory/index.ts`, `src/services/index.ts`):**
   - Exported unified memory service module.
4. **Automated Unit Testing (`test/memoryService.test.ts`):**
   - Implemented 8 comprehensive unit tests covering:
     1. Dependency injection and default user scope.
     2. Explicit memory saving defaults (`explicit_user`, `active`).
     3. Suggested memory status guardrails and `approveSuggestedMemory` transitions.
     4. Content trimming and rejection of empty/whitespace content.
     5. Credential and secret rejection on save and update.
     6. Filtering by category, search substring, and limit.
     7. User-scoped update and delete protection.
     8. Multi-user isolation without cross-user leakage.
   - Total test suite expanded to **87/87 passing tests** across 9 test suites in ~1.7s.

### Verification Results
- `npm run typecheck`: 0 errors across 24 source files and 8 test suites.
- `npm test`: 87/87 tests passing across 9 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 7A: Personal Memory Schema & Repository] - 2026-11-13

### Goal
Implement the database schema and repository foundation for the ATLAS Personal Memory System. Provide structured storage for user facts, preferences, goals, and context with backend UUID generation, user/profile ownership (single-user compatible), strict input validation, category and status filtering, prepared SQL queries, and comprehensive automated test coverage.

### Completed Work
1. **Database Migration (`src/db/migrations/002_memories_schema.ts`):**
   - Created `memories` table with columns: `id`, `user_id`, `category`, `content`, `source`, `status`, `session_id`, `created_at`, `updated_at`, `metadata`.
   - Supported categories: `personal_fact`, `preference`, `goal`, `context`.
   - Supported statuses: `active`, `suggested`, `archived`.
   - Supported sources: `explicit_user`, `assistant_suggested`.
   - Configured `FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL` so memories outlive conversation session lifecycles.
   - Added indexes on `(user_id)`, `(user_id, status, category)`, `(created_at)`, and `(session_id)`.
   - Registered `migration002` in `src/db/migrations/index.ts`.
2. **Personal Memory Repository (`src/db/repositories/memoryRepository.ts`):**
   - Backend-generated UUIDv4 via `crypto.randomUUID()` (never trusting client IDs).
   - Single-user compatible ownership defaulting to `user_id = 'default_user'`.
   - Full CRUD operations with prepared statements:
     - `createMemory(input)`: Validates category, status, source, and non-empty content (max 1000 chars); saves to SQLite.
     - `getMemory(id, userId)`: Retrieves memory by ID and user scope.
     - `listMemories(filter)`: Dynamic parameterized filtering by category, status, search substring (`LIKE`), and limit, ordered chronologically.
     - `updateMemory(id, update, userId)`: Updates content, category, status, and metadata, refreshing `updated_at`.
     - `deleteMemory(id, userId)`: Hard-deletes memory permanently.
     - `countMemories(filter)`: Counts matching records.
     - `clearAllMemories()`: Complete table purge for testing teardowns.
   - Exported from `src/db/index.ts`.
3. **Automated Test Suite (`test/memoryRepository.test.ts`):**
   - 10 comprehensive unit tests:
     1. Migration 002 execution and repeatability (idempotency).
     2. Creation with backend UUID generation and field fidelity.
     3. Support for all 4 categories and all 3 statuses.
     4. Filtering by category, status, substring search, and limit.
     5. Updating content, category, status, metadata, and timestamp progression.
     6. Hard deletion verification.
     7. Input validation (invalid category/status/source, empty content, >1000 char length).
     8. User/profile isolation and cross-user protection.
     9. Session origin optionality and `ON DELETE SET NULL` cascade behavior.
     10. Disk-based persistence across connection close and reopen.
   - Total test suite expanded to **79/79 passing tests** across 8 test suites in ~1.5s.

### Verification Results
- `npm run typecheck`: 0 errors across 21 source files and 7 test suites.
- `npm test`: 79/79 tests passing across 8 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 6B: Persistent Conversation Storage] - 2026-11-13

### Goal
Replace volatile in-memory dialogue and session tracking with a robust SQLite-backed persistence layer using `better-sqlite3`. Maintain full backwards compatibility with existing AI providers, ConversationEngine, and WebSocket protocols while persisting session lifecycle states, preserving chronological turn order, maintaining strict session isolation, and honoring clean cancellation turn rollback.

### Completed Work
1. **Message Repository (`src/db/repositories/messageRepository.ts`):**
   - Implemented typed `MessageRepository` using prepared statements:
     - `addMessage(sessionId, message)`: Persists user and assistant messages with UTC timestamps, auto-ensuring foreign key validity for test isolation.
     - `getMessagesBySessionId(sessionId)`: Chronological retrieval ordered by `rowid ASC` to prevent sub-millisecond clock ambiguity.
     - `deleteMessage(sessionId, messageId)`: Clean turn rollback for cancelled or aborted generations.
     - `clearMessagesBySessionId(sessionId)`: Scoped cleanup for session ends without leaking into other sessions.
     - `countMessages(sessionId)`: Fast turn counting per session.
     - `clearAll()`: Complete table purge for testing teardowns.
2. **Session Repository (`src/db/repositories/sessionRepository.ts`):**
   - Implemented typed `SessionRepository` managing session persistence in SQLite:
     - `createSession(session)`: Inserts active session record with connection ID, metadata JSON, and created timestamp.
     - `getSession(sessionId)`: Reads session record, parsing metadata JSON safely.
     - `endSession(sessionId, reason)`: Atomically updates session status to `ended` with termination timestamp and end reason.
     - `markDanglingSessionsEndedOnStartup()`: Cleans up orphaned `active` sessions on backend startup to prevent stale session resumption.
     - `clearAllSessions()`: Complete session table purge for test resets.
3. **SQLite-Backed Conversation History Manager (`src/services/ai/conversationHistory.ts`):**
   - Replaced in-memory Map with SQLite `MessageRepository` backing while preserving the exact existing public interface (`addMessage`, `getHistory`, `getMessageCount`, `removeMessage`, `clearHistory`, `clearAll`).
   - Supports constructor injection (`messageRepository` or `db`) and defaults to the active database singleton.
4. **Session Registry Lifecycle Integration (`src/services/sessionRegistry.ts`):**
   - Bridges live in-memory WebSocket connections with persistent SQLite storage:
     - Fast in-memory lookup for live connection-to-session routing.
     - Automatic persistence of session creation and termination.
     - Startup recovery marking defunct active sessions as ended.
5. **Turn Rollback & Isolation Verification:**
   - Generation cancellation via client abort or socket disconnect removes the incomplete user prompt and partial assistant response directly from SQLite.
   - Verified that multi-session concurrency never leaks dialogue history between sessions.
6. **Automated Testing Suite (`test/persistence.test.ts`):**
   - Implemented 10 comprehensive tests covering:
     1. Message insertion, retrieval, and field fidelity.
     2. Strict chronological order (`ORDER BY rowid ASC`).
     3. Message removal and count updating.
     4. Scoped message clearing without cross-session pollution.
     5. Session creation, retrieval, and termination persistence.
     6. Dangling active session cleanup on startup.
     7. Disk persistence across connection close and reopen.
     8. ConversationEngine + SQLite history turn persistence and cancellation rollback.
     9. SessionRegistry live socket bridging with SQLite.
     10. End-to-end WebSocket flow with SQLite persistence verification.
   - Total test suite expanded to **69/69 passing tests** across 7 test suites in ~1.5s.

### Verification Results
- `npm run typecheck`: 0 errors across 20 source files and 6 test suites.
- `npm test`: 69/69 tests passing across 7 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 6A: SQLite Database Foundation] - 2026-11-13

### Goal
Establish the foundational SQLite database module using `better-sqlite3` on Node.js 24 + Apple Silicon macOS, providing a connection factory with mandatory pragmas (WAL mode, foreign keys, busy timeout), a transaction-safe migration runner, configuration integration (`SQLITE_DB_PATH` with in-memory test fallback), Fastify lifecycle management, and automated test coverage.

### Completed Work
1. **Dependency Installation:**
   - Installed `better-sqlite3` (`^13.1.1`) and `@types/better-sqlite3` (`^9.6.0`) in `apps/backend`.
   - Verified clean compilation on Apple Silicon arm64 macOS with Node.js 24.
2. **Database Module (`src/db/`):**
   - Implemented `createDatabaseConnection()` in `src/db/connection.ts` applying:
     - `PRAGMA foreign_keys = ON`
     - `PRAGMA busy_timeout = 5000`
     - `PRAGMA journal_mode = WAL`
     - Automatic parent directory creation for disk paths.
   - Built transactional, idempotent migration runner in `src/db/migrations/index.ts` tracking applied migrations in `_migrations`.
   - Created initial schema migration (`001_initial_schema.ts`) defining foundational `sessions` and `messages` tables with indexes and cascading foreign keys.
   - Provided `initDatabase()`, `getDatabase()`, and `closeDatabase()` lifecycle helpers in `src/db/connection.ts`.
   - Exported unified API from `src/db/index.ts`.
3. **Configuration & Environment:**
   - Added `databasePath` to `AppConfig` in `src/config/index.ts`.
   - Created `resolveDatabasePath()` supporting `SQLITE_DB_PATH`, defaulting to absolute `apps/backend/data/atlas.db` in development and `:memory:` in test environment.
   - Updated `.env.example` templates with `SQLITE_DB_PATH=data/atlas.db`.
   - Updated `.gitignore` to exclude `apps/backend/data/`, `data/`, `*.db`, `*.db-wal`, and `*.db-shm`.
4. **Fastify Lifecycle Integration:**
   - Decorated Fastify instance with `db` and registered `server.addHook('onClose', ...)` in `src/app.ts` to cleanly close SQLite and flush WAL checkpoint files during graceful shutdown.
5. **Automated Testing Suite:**
   - Created `test/db.test.ts` (9 tests covering in-memory connection, mandatory pragmas, foreign key cascade and constraints, parent directory creation, migration tracking, repeated migration idempotency, transaction rollback on failure, Fastify lifecycle hook, and path resolution).
   - Total test suite expanded to **59/59 passing tests** across 6 suites in ~1.5s.

### Verification Results
- `npm run typecheck`: 0 errors across 18 source files and 5 test suites.
- `npm test`: 59/59 tests passing across 6 test suites (0 failures).
- `npm run build`: Clean production build compiled into `dist/`.

---

## [Milestone 4: Real AI Provider Integration (Google Gemini Developer API)] - 2026-11-12

### Goal
Connect the existing provider-independent `ConversationEngine` to Google's Gemini Developer API via a new `GeminiProvider` using the official `@google/genai` TypeScript SDK, strictly adhering to the ₹0 Free Tier constraint, supporting multi-chunk streaming, AbortSignal cancellation, secret sanitization, and seamless provider selection without breaking offline mock workflows.

### Completed Work
1. **Google Gen AI SDK Integration (`@google/genai`):**
   - Installed official `@google/genai` (^3.2.0) package into `apps/backend`.
   - Built `GeminiProvider` implementing `AIProvider` (`generateResponse` and `streamResponse`).
   - Selected `gemini-2.5-flash` as default free-tier model (zero credit card or paid billing required).
   - Formatted dialogue history to Gemini `Content` schema (`user` and `model` roles) and injected voice-first system instructions into `config.systemInstruction`.
   - Transformed response stream chunks into standard `StreamChunk` formats (`{ text, index, isFinal }`).

2. **Zero-Cost Free-Tier & Rate-Limit Safeguards:**
   - Guaranteed ₹0 budget compliance: no paid billing accounts, no paid fallback models.
   - Handled HTTP 429 / `RESOURCE_EXHAUSTED` by mapping to `AIProviderError` with code `GEMINI_QUOTA_EXCEEDED` and `isRetryable: true`.
   - Handled HTTP 401/403 authentication failures via `GEMINI_AUTH_FAILED` (non-retryable).
   - Handled HTTP 500/503 service errors via `GEMINI_SERVICE_ERROR` (retryable).
   - Implemented secret sanitization removing `GEMINI_API_KEY` and Google key patterns from error strings.

3. **Provider Switching & Configuration:**
   - Extended `config/index.ts` with `AI_PROVIDER` (`'mock' | 'gemini'`, default `'mock'`), `GEMINI_API_KEY`, and `GEMINI_MODEL` (`'gemini-2.5-flash'`).
   - Created `services/ai/providerFactory.ts` to instantiate providers dynamically based on configuration.
   - Ensured missing `GEMINI_API_KEY` raises a clear, descriptive error only when `AI_PROVIDER=gemini`.
   - Kept `mock` provider as the default for zero-setup, offline testing without credentials.
   - Updated `.env.example` at backend and root levels with documentation and placeholders.

4. **Cancellation Semantics:**
   - Documented clear distinction between local stream cancellation (immediate termination in Node.js via `AbortSignal`, resource release, turn rollback) and remote provider-side processing (client-side operation per `@google/genai` specification).

5. **Automated Unit & Integration Testing:**
   - Created `test/gemini.test.ts` with 15 focused tests using a mocked SDK client:
     - Provider initialization and missing API key rejection.
     - Default model selection (`gemini-2.5-flash`) and custom model override.
     - System instruction and conversation turn structure formatting.
     - Single-turn generation with token usage metadata.
     - Multi-chunk streaming with accurate monotonic indices.
     - Structured error mapping (429, 401/403, 500/503).
     - Secret sanitization preventing API key leakage in errors.
     - `AbortSignal` cancellation before and mid-stream.
     - Full integration with `ConversationEngine` (turns, rollback on cancel).
     - Environment parsing and provider factory resolution.
   - Total test suite expanded to **49/49 passing tests** across 5 test suites.

### Verification Results
- `npm run typecheck`: 0 errors across 15 source files and 4 test suites.
- `npm test`: 49/49 tests passing across 5 test suites in ~1.5s (0 failures).
- `npm run build`: Clean production build in `dist/` with zero test file pollution.

---

## [Milestone 3.1: AI Engine Audit & Lifecycle Refinements] - 2026-11-12

### Goal
Perform a focused code audit of the Phase 3 AI Conversation Engine covering client disconnection during streaming, concurrency policy within sessions, cancellation history consistency, and request/session lifecycle determinism.

### Completed Work & Corrections
1. **Predictable Concurrency Policy (`CONCURRENT_REQUEST_NOT_ALLOWED`):**
   - **Audit Finding:** Overlapping `client.message.send` requests in the same session previously aborted the prior turn asynchronously without rejecting the incoming request, creating potential race conditions, interleaved responses, and orphaned user history.
   - **Correction:** Implemented a strict rejection policy at both the route layer (`routes/realtime.ts`) and engine layer (`conversationEngine.ts`). Concurrent requests in the same session are rejected immediately with `CONCURRENT_REQUEST_NOT_ALLOWED`, ensuring unambiguous turn sequencing and zero chunk interleaving.

2. **Cancellation History Integrity & Orphan Rollback:**
   - **Audit Finding:** When an active generation was cancelled mid-stream, the user message was left in history without any assistant reply, resulting in an orphaned turn that distorted future context.
   - **Correction:** Added `removeMessage(sessionId, messageId)` to `ConversationHistoryManager`. When `controller.signal.aborted` triggers in `ConversationEngine.processUserMessage()`, the incomplete turn's user message is rolled back cleanly. Subsequent turns start with clean, paired dialogue history.

3. **Lifecycle & Targeted Cancellation Precision:**
   - **Audit Finding:** The cancel handler previously evaluated `message.requestId` as the target generation ID rather than the correlation ID of the cancel command itself.
   - **Correction:** Separated envelope correlation (`message.requestId`) from targeted generation cancellation (`message.payload.targetRequestId` / `message.payload.requestId`). If a target request ID is supplied, only matching generations are aborted; if no target ID is supplied, any active generation for that session is aborted. Unknown or non-matching cancellation requests cleanly return `cancelledActiveGeneration: false`.

4. **Disconnect During Generation Verification:**
   - Verified that socket closure triggers `conversationEngine.cleanupSession()`, immediately aborting the in-flight `AbortController`, terminating the provider's async generator, and freeing active controllers and memory.

5. **Expanded Test Suite:**
   - Added unit tests in `test/ai.test.ts` for concurrent request rejection, cancellation rollback, and targeted cancellation matching.
   - Added integration tests in `test/realtime.test.ts` for concurrent message rejection (`CONCURRENT_REQUEST_NOT_ALLOWED`), disconnect during generation, clean turn recovery after cancellation, targeted cancellation rejection, session termination during active generation, and multi-session independent cancellation.
   - Total test suite expanded to **34/34 tests passing** in 1.2s.

### Verification Results
- `npm run typecheck`: 0 errors across 12 source files and 3 test suites.
- `npm test`: 34/34 tests passing across 3 test suites (0 failures).
- `npm run build`: Production build verified with zero test pollution in `dist/`.

---

## [Milestone 3: Foundational AI Conversation Engine (Provider-Independent)] - 2026-11-12

### Goal
Implement a provider-agnostic AI conversation engine supporting multi-turn dialogue context, streaming chunks, immediate cancellation via `AbortSignal`, session isolation, and WebSocket integration with a deterministic test mock provider (zero external API dependencies).

### Completed Work
1. **AI Provider Abstraction (`src/services/ai/types.ts`):**
   - Defined `AIProvider` interface with `generateResponse()` and `streamResponse()`.
   - Created standardized `ChatMessage`, `MessageRole`, `StreamChunk`, `GenerateResult`, and `AIProviderError` types.
   - Decoupled provider implementations from WebSocket handling and conversation logic.

2. **Deterministic Mock AI Provider (`src/services/ai/mockProvider.ts`):**
   - Implemented `MockAIProvider` yielding predictable multi-chunk responses.
   - Integrated simulated configurable delay (`sleepWithAbort`) responding immediately to `AbortSignal` cancellation.
   - Added `[simulate_error]` trigger for failure resilience testing.

3. **In-Memory Conversation History (`src/services/ai/conversationHistory.ts`):**
   - Implemented volatile turn store managing dialogue history per `sessionId`.
   - Guaranteed physical segmentation preventing cross-session message leakage.

4. **Conversation Engine (`src/services/ai/conversationEngine.ts`):**
   - Implemented turn management, context injection, and generation lifecycle.
   - Built active generation registry with `AbortController` mapping to cancel running stream generators.
   - Handled generation errors and cleanup upon session closure or disconnection.

5. **WebSocket Protocol Extension (`src/types/protocol.ts` & `src/routes/realtime.ts`):**
   - Extended client messages: `client.message.send`.
   - Extended server messages: `server.message.accepted`, `server.response.started`, `server.response.delta`, `server.response.completed`, `server.response.cancelled`.
   - Upgraded `client.cancel` to actively halt in-flight generation via `conversationEngine.cancelGeneration()`.
   - Added validation enforcing non-empty strings on `client.message.send` (`EMPTY_MESSAGE`).
   - Logged turn metadata (lengths, IDs) while protecting conversational privacy by omitting raw user text from logs.

6. **Comprehensive Automated Tests:**
   - Created `test/ai.test.ts` (7 unit tests covering generation, streaming, `AbortSignal`, session isolation, context accumulation, and provider errors).
   - Expanded `test/realtime.test.ts` to 17 integration tests (adding streaming responses, multi-turn context retention, session isolation, active cancellation during stream, empty message rejection, unstarted session handling, and simulated provider failure resilience).
   - Total test suite: 26/26 tests passing in under 900ms.

7. **Documentation:**
   - Updated `docs/API_CONTRACT.md` detailing new AI messages, schemas, error codes, and sequence diagrams.
   - Updated `docs/ARCHITECTURE.md` documenting the AI service layers and context flow.
   - Updated `docs/TECHNICAL_DECISIONS.md` explaining provider independence and `AbortController` barge-in interruption.

### Verification Results
- `npm run typecheck`: 0 errors across 12 source files and 3 test suites.
- `npm test`: 26/26 tests passing across 3 test suites (0 failures).
- `npm run build`: Compiled clean production artifacts into `dist/` with no test pollution.

---

## [Milestone 2: Realtime Communication Layer (WebSockets)] - 2026-11-12

### Goal
Implement the initial bidirectional real-time communication layer using Fastify WebSockets (`@fastify/websocket`), defining a structured JSON protocol for connection lifecycle, sessions, heartbeats, and cancellations, with comprehensive in-memory tests and zero database lock-in.

### Completed Work
1. **Dependency & Plugin Compatibility:**
   - Evaluated Fastify 5 (`^5.2.1`) ecosystem compatibility.
   - Installed `@fastify/websocket@^11.3.7` (official Fastify 5 compatible release) and `@types/ws` devDependency.
   - Registered `@fastify/websocket` with a strict `maxPayload: 65536` (64 KB) buffer limit before routes in `src/app.ts`.

2. **Bidirectional JSON Protocol (`src/types/protocol.ts`):**
   - Defined TypeScript message interfaces with standard envelope: `{ type, requestId, sessionId, timestamp, payload }`.
   - Client messages supported: `client.ping`, `client.session.start`, `client.session.end`, `client.cancel`.
   - Server messages supported: `server.ready`, `server.pong`, `server.session.started`, `server.session.ended`, `server.error`, `server.cancel.acknowledged`.
   - Implemented `validateClientMessage` validator ensuring payload and type safety.

3. **In-Memory Session Registry (`src/services/sessionRegistry.ts`):**
   - Implemented volatile session manager tracking active sessions and connection associations.
   - Clean lifecycle handling: supports multiple independent connections, session supersession, and automatic session cleanup on connection termination.

4. **WebSocket Endpoint (`src/routes/realtime.ts`):**
   - Mounted `GET /v1/realtime`.
   - Non-upgrade standard HTTP requests receive `426 Upgrade Required`.
   - Issues `server.ready` greeting immediately upon connection with unique `connectionId`.
   - Disallows binary frames and returns sanitized `server.error` events on malformed JSON or invalid types.
   - Safe logging: logs connection IDs, message types, and metadata without recording private payload contents.

5. **Automated Integration Testing (`test/realtime.test.ts`):**
   - Built 10 test scenarios covering connection handshake, `server.ready`, ping/pong, session creation, session termination, cancellation, malformed JSON recovery, invalid types, disconnection cleanup, and concurrent multi-client isolation.
   - All tests run in-memory via `app.injectWS()` without port collision risks.

6. **Documentation Updates:**
   - Updated `docs/API_CONTRACT.md` detailing the `/v1/realtime` protocol, envelopes, client/server message schemas, and limitations.
   - Updated `docs/ARCHITECTURE.md` documenting the WebSocket layer, session registry, and security boundaries.
   - Updated `docs/TECHNICAL_DECISIONS.md` explaining why `@fastify/websocket` v11, why JSON protocol, and why the 64 KB payload cap.

### Verification Results
- `npm run typecheck`: 0 errors across 9 source files + 2 test suites.
- `npm test`: 12/12 tests passed across 2 suites in 420ms (0 failures).
- `npm run build`: Compiled cleanly into `dist/`.
- End-to-end verification: Live test confirmed `200 OK` on `/health` and live WebSocket ping-pong on `ws://localhost:3095/v1/realtime`.

---

## [Milestone 1.1: Technical Audit Corrections] - 2026-11-12

### Goal
Implement approved refinements from the technical architecture audit: multi-context environment file resolution, dual TypeScript configuration to include tests during typechecking without polluting `dist/`, and comprehensive Android cleartext vs. production TLS security documentation.

---

## [Milestone 1: Project Foundation] - 2026-11-12

### Goal
Establish a clean, robust, and extensible project foundation for ATLAS with a Fastify + TypeScript backend, configuration management, health monitoring, error handling, automated testing, and foundational documentation.
