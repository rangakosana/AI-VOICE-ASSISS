# ATLAS: Technical Decisions & Architecture Rationale

This document details key technical choices made during the development of ATLAS, explained in simple language.

---

## 1. Why Fastify Over Express?

- **Speed and Efficiency:** Fastify is one of the fastest web frameworks for Node.js, achieving up to 2x–4x higher throughput compared to Express. This low overhead is critical for an assistant that handles voice streaming and low-latency audio.
- **First-Class Schema Validation & Serialization:** Fastify uses JSON Schema to validate inputs and serialize responses. This automatically prevents malformed requests and optimizes JSON stringification with compiled C-like speed.
- **Modern TypeScript Support:** Fastify was designed with modern TypeScript in mind, providing strong type inference for request parameters, bodies, and query strings.
- **Built-in Pino Logger:** Pino is a fast, structured JSON logger included out of the box, avoiding external logging boilerplate.

---

## 2. Why TypeScript with Native ES Modules (ESM)?

- **Safety and Reliability:** TypeScript catches type mismatches, missing properties, and configuration mistakes at compile time before code ever runs in production.
- **Modern Node Standard:** Setting `"type": "module"` in `package.json` aligns with modern JavaScript standards (`import`/`export`), future-proofing the codebase.

---

## 3. Why Separate `app.ts` from `server.ts`?

- **The Problem:** If `app.listen()` is executed in the same file that creates routes and middleware, automated tests must launch a live TCP server, locate an open port, and deal with port collisions or zombie processes.
- **The Solution:** 
  - `src/app.ts` defines the application factory (`buildApp()`), its routes, plugins, and error handlers.
  - `src/server.ts` imports `buildApp()` and handles server startup, port listening, and process shutdown (`SIGINT`/`SIGTERM`).
- **Benefit:** Tests can use Fastify’s in-memory `app.inject()` and `app.injectWS()` mechanisms to fire HTTP and WebSocket requests directly through the pipeline in under 10 milliseconds without touching the operating system's network stack.

---

## 4. Why Use Node’s Native Test Runner (`node:test`)?

- **Zero Extra Heavy Dependencies:** Starting with Node.js 20+, Node provides a fast, built-in test runner (`node:test`) and assertion library (`node:assert/strict`).
- **Eliminating Bloat:** We avoid adding large dependencies like Jest or Mocha, keeping the foundation minimal, clean, and fast.
- **Rapid Execution:** Tests run via `tsx --test` in under 950 milliseconds with zero configuration files required.

---

## 5. Why Host Binding to `0.0.0.0` by Default?

- When developing an Android application, the mobile client runs on an emulator or an actual physical phone connected to local Wi-Fi.
- Binding to `127.0.0.1` only accepts requests from the host MacBook itself.
- Binding to `0.0.0.0` allows the server to accept connections from the Android Emulator (via `http://10.0.2.2:<port>`) or from a physical Android device on the same local network.

---

## 6. Why Lightweight Monorepo Structure (`apps/backend`, `apps/android`)?

- **Single Source of Truth:** Keeps the backend, mobile app, and API contracts in one repository while maintaining strict isolation between server code and client code.
- **npm Workspaces:** Allows developers to run commands (`npm test`, `npm run dev`) directly from the root repository or inside `apps/backend/`.

---

## 7. Why `@fastify/websocket` v11 for Fastify 5?

- **Ecosystem Compatibility:** Fastify 5 introduced breaking internal architectural changes to route registration and plugin encapsulation. `@fastify/websocket` v11 was built specifically as the official companion for Fastify 5.x.
- **Direct Socket Access:** It passes standard `ws` WebSocket client instances directly into route handlers.
- **In-Memory Testing Support:** It decorates the Fastify instance with `app.injectWS()`, allowing complete end-to-end WebSocket test suites to run in-memory without binding external TCP ports.

---

## 8. Why a Structured JSON Protocol with 64 KB Payload Cap?

- **Predictable Control Plane:** Managing sessions, cancellations, and heartbeats requires unambiguous state synchronization. Using a structured JSON envelope (`type`, `requestId`, `sessionId`, `timestamp`, `payload`) guarantees deterministic parsing and debuggability.
- **Defense in Depth:** Setting a 64 KB maximum payload size prevents denial-of-service (DoS) and memory exhaustion attacks via oversized messages before binary audio streaming is introduced.
- **Strict Separation of Signaling & Audio:** Binary audio chunks (Opus/PCM) will be introduced in subsequent phases with dedicated chunking and buffering controls rather than mixing unvalidated binary streams into the control plane.

---

## 9. Why Provider-Independent AI Architecture?

- **Zero Vendor Lock-In:** Rather than tying ATLAS directly to one proprietary API (such as Google Gemini, OpenAI, Anthropic, or a local llama.cpp instance), we define a strict TypeScript interface (`AIProvider`).
- **Easy Hot-Swapping:** Providers can be switched via runtime configuration or constructor injection without modifying conversation turn handling, WebSocket logic, or client apps.
- **Deterministic Testing:** Decoupling enables our `MockAIProvider` to simulate streaming, network delays, and failure conditions deterministically in tests without connecting to paid third-party APIs.

---

## 10. Why `AbortController` for Real-Time Cancellation?

- **Immediate Interruption (Barge-In):** ATLAS is designed to halt speaking the moment a user interrupts.
- **Propagation through the Pipeline:** When a `client.cancel` message arrives over WebSocket, the `ConversationEngine` invokes `abort()` on the session's active `AbortController`. The attached `AbortSignal` immediately stops the AI streaming generator, frees memory, and notifies the client with `server.response.cancelled`.

---

## 11. Why the Google Gen AI SDK (`@google/genai`)?

- **Official Maintained Library:** `@google/genai` is Google's modern, unified TypeScript/JavaScript SDK (`googleapis/js-genai`), designed to work with Gemini 2.0+ models and succeeding the older `@google/generative-ai` package.
- **Native ESM & TypeScript:** Provides full TypeScript typings, ESM compatibility, and clean async iterable streaming (`generateContentStream`).
- **Configuration & AbortSignal Support:** Allows passing `abortSignal`, `systemInstruction`, and `temperature` directly in the request configuration object.

---

## 12. Why `gemini-2.5-flash` on the ₹0 Free Tier?

- **Zero-Budget Guarantee (₹0):** ATLAS is explicitly designed to incur ₹0 in cloud costs during development. Google AI Studio provides free developer tier access without requiring a credit card or billing account.
- **Optimized for Real-Time Voice Interaction:** Flash-class models (`gemini-2.5-flash`) offer sub-second time-to-first-token (TTFT), which is vital for voice assistants where conversational latency must remain minimal.
- **Predictable Rate Limiting:** Free tier caps (~15 Requests Per Minute and 250,000 Tokens Per Minute) are handled gracefully via structured `GEMINI_QUOTA_EXCEEDED` errors. ATLAS will never automatically fall back to paid tiers or incur billing.

---

## 13. Local Stream Cancellation vs. Provider-Side Cancellation

- **The Distinction:** When a user interrupts ATLAS (`client.cancel`), the backend immediately cancels local stream consumption via `AbortSignal`. The Node.js async generator breaks, memory is released, and incomplete turns are rolled back from session history.
- **SDK Limitation Transparency:** As explicitly documented by Google in `@google/genai`:
  > *"NOTE: AbortSignal is a client-only operation. Using it to cancel an operation will not cancel the request in the service. You will still be charged usage for any applicable operations."*
- **Engineering Implication:** We never claim that remote cloud inference halts instantly across Google's distributed infrastructure; rather, we guarantee that local resource consumption, streaming delivery to the client, and dialogue state are halted and cleaned up deterministically.
