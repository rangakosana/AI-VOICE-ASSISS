package com.atlas.ai.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.atlas.ai.network.AtlasWebSocketClient
import com.atlas.ai.ui.theme.AccentCyan
import com.atlas.ai.ui.theme.AccentGreen
import com.atlas.ai.ui.theme.AccentNeonBlue
import com.atlas.ai.ui.theme.AccentOrange
import com.atlas.ai.ui.theme.AccentRed
import com.atlas.ai.ui.theme.BackgroundDark
import com.atlas.ai.ui.theme.SurfaceDark
import com.atlas.ai.ui.theme.SurfaceVariantDark
import com.atlas.ai.ui.theme.TextPrimary
import com.atlas.ai.ui.theme.TextSecondary
import com.atlas.ai.ui.theme.TextTertiary

@Composable
fun ListeningScreen(
    connectionStatus: AtlasWebSocketClient.ConnectionStatus,
    assistantState: AtlasWebSocketClient.AssistantState,
    isRecording: Boolean,
    audioRms: Float,
    streamingText: String,
    sessionId: String?,
    serverUrl: String,
    currentLanguage: String = "en",
    isWakeWordRunning: Boolean,
    onSendMessage: (String) -> Unit,
    onToggleRecording: () -> Unit,
    onInterrupt: () -> Unit,
    onNewSession: () -> Unit,
    onReconnect: () -> Unit,
    onChangeServerUrl: (String) -> Unit,
    onToggleWakeWord: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    var showHostDialog by remember { mutableStateOf(false) }
    var chatInputText by remember { mutableStateOf("") }

    if (showHostDialog) {
        HostSettingsDialog(
            currentUrl = serverUrl,
            onDismiss = { showHostDialog = false },
            onSave = { newUrl ->
                onChangeServerUrl(newUrl)
                showHostDialog = false
            }
        )
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = BackgroundDark,
        contentWindowInsets = WindowInsets.safeDrawing
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 20.dp, vertical = 6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // 1. Header: Branding, Host, Status & Language & Reconnect
            HeaderSection(
                connectionStatus = connectionStatus,
                sessionId = sessionId,
                currentLanguage = currentLanguage,
                onOpenHostSettings = { showHostDialog = true },
                onReconnect = onReconnect
            )

            // 2. Background Wake-Word ("Hey Atlas") Activation Toggle
            WakeWordBar(
                isWakeWordRunning = isWakeWordRunning,
                onToggleWakeWord = onToggleWakeWord
            )

            // 3. Animated AI Orb Visualizer
            OrbVisualizer(
                assistantState = assistantState,
                isRecording = isRecording,
                audioRms = audioRms
            )

            // 4. Transcript Card & State Header
            TranscriptSection(
                assistantState = assistantState,
                streamingText = streamingText
            )

            // 5. Quick Prompt Pills
            QuickPromptsRow(
                onSelectPrompt = { prompt ->
                    onSendMessage(prompt)
                }
            )

            // 6. Text / Chat Input Bar
            ChatInputBar(
                inputText = chatInputText,
                onInputChanged = { chatInputText = it },
                onSend = {
                    if (chatInputText.isNotBlank()) {
                        onSendMessage(chatInputText.trim())
                        chatInputText = ""
                    }
                },
                isEnabled = connectionStatus == AtlasWebSocketClient.ConnectionStatus.CONNECTED
            )

            // 7. Action Controls: Interrupt, Mic, New Session
            ControlsSection(
                connectionStatus = connectionStatus,
                assistantState = assistantState,
                isRecording = isRecording,
                onToggleRecording = onToggleRecording,
                onInterrupt = onInterrupt,
                onNewSession = onNewSession
            )
        }
    }
}

@Composable
private fun WakeWordBar(
    isWakeWordRunning: Boolean,
    onToggleWakeWord: (Boolean) -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable { onToggleWakeWord(!isWakeWordRunning) },
        colors = CardDefaults.cardColors(
            containerColor = if (isWakeWordRunning) AccentCyan.copy(alpha = 0.12f) else SurfaceVariantDark.copy(alpha = 0.5f)
        ),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = Brush.horizontalGradient(
                if (isWakeWordRunning)
                    listOf(AccentCyan.copy(alpha = 0.5f), AccentCyan.copy(alpha = 0.15f))
                else
                    listOf(SurfaceVariantDark, SurfaceVariantDark)
            )
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (isWakeWordRunning) AccentGreen else AccentOrange)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        text = if (isWakeWordRunning) "Wake Word: 'Hey Atlas' Active" else "Wake Word: Inactive",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isWakeWordRunning) AccentCyan else TextSecondary
                    )
                    Text(
                        text = if (isWakeWordRunning) "Listening in background & on lock screen" else "Tap toggle to enable background listening",
                        fontSize = 9.sp,
                        color = TextTertiary
                    )
                }
            }
            Switch(
                checked = isWakeWordRunning,
                onCheckedChange = onToggleWakeWord,
                modifier = Modifier.scale(0.75f),
                colors = SwitchDefaults.colors(
                    checkedThumbColor = BackgroundDark,
                    checkedTrackColor = AccentCyan,
                    uncheckedThumbColor = TextTertiary,
                    uncheckedTrackColor = SurfaceDark
                )
            )
        }
    }
}

@Composable
private fun HeaderSection(
    connectionStatus: AtlasWebSocketClient.ConnectionStatus,
    sessionId: String?,
    currentLanguage: String,
    onOpenHostSettings: () -> Unit,
    onReconnect: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text(
                text = "ATLAS",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                color = AccentCyan,
                letterSpacing = 2.sp
            )
            Text(
                text = if (sessionId != null) "Session: ${sessionId.take(8)}..." else "No Active Session",
                fontSize = 11.sp,
                color = TextTertiary,
                fontFamily = FontFamily.Monospace
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            // Language pill (EN / TE)
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(AccentCyan.copy(alpha = 0.15f))
                    .border(1.dp, AccentCyan.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Text(
                    text = currentLanguage.uppercase(),
                    color = AccentCyan,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            val statusColor = when (connectionStatus) {
                AtlasWebSocketClient.ConnectionStatus.CONNECTED -> AccentGreen
                AtlasWebSocketClient.ConnectionStatus.CONNECTING -> AccentOrange
                AtlasWebSocketClient.ConnectionStatus.RECONNECTING -> AccentOrange
                AtlasWebSocketClient.ConnectionStatus.DISCONNECTED -> AccentRed
            }

            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(statusColor.copy(alpha = 0.15f))
                    .border(1.dp, statusColor.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Text(
                    text = connectionStatus.name,
                    color = statusColor,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }

            IconButton(
                onClick = onOpenHostSettings,
                modifier = Modifier.size(32.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Settings,
                    contentDescription = "Host Settings",
                    tint = TextSecondary,
                    modifier = Modifier.size(18.dp)
                )
            }

            if (connectionStatus == AtlasWebSocketClient.ConnectionStatus.DISCONNECTED) {
                IconButton(
                    onClick = onReconnect,
                    modifier = Modifier.size(32.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Reconnect",
                        tint = AccentCyan,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun OrbVisualizer(
    assistantState: AtlasWebSocketClient.AssistantState,
    isRecording: Boolean,
    audioRms: Float
) {
    val infiniteTransition = rememberInfiniteTransition(label = "orbPulse")

    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 1.0f,
        targetValue = 1.15f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1400, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulseScale"
    )

    val dynamicAudioScale = (1.0f + audioRms * 1.5f).coerceIn(1.0f, 1.8f)
    val effectiveScale = if (isRecording) dynamicAudioScale else pulseScale

    val orbColor by animateColorAsState(
        targetValue = when {
            assistantState == AtlasWebSocketClient.AssistantState.SPEAKING -> AccentNeonBlue
            assistantState == AtlasWebSocketClient.AssistantState.THINKING -> AccentOrange
            isRecording -> AccentGreen
            else -> AccentCyan
        },
        label = "orbColor"
    )

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.size(190.dp)
    ) {
        Box(
            modifier = Modifier
                .size(160.dp)
                .scale(effectiveScale)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            orbColor.copy(alpha = 0.35f),
                            orbColor.copy(alpha = 0.05f),
                            Color.Transparent
                        )
                    )
                )
        )

        Box(
            modifier = Modifier
                .size(105.dp)
                .scale(if (isRecording) dynamicAudioScale else 1.0f)
                .clip(CircleShape)
                .border(2.dp, orbColor.copy(alpha = 0.6f), CircleShape)
        )

        Box(
            modifier = Modifier
                .size(65.dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            Color.White,
                            orbColor,
                            orbColor.copy(alpha = 0.7f)
                        )
                    )
                )
        )
    }
}

@Composable
private fun TranscriptSection(
    assistantState: AtlasWebSocketClient.AssistantState,
    streamingText: String
) {
    val stateLabel = when (assistantState) {
        AtlasWebSocketClient.AssistantState.IDLE -> "Ready"
        AtlasWebSocketClient.AssistantState.LISTENING -> "Listening..."
        AtlasWebSocketClient.AssistantState.THINKING -> "Thinking..."
        AtlasWebSocketClient.AssistantState.SPEAKING -> "Speaking..."
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .height(150.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceDark),
        shape = RoundedCornerShape(16.dp),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = Brush.linearGradient(
                listOf(AccentCyan.copy(alpha = 0.3f), Color.Transparent)
            )
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(14.dp)
        ) {
            Text(
                text = stateLabel,
                color = AccentCyan,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium
            )

            Spacer(modifier = Modifier.height(6.dp))

            val scrollState = rememberScrollState()
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
            ) {
                Text(
                    text = if (streamingText.isNotBlank()) streamingText else "Tap the mic or type below to talk with ATLAS...",
                    color = if (streamingText.isNotBlank()) TextPrimary else TextSecondary,
                    fontSize = 14.sp,
                    lineHeight = 20.sp
                )
            }
        }
    }
}

@Composable
private fun QuickPromptsRow(
    onSelectPrompt: (String) -> Unit
) {
    val scrollState = rememberScrollState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        PromptPill(
            text = "🔍 SQLite WAL Recall",
            onClick = { onSelectPrompt("What database architecture and PRAGMA settings did we decide on for ATLAS?") }
        )
        PromptPill(
            text = "⚡ Conciseness Check",
            onClick = { onSelectPrompt("Can you explain how Node.js buffer chunking works in 2 sentences?") }
        )
        PromptPill(
            text = "🔄 Topic Pivot",
            onClick = { onSelectPrompt("Switching topic completely: What's your favorite sport?") }
        )
    }
}

@Composable
private fun PromptPill(
    text: String,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(SurfaceVariantDark)
            .border(1.dp, SurfaceVariantDark.copy(alpha = 0.8f), RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp)
    ) {
        Text(
            text = text,
            fontSize = 11.sp,
            color = TextSecondary,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
private fun ChatInputBar(
    inputText: String,
    onInputChanged: (String) -> Unit,
    onSend: () -> Unit,
    isEnabled: Boolean
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedTextField(
            value = inputText,
            onValueChange = onInputChanged,
            placeholder = { Text("Prompt ATLAS...", color = TextTertiary, fontSize = 13.sp) },
            singleLine = true,
            enabled = isEnabled,
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = AccentCyan,
                unfocusedBorderColor = SurfaceVariantDark,
                focusedContainerColor = SurfaceDark,
                unfocusedContainerColor = SurfaceDark,
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary
            ),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() })
        )

        Spacer(modifier = Modifier.width(8.dp))

        IconButton(
            onClick = onSend,
            enabled = isEnabled && inputText.isNotBlank(),
            modifier = Modifier
                .size(46.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (isEnabled && inputText.isNotBlank()) AccentCyan else SurfaceVariantDark)
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.Send,
                contentDescription = "Send",
                tint = if (isEnabled && inputText.isNotBlank()) BackgroundDark else TextTertiary,
                modifier = Modifier.size(20.dp)
            )
        }
    }
}

@Composable
private fun ControlsSection(
    connectionStatus: AtlasWebSocketClient.ConnectionStatus,
    assistantState: AtlasWebSocketClient.AssistantState,
    isRecording: Boolean,
    onToggleRecording: () -> Unit,
    onInterrupt: () -> Unit,
    onNewSession: () -> Unit
) {
    val isConnected = connectionStatus == AtlasWebSocketClient.ConnectionStatus.CONNECTED
    val isSpeakingOrThinking = assistantState == AtlasWebSocketClient.AssistantState.SPEAKING ||
                               assistantState == AtlasWebSocketClient.AssistantState.THINKING

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // 1. Barge-in / Interrupt Button
        Button(
            onClick = onInterrupt,
            enabled = isConnected && isSpeakingOrThinking,
            colors = ButtonDefaults.buttonColors(
                containerColor = AccentRed.copy(alpha = 0.2f),
                contentColor = AccentRed,
                disabledContainerColor = SurfaceVariantDark.copy(alpha = 0.3f),
                disabledContentColor = TextTertiary
            ),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.height(46.dp)
        ) {
            Icon(
                imageVector = Icons.Default.StopCircle,
                contentDescription = "Interrupt",
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text("Stop", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }

        // 2. Primary Mic Toggle Button
        Button(
            onClick = onToggleRecording,
            enabled = isConnected,
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isRecording) AccentRed else AccentCyan,
                contentColor = BackgroundDark,
                disabledContainerColor = SurfaceVariantDark
            ),
            modifier = Modifier.size(64.dp)
        ) {
            Icon(
                imageVector = if (isRecording) Icons.Default.MicOff else Icons.Default.Mic,
                contentDescription = if (isRecording) "Stop Mic" else "Start Mic",
                modifier = Modifier.size(28.dp)
            )
        }

        // 3. New Session Button
        Button(
            onClick = onNewSession,
            enabled = isConnected,
            colors = ButtonDefaults.buttonColors(
                containerColor = SurfaceVariantDark,
                contentColor = TextSecondary,
                disabledContainerColor = SurfaceVariantDark.copy(alpha = 0.3f),
                disabledContentColor = TextTertiary
            ),
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.height(46.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Add,
                contentDescription = "New Session",
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text("New", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun HostSettingsDialog(
    currentUrl: String,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit
) {
    var customHost by remember { mutableStateOf(currentUrl) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Select Gateway Host", color = AccentCyan) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Pick target environment:",
                    color = TextSecondary,
                    fontSize = 12.sp
                )

                Button(
                    onClick = { onSave(AtlasWebSocketClient.DEFAULT_CLOUD_URL) },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentCyan.copy(alpha = 0.25f)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Render Cloud (ai-voice-assiss.onrender.com)", fontSize = 12.sp, color = AccentCyan, fontWeight = FontWeight.Bold)
                }

                Button(
                    onClick = { onSave(AtlasWebSocketClient.DEFAULT_PHYSICAL_DEVICE_URL) },
                    colors = ButtonDefaults.buttonColors(containerColor = SurfaceVariantDark),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Wi-Fi LAN (192.168.137.57:3000)", fontSize = 12.sp, color = TextPrimary)
                }

                Button(
                    onClick = { onSave(AtlasWebSocketClient.DEFAULT_EMULATOR_URL) },
                    colors = ButtonDefaults.buttonColors(containerColor = SurfaceVariantDark),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Android Emulator (10.0.2.2:3000)", fontSize = 12.sp, color = TextPrimary)
                }

                Button(
                    onClick = { onSave(AtlasWebSocketClient.DEFAULT_LOCALHOST_URL) },
                    colors = ButtonDefaults.buttonColors(containerColor = SurfaceVariantDark),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Localhost (127.0.0.1:3000)", fontSize = 12.sp, color = TextPrimary)
                }

                OutlinedTextField(
                    value = customHost,
                    onValueChange = { customHost = it },
                    label = { Text("Custom WebSocket URL") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(customHost) }) {
                Text("Apply", color = AccentCyan)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = TextSecondary)
            }
        },
        containerColor = SurfaceDark
    )
}
