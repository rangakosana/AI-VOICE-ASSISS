# ATLAS: Personal AI Voice Assistant

ATLAS is a voice-first personal AI thinking partner. It combines natural voice conversation, hands-free wake-word activation ("Hey Atlas"), bilingual fluency (English and Telugu), instant interruption handling, deep AI reasoning, and multi-tiered memory.

---

## Current Status: Phase 1 (Foundation)

The project is being developed in careful, incremental phases. Current development provides the foundational Node.js + TypeScript Fastify backend, health monitoring, error handling, automated testing, and architectural documentation.

---

## Repository Structure

```
ATLAS/
├── apps/
│   ├── backend/               # Node.js + TypeScript Fastify API backend
│   │   ├── src/
│   │   │   ├── config/        # Environment configuration and validation
│   │   │   ├── routes/        # Modular routes (GET /health, GET /v1/realtime)
│   │   │   ├── services/      # Business logic: sessions & AI conversation engine
│   │   │   │   ├── ai/
│   │   │   │   │   ├── types.ts              # AIProvider, ChatMessage, StreamChunk
│   │   │   │   │   ├── mockProvider.ts       # Deterministic test mock provider
│   │   │   │   │   ├── geminiProvider.ts     # Google Gemini API provider (@google/genai)
│   │   │   │   │   ├── providerFactory.ts    # AI provider resolution from config
│   │   │   │   │   ├── conversationHistory.ts# In-memory session dialogue history
│   │   │   │   │   └── conversationEngine.ts # Turn manager & generation controller
│   │   │   │   └── sessionRegistry.ts        # In-memory session registry
│   │   │   ├── types/         # Bidirectional JSON protocol definitions & validators
│   │   │   ├── app.ts         # Fastify app builder (decoupled for testing)
│   │   │   └── server.ts      # Server lifecycle and process entry point
│   │   ├── test/              # Automated unit and integration test suites
│   │   ├── .env.example       # Example environment variables
│   │   ├── package.json       # Backend package configuration
│   │   ├── tsconfig.json      # TypeScript configuration (strict mode, builds src/)
│   │   └── tsconfig.test.json # TypeScript configuration (typechecks src/ + test/)
│   └── android/               # Future Android client (Kotlin + Jetpack Compose)
│       └── README.md
├── docs/
│   ├── PRODUCT_VISION.md      # Detailed product vision and roadmap
│   ├── ARCHITECTURE.md        # Technical architecture and data flow
│   ├── API_CONTRACT.md        # REST and WebSocket API specifications
│   ├── TECHNICAL_DECISIONS.md # Architectural decisions explained simply
│   └── DEVELOPMENT_LOG.md     # Chronological log of development milestones
├── .gitignore
├── .env.example               # Root example environment variables
├── package.json               # Monorepo workspace configuration
└── README.md                  # Project overview and quickstart guide
```

---

## Prerequisites

- **Operating System:** macOS (developed on Apple Silicon M1) or Linux
- **Node.js:** `>= 20.0.0` (Tested on `v24.14.1`)
- **Package Manager:** npm `>= 10.0.0`

---

## Quickstart

### 1. Install Dependencies

From the repository root:

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
# Recommended: Place in backend workspace
cp apps/backend/.env.example apps/backend/.env

# Or place at repository root (also supported):
# cp apps/backend/.env.example .env
```

The configuration loader automatically detects `.env` in `apps/backend/.env`, the repository root, or the current working directory, while ensuring existing shell variables always take precedence.

Default variables:
```dotenv
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# AI Provider Configuration
# Options: "mock" (default, ₹0 local test mock) or "gemini" (Google Gemini Developer API)
AI_PROVIDER=mock

# Google Gemini API Configuration (Required when AI_PROVIDER=gemini)
# Acquire a free API key with zero billing from Google AI Studio: https://aistudio.google.com/apikey
GEMINI_API_KEY=your_gemini_api_key_here

# Gemini Model Identifier (Free-tier eligible model)
GEMINI_MODEL=gemini-2.5-flash
```

### 3. AI Provider Setup (Mock vs. Gemini Free Tier)

ATLAS supports two providers via the `AI_PROVIDER` environment variable:

1. **`mock` (Default, ₹0, Zero-Setup):**
   - Requires no API keys or internet connection.
   - Generates predictable test responses with simulated multi-chunk streaming.
   - Ideal for automated testing, offline development, and rapid UI prototyping.

2. **`gemini` (Google Gemini Developer API Free Tier, ₹0):**
   - Connects to Google's Gemini API via the official `@google/genai` SDK.
   - **Model Used:** `gemini-2.5-flash` (free-tier eligible multimodal model).
   - **Cost:** **₹0 / $0.00**. Requires no credit card or paid billing account.
   - **Rate Limits on Free Tier:** Subject to project-wide free tier caps (~15 Requests Per Minute, 250,000 Tokens Per Minute, and daily limits on Google AI Studio).
   - **Setup:**
     1. Generate a free API key at [Google AI Studio](https://aistudio.google.com/apikey).
     2. Set in your `.env`:
        ```dotenv
        AI_PROVIDER=gemini
        GEMINI_API_KEY=AIzaSy...
        GEMINI_MODEL=gemini-2.5-flash
        ```
     3. Start the backend (`npm run dev`).
   - If the free tier limit is exceeded, ATLAS returns a structured `GEMINI_QUOTA_EXCEEDED` error without ever charging or switching to paid APIs.

### 4. Run Development Server (with Auto-Reload)

```bash
npm run dev
```

The backend server will start listening on `http://0.0.0.0:3000`.

### 5. Verify the Health Endpoint

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-11-12T08:45:55.016Z",
  "uptime": 7.177,
  "environment": "development",
  "version": "0.1.0"
}
```

### 6. Run Automated Tests

```bash
npm test
```

Tests run in-memory via Node's native test runner without consuming API quota:
```bash
ℹ tests 49
ℹ suites 5
ℹ pass 49
ℹ fail 0
```

### 7. Build and Run for Production

```bash
# Compile TypeScript to dist/
npm run build

# Start the compiled production server
npm start
```

---

## Available Commands

From repository root:

| Command | Action |
| :--- | :--- |
| `npm install` | Install all dependencies across workspaces |
| `npm run dev` | Start backend in development mode with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript backend to JavaScript in `dist/` |
| `npm start` | Run compiled production backend (`node dist/server.js`) |
| `npm test` | Run automated test suite |
| `npm run typecheck` | Run TypeScript compiler type checking without emitting files |

*(You can also `cd apps/backend` and run any of these commands directly.)*

---

## Documentation Links

- [Product Vision](docs/PRODUCT_VISION.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [API Contract](docs/API_CONTRACT.md)
- [Technical Decisions](docs/TECHNICAL_DECISIONS.md)
- [Development Log](docs/DEVELOPMENT_LOG.md)

