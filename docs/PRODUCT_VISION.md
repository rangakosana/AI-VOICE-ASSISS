# ATLAS: Product Vision

## 1. Executive Summary

**ATLAS** is a voice-first personal AI thinking partner designed to help users brainstorm, solve problems, organize knowledge, and perform daily tasks through effortless, natural dialogue.

Unlike conventional voice assistants that execute rigid single-turn commands ("set a timer", "what is the weather"), ATLAS functions as a persistent collaborator with deep reasoning capability, continuous context awareness, multi-layered memory, and native multilingual fluency.

---

## 2. Core Capabilities

### 2.1 Natural Voice Conversations & Interruption
- **Conversational Fluidity:** Low-latency back-and-forth speech that mimics human conversation pacing.
- **Immediate Interruption (Barge-in):** ATLAS halts speech immediately the moment the user begins speaking, avoiding awkward collisions.
- **Wake-Word Activation:** Hands-free wake word ("Hey Atlas") with low standby battery and CPU consumption.

### 2.2 Multilingual Mastery (English, Telugu & Code-Switching)
- Seamless understanding and natural synthesized speech in English and Telugu.
- Automatic language matching: ATLAS responds in the language spoken by the user without requiring manual toggles.
- Support for natural code-switching (conversational mixing of Telugu and English common in everyday speech).

### 2.3 Intelligent Reasoning & Research
- Deep, structured thinking for complex questions.
- Internet research capability to fetch up-to-date information, verify facts, and provide cited answers.

### 2.4 Multi-Tier Memory Architecture
- **Working Memory:** Fast, ephemeral scratchpad holding current task context and active focus.
- **Short-Term Memory:** Rolling dialogue history maintaining conversational continuity within the current session.
- **Long-Term Memory:** Persistent knowledge store holding user preferences, recurring habits, personal facts, and past discussions, organized for semantic recall.

### 2.5 Authorized Document & File Operations
- Safe, permission-gated file inspection and document search.
- User-in-the-loop authorization model: ATLAS never modifies or deletes files without explicit user consent.

---

## 3. Platform Roadmap

```
┌─────────────────────────────────────────────────────────────┐
│                       ATLAS System                          │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
        Phase 1 - 5                      Phase 6+
               ▼                               ▼
    ┌──────────────────────┐        ┌──────────────────────┐
    │  Android Application │        │   MacBook Desktop    │
    │  (Kotlin + Compose)  │        │   (Native Client)    │
    └──────────────────────┘        └──────────────────────┘
```

1. **Phase 1: Core Foundation (Current Milestone)**
   - Backend architecture, environment config, Fastify engine, basic health monitoring, modular routing.
2. **Phase 2: Communication & Streaming**
   - WebSocket bi-directional streaming for real-time audio and events.
3. **Phase 3: Speech & Language Engine**
   - Speech-to-Text (STT), Text-to-Speech (TTS), wake-word, English/Telugu language detection and switching.
4. **Phase 4: AI Reasoning & Tool Execution**
   - Reasoning pipeline, tool dispatch, web search.
5. **Phase 5: Persistent Memory Engine**
   - SQLite-backed working, short-term, and long-term memory with vector/keyword indexing.
6. **Phase 6: Android Voice Client**
   - Native Kotlin + Jetpack Compose app with low-latency audio capture and playback.
7. **Phase 7: Desktop Expansion**
   - MacBook native support, file indexer, and system automation.

---

## 4. Guiding Principles

- **Local First & Privacy Minded:** All sensitive configuration, audio streaming, and personal data remain under user control.
- **Incremental & Tested:** Every component is introduced in isolated, test-covered phases.
- **Simplicity Over Cleverness:** Avoid unnecessary frameworks, premature abstractions, and paid lock-in.

