package com.atlas.ai.network

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.annotations.SerializedName
import java.time.Instant

/**
 * ATLAS WebSocket Protocol Messages
 *
 * Implements bidirectional contract definitions matching apps/backend/src/types/protocol.ts
 */

// ---------------------------------------------------------------------------
// Base & Marker Interfaces
// ---------------------------------------------------------------------------

sealed interface ProtocolMessage {
    val type: String
    val timestamp: String
    val sessionId: String?
    val requestId: String?
}

sealed interface ClientMessage : ProtocolMessage
sealed interface ServerMessage : ProtocolMessage

// ---------------------------------------------------------------------------
// Client Messages (Android -> ATLAS Backend)
// ---------------------------------------------------------------------------

data class ClientSessionStart(
    @SerializedName("type") override val type: String = "client.session.start",
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload = Payload()
) : ClientMessage {
    data class Payload(
        @SerializedName("clientName") val clientName: String = "ATLAS-Android",
        @SerializedName("clientVersion") val clientVersion: String = "0.1.0",
        @SerializedName("language") val language: String = "en"
    )
}

data class ClientSessionEnd(
    @SerializedName("type") override val type: String = "client.session.end",
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload = Payload()
) : ClientMessage {
    data class Payload(
        @SerializedName("reason") val reason: String = "user_exit"
    )
}

data class ClientMessageSend(
    @SerializedName("type") override val type: String = "client.message.send",
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ClientMessage {
    data class Payload(
        @SerializedName("text") val text: String
    )
}

data class ClientInterrupt(
    @SerializedName("type") override val type: String = "client.interrupt",
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload = Payload()
) : ClientMessage {
    data class Payload(
        @SerializedName("reason") val reason: String = "user_barge_in",
        @SerializedName("timestampMs") val timestampMs: Long = System.currentTimeMillis()
    )
}

data class ClientVoiceCommit(
    @SerializedName("type") override val type: String = "client.voice.commit",
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload = Payload()
) : ClientMessage {
    data class Payload(
        @SerializedName("text") val text: String? = null
    )
}

data class SessionUpdate(
    @SerializedName("type") override val type: String = "session.update",
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload = Payload()
) : ClientMessage {
    data class Payload(
        @SerializedName("audioFormat") val audioFormat: String = "pcm16",
        @SerializedName("sampleRate") val sampleRate: Int = 16000,
        @SerializedName("channels") val channels: Int = 1,
        @SerializedName("language") val language: String = "en"
    )
}

data class ClientPing(
    @SerializedName("type") override val type: String = "client.ping",
    @SerializedName("timestamp") override val timestamp: String = Instant.now().toString(),
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Map<String, Any> = emptyMap()
) : ClientMessage

// ---------------------------------------------------------------------------
// Server Messages (ATLAS Backend -> Android)
// ---------------------------------------------------------------------------

data class ServerReady(
    @SerializedName("type") override val type: String = "server.ready",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("connectionId") val connectionId: String,
        @SerializedName("protocolVersion") val protocolVersion: String,
        @SerializedName("serverTime") val serverTime: String
    )
}

data class ServerSessionStarted(
    @SerializedName("type") override val type: String = "server.session.started",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("sessionId") val sessionId: String,
        @SerializedName("createdAt") val createdAt: String
    )
}

data class ServerSessionEnded(
    @SerializedName("type") override val type: String = "server.session.ended",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload? = null
) : ServerMessage {
    data class Payload(
        @SerializedName("sessionId") val sessionId: String,
        @SerializedName("endedAt") val endedAt: String,
        @SerializedName("reason") val reason: String? = null
    )
}

data class ServerResponseStarted(
    @SerializedName("type") override val type: String = "server.response.started",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("responseId") val responseId: String
    )
}

data class ServerResponseDelta(
    @SerializedName("type") override val type: String = "server.response.delta",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("responseId") val responseId: String,
        @SerializedName("delta") val delta: String,
        @SerializedName("index") val index: Int
    )
}

data class ServerResponseCompleted(
    @SerializedName("type") override val type: String = "server.response.completed",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("responseId") val responseId: String,
        @SerializedName("text") val text: String
    )
}

data class ServerResponseCancelled(
    @SerializedName("type") override val type: String = "server.response.cancelled",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("reason") val reason: String,
        @SerializedName("responseId") val responseId: String? = null
    )
}

data class ServerGenerationCancelled(
    @SerializedName("type") override val type: String = "server.generation_cancelled",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("reason") val reason: String,
        @SerializedName("cancelledActiveGeneration") val cancelledActiveGeneration: Boolean = true,
        @SerializedName("details") val details: String? = null
    )
}

data class ServerTranscript(
    @SerializedName("type") override val type: String = "server.transcript",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("text") val text: String,
        @SerializedName("isFinal") val isFinal: Boolean = false
    )
}

data class ServerAudioChunk(
    @SerializedName("type") override val type: String = "server.audio.chunk",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("responseId") val responseId: String,
        @SerializedName("index") val index: Int,
        @SerializedName("audio") val audio: String,
        @SerializedName("mimeType") val mimeType: String = "audio/mp3",
        @SerializedName("text") val text: String? = null,
        @SerializedName("language") val language: String? = null,
        @SerializedName("voice") val voice: String? = null,
        @SerializedName("intent") val intent: String? = null,
        @SerializedName("isFinal") val isFinal: Boolean = false
    )
}

data class ServerError(
    @SerializedName("type") override val type: String = "server.error",
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    @SerializedName("payload") val payload: Payload
) : ServerMessage {
    data class Payload(
        @SerializedName("code") val code: String,
        @SerializedName("message") val message: String
    )
}

data class UnknownServerMessage(
    @SerializedName("type") override val type: String,
    @SerializedName("timestamp") override val timestamp: String,
    @SerializedName("sessionId") override val sessionId: String? = null,
    @SerializedName("requestId") override val requestId: String? = null,
    val rawJson: String
) : ServerMessage

// ---------------------------------------------------------------------------
// Protocol Parser & Serializer
// ---------------------------------------------------------------------------

object ProtocolParser {
    private val gson = Gson()

    fun toJson(message: ClientMessage): String {
        return gson.toJson(message)
    }

    fun parseServerMessage(jsonString: String): ServerMessage? {
        return try {
            val jsonElement = JsonParser.parseString(jsonString)
            if (!jsonElement.isJsonObject) return null
            val obj = jsonElement.asJsonObject
            val type = obj.get("type")?.asString ?: return null

            when (type) {
                "server.ready" -> gson.fromJson(jsonString, ServerReady::class.java)
                "server.session.started" -> gson.fromJson(jsonString, ServerSessionStarted::class.java)
                "server.session.ended" -> gson.fromJson(jsonString, ServerSessionEnded::class.java)
                "server.response.started" -> gson.fromJson(jsonString, ServerResponseStarted::class.java)
                "server.response.delta" -> gson.fromJson(jsonString, ServerResponseDelta::class.java)
                "server.response.completed" -> gson.fromJson(jsonString, ServerResponseCompleted::class.java)
                "server.response.cancelled" -> gson.fromJson(jsonString, ServerResponseCancelled::class.java)
                "server.generation_cancelled" -> gson.fromJson(jsonString, ServerGenerationCancelled::class.java)
                "server.transcript" -> gson.fromJson(jsonString, ServerTranscript::class.java)
                "server.audio.chunk" -> gson.fromJson(jsonString, ServerAudioChunk::class.java)
                "server.error" -> gson.fromJson(jsonString, ServerError::class.java)
                else -> {
                    val timestamp = obj.get("timestamp")?.asString ?: Instant.now().toString()
                    val sessionId = obj.get("sessionId")?.asString
                    val requestId = obj.get("requestId")?.asString
                    UnknownServerMessage(
                        type = type,
                        timestamp = timestamp,
                        sessionId = sessionId,
                        requestId = requestId,
                        rawJson = jsonString
                    )
                }
            }
        } catch (e: Exception) {
            null
        }
    }
}

