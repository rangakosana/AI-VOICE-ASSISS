# ATLAS Android Client (Phase D)

The ATLAS Android client application provides a low-latency, real-time voice interface connecting to the ATLAS backend gateway (`ws://10.0.2.2:3000/v1/realtime` for Android Emulator).

---

## Architecture Overview

```
apps/android/
├── app/
│   ├── build.gradle.kts                   # Target SDK 34, Compose, OkHttp, Coroutines
│   └── src/main/
│       ├── AndroidManifest.xml            # Audio, Internet, Foreground Service permissions
│       ├── res/
│       │   ├── xml/
│       │   │   └── network_security_config.xml # Cleartext bypass for 10.0.2.2 & localhost
│       │   └── values/
│       │       ├── colors.xml & themes.xml     # ATLAS Cyber/Slate dark theme
│       │       └── strings.xml
│       └── java/com/atlas/ai/
│           ├── AtlasApplication.kt            # Android Application class
│           ├── MainActivity.kt                # UI host, lifecycle & permission manager
│           ├── network/
│           │   ├── ProtocolMessages.kt        # JSON contracts matching backend protocol.ts
│           │   └── AtlasWebSocketClient.kt    # OkHttp client, binary audio streaming, barge-in
│           ├── audio/
│           │   ├── AudioConfig.kt             # 16kHz, 16-bit PCM, Mono specs
│           │   └── AudioRecorder.kt           # Native AudioRecord capture & RMS calculation
│           └── ui/
│               ├── theme/ (Color.kt, Theme.kt)# Jetpack Compose Material 3 dark styling
│               └── ListeningScreen.kt         # Reactive audio orb, transcript & controls
```

---

## Key Capabilities

1. **Real-time Bidirectional WebSocket Transport:**
   - Powered by OkHttp with automatic exponential backoff reconnection (1s -> 2s -> 4s -> 8s -> 16s).
   - Structured JSON envelope contracts (`client.session.start`, `client.message.send`, `session.update`, `client.interrupt`).

2. **Binary PCM Audio Streaming:**
   - `AudioRecorder` streams 16 kHz, 16-bit PCM mono chunks directly over WebSocket binary frames (`ByteString`).
   - Dynamic RMS audio level calculation powers an animated Compose voice orb.

3. **Barge-In Interruption Support:**
   - Dedicated interrupt control emits `client.interrupt` with `reason = "user_barge_in"`.
   - The backend gateway immediately halts active Gemini model token generation and emits `server.generation_cancelled`.

4. **Security & Local Emulation:**
   - Network Security Config allows cleartext HTTP/WS strictly for `10.0.2.2` and `localhost` during development.
   - Production builds require strict TLS 1.3 (`https://` and `wss://`).

---

## How to Run in Android Studio

1. **Start the ATLAS Backend Server:**
   ```bash
   cd "/Users/rangakosana/VOICE ASSISTANT"
   npm run dev
   ```
   Verify that `http://localhost:3000/health` responds with `{"status":"ok"}`.

2. **Open the Android Project:**
   - Launch **Android Studio** (Hedgehog 2023.1.1+ / Iguana / Jellyfish / Koala).
   - Select **Open** and choose `/Users/rangakosana/VOICE ASSISTANT/apps/android`.
   - Allow Gradle to sync dependencies.

3. **Run on Android Emulator:**
   - Start an Android Emulator running API 34 (Android 14) or API 33.
   - Click **Run 'app'** (`Shift + F10`).
   - Grant microphone permission when prompted.
   - The app will automatically connect to `ws://10.0.2.2:3000/v1/realtime` and initiate session handshaking.
