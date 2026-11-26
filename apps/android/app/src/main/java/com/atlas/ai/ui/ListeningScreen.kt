package com.atlas.ai.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
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
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

// ---------------------------------------------------------------------------
// Starfield Background Particle Data
// ---------------------------------------------------------------------------
private data class CosmicStar(
    val xRel: Float,
    val yRel: Float,
    val size: Float,
    val baseAlpha: Float,
    val speed: Float,
    val colorIdx: Int
)

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

    // Full-screen living cosmic container
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(BackgroundDark)
    ) {
        // 1. Full-Screen Living Cosmic Starfield & HUD Cyber Grid Layer
        CosmicStarfieldBackground(modifier = Modifier.fillMaxSize())

        // 2. Main Holographic HUD UI Frame
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Color.Transparent,
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

                // 3. Audio-Reactive Holographic Arc Reactor & Particle Core
                HolographicCoreVisualizer(
                    assistantState = assistantState,
                    isRecording = isRecording,
                    audioRms = audioRms
                )

                // 4. Glassmorphic Transcript Card & Telemetry State
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
}

/**
 * 60fps Living Cosmic Starfield & Sci-Fi HUD Grid Background.
 */
@Composable
private fun CosmicStarfieldBackground(modifier: Modifier = Modifier) {
    val stars = remember {
        val rand = Random(42)
        List(140) {
            CosmicStar(
                xRel = rand.nextFloat(),
                yRel = rand.nextFloat(),
                size = rand.nextFloat() * 2.8f + 1.2f,
                baseAlpha = rand.nextFloat() * 0.4f + 0.3f,
                speed = rand.nextFloat() * 1.5f + 0.5f,
                colorIdx = rand.nextInt(4)
            )
        }
    }

    val infiniteTransition = rememberInfiniteTransition(label = "starTwinkle")
    val twinklePhase by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = (2 * PI).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 9000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "twinklePhase"
    )

    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // 1. Subtle Radial Cosmic Bloom behind upper visualizer
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    AccentCyan.copy(alpha = 0.09f),
                    Color(0xFF7C3AED).copy(alpha = 0.04f),
                    Color.Transparent
                ),
                center = Offset(w * 0.5f, h * 0.35f),
                radius = w * 0.75f
            )
        )

        // 2. Subtle Sci-Fi Grid lines
        val gridStep = 55.dp.toPx()
        var curY = 0f
        while (curY < h) {
            drawLine(
                color = AccentCyan.copy(alpha = 0.02f),
                start = Offset(0f, curY),
                end = Offset(w, curY),
                strokeWidth = 1f
            )
            curY += gridStep
        }
        var curX = 0f
        while (curX < w) {
            drawLine(
                color = AccentCyan.copy(alpha = 0.02f),
                start = Offset(curX, 0f),
                end = Offset(curX, h),
                strokeWidth = 1f
            )
            curX += gridStep
        }

        // 3. Twinkling Stars
        stars.forEach { star ->
            val osc = sin(twinklePhase * star.speed + star.xRel * 10f)
            val alpha = (star.baseAlpha + 0.3f * osc).coerceIn(0.15f, 0.95f)

            val color = when (star.colorIdx) {
                0 -> Color.White
                1 -> AccentCyan
                2 -> Color(0xFFC084FC) // Violet/Purple
                else -> Color(0xFFFDE68A) // Soft Gold
            }

            drawCircle(
                color = color.copy(alpha = alpha),
                radius = star.size,
                center = Offset(star.xRel * w, star.yRel * h)
            )
        }

        // 4. Sci-Fi Corner Brackets
        val bSize = 22.dp.toPx()
        val bOffset = 14.dp.toPx()
        val bracketColor = AccentCyan.copy(alpha = 0.45f)
        val bStroke = 1.8f

        // Top-Left L
        drawLine(bracketColor, Offset(bOffset, bOffset), Offset(bOffset + bSize, bOffset), bStroke)
        drawLine(bracketColor, Offset(bOffset, bOffset), Offset(bOffset, bOffset + bSize), bStroke)

        // Top-Right L
        drawLine(bracketColor, Offset(w - bOffset, bOffset), Offset(w - bOffset - bSize, bOffset), bStroke)
        drawLine(bracketColor, Offset(w - bOffset, bOffset), Offset(w - bOffset, bOffset + bSize), bStroke)

        // Bottom-Left L
        drawLine(bracketColor, Offset(bOffset, h - bOffset), Offset(bOffset + bSize, h - bOffset), bStroke)
        drawLine(bracketColor, Offset(bOffset, h - bOffset), Offset(bOffset, h - bOffset - bSize), bStroke)

        // Bottom-Right L
        drawLine(bracketColor, Offset(w - bOffset, h - bOffset), Offset(w - bOffset - bSize, h - bOffset), bStroke)
        drawLine(bracketColor, Offset(w - bOffset, h - bOffset), Offset(w - bOffset, h - bOffset - bSize), bStroke)
    }
}

/**
 * Multi-Ring Audio-Reactive Holographic Arc Reactor & Plasma Core.
 */
@Composable
private fun HolographicCoreVisualizer(
    assistantState: AtlasWebSocketClient.AssistantState,
    isRecording: Boolean,
    audioRms: Float
) {
    val infiniteTransition = rememberInfiniteTransition(label = "coreChoreography")

    // Slow organic breathing
    val breathScale by infiniteTransition.animateFloat(
        initialValue = 1.0f,
        targetValue = 1.12f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1600, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "breathScale"
    )

    // Outer ring clockwise rotation
    val rotationOuter by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(
                durationMillis = if (assistantState == AtlasWebSocketClient.AssistantState.THINKING) 3000 else 14000,
                easing = LinearEasing
            ),
            repeatMode = RepeatMode.Restart
        ),
        label = "rotationOuter"
    )

    // Inner ring counter-clockwise rotation
    val rotationInner by infiniteTransition.animateFloat(
        initialValue = 360f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(
            animation = tween(
                durationMillis = if (assistantState == AtlasWebSocketClient.AssistantState.THINKING) 2400 else 10000,
                easing = LinearEasing
            ),
            repeatMode = RepeatMode.Restart
        ),
        label = "rotationInner"
    )

    val dynamicAudioScale = (1.0f + audioRms * 1.6f).coerceIn(1.0f, 1.85f)
    val effectiveScale = if (isRecording || assistantState == AtlasWebSocketClient.AssistantState.SPEAKING)
        dynamicAudioScale
    else
        breathScale

    // Theme color shifting based on state
    val corePrimaryColor by animateColorAsState(
        targetValue = when {
            assistantState == AtlasWebSocketClient.AssistantState.SPEAKING -> Color(0xFF00B0FF)
            assistantState == AtlasWebSocketClient.AssistantState.THINKING -> AccentOrange
            isRecording -> AccentGreen
            else -> AccentCyan
        },
        label = "corePrimaryColor"
    )

    val coreSecondaryColor by animateColorAsState(
        targetValue = when {
            assistantState == AtlasWebSocketClient.AssistantState.SPEAKING -> Color(0xFFA855F7) // Violet
            assistantState == AtlasWebSocketClient.AssistantState.THINKING -> Color(0xFFF59E0B) // Gold
            isRecording -> AccentCyan
            else -> Color(0xFF38BDF8) // Sky blue
        },
        label = "coreSecondaryColor"
    )

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(220.dp)
            .scale(effectiveScale)
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val center = Offset(size.width / 2f, size.height / 2f)
            val maxR = size.width / 2f

            // 1. Outer Radial Aura Bloom
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        corePrimaryColor.copy(alpha = 0.4f),
                        coreSecondaryColor.copy(alpha = 0.12f),
                        Color.Transparent
                    ),
                    center = center,
                    radius = maxR * 0.95f
                ),
                radius = maxR * 0.95f,
                center = center
            )

            // 2. Segmented Outer Arc Reactor Ring (Clockwise)
            rotate(rotationOuter, pivot = center) {
                val outerR = maxR * 0.82f
                // Draw 3 primary telemetry arcs
                val arcSweep = 75f
                for (i in 0 until 3) {
                    val startAngle = i * 120f
                    drawArc(
                        color = corePrimaryColor.copy(alpha = 0.75f),
                        startAngle = startAngle,
                        sweepAngle = arcSweep,
                        useCenter = false,
                        topLeft = Offset(center.x - outerR, center.y - outerR),
                        size = Size(outerR * 2, outerR * 2),
                        style = Stroke(width = 2.5f, cap = StrokeCap.Round)
                    )
                }

                // 24 Degree Tick Marks
                val tickR1 = outerR - 4f
                val tickR2 = outerR + 4f
                for (i in 0 until 24) {
                    val rad = (i * 15f) * (PI / 180f).toFloat()
                    val p1 = Offset(center.x + cos(rad) * tickR1, center.y + sin(rad) * tickR1)
                    val p2 = Offset(center.x + cos(rad) * tickR2, center.y + sin(rad) * tickR2)
                    drawLine(
                        color = coreSecondaryColor.copy(alpha = 0.5f),
                        start = p1,
                        end = p2,
                        strokeWidth = 1.2f
                    )
                }
            }

            // 3. Segmented Middle Telemetry Ring (Counter-Clockwise)
            rotate(rotationInner, pivot = center) {
                val midR = maxR * 0.62f
                val arcSweep = 50f
                for (i in 0 until 4) {
                    val startAngle = i * 90f + 15f
                    drawArc(
                        color = coreSecondaryColor.copy(alpha = 0.65f),
                        startAngle = startAngle,
                        sweepAngle = arcSweep,
                        useCenter = false,
                        topLeft = Offset(center.x - midR, center.y - midR),
                        size = Size(midR * 2, midR * 2),
                        style = Stroke(width = 2f, cap = StrokeCap.Round)
                    )
                }

                // Orbiting satellite dots
                for (i in 0 until 6) {
                    val rad = (i * 60f) * (PI / 180f).toFloat()
                    val dotPos = Offset(center.x + cos(rad) * midR, center.y + sin(rad) * midR)
                    drawCircle(
                        color = Color.White.copy(alpha = 0.9f),
                        radius = 2.4f,
                        center = dotPos
                    )
                }
            }

            // 4. Audio-Reactive Plasma Ring (Expands & Ripples on Voice RMS)
            val audioWaveR = maxR * 0.44f + (audioRms * 22f)
            val wavePath = Path()
            val points = 32
            for (i in 0 until points) {
                val angle = (i.toFloat() / points) * (2 * PI).toFloat()
                val waveDistort = if (isRecording || audioRms > 0.05f) {
                    sin(angle * 6f + rotationOuter * 0.1f) * (audioRms * 8f)
                } else 0f
                val r = audioWaveR + waveDistort
                val px = center.x + cos(angle) * r
                val py = center.y + sin(angle) * r
                if (i == 0) wavePath.moveTo(px, py) else wavePath.lineTo(px, py)
            }
            wavePath.close()

            drawPath(
                path = wavePath,
                color = corePrimaryColor.copy(alpha = 0.85f),
                style = Stroke(width = 2.2f)
            )

            // 5. White-Hot Glowing Central Nucleus
            val nucleusR = maxR * 0.28f
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        Color.White,
                        corePrimaryColor,
                        coreSecondaryColor.copy(alpha = 0.6f),
                        Color.Transparent
                    ),
                    center = center,
                    radius = nucleusR
                ),
                radius = nucleusR,
                center = center
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
            containerColor = if (isWakeWordRunning) AccentCyan.copy(alpha = 0.14f) else Color(0x99151B26)
        ),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = Brush.horizontalGradient(
                if (isWakeWordRunning)
                    listOf(AccentCyan.copy(alpha = 0.6f), AccentCyan.copy(alpha = 0.2f))
                else
                    listOf(SurfaceVariantDark.copy(alpha = 0.8f), SurfaceVariantDark.copy(alpha = 0.3f))
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
            .height(145.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xCC0E1524)),
        shape = RoundedCornerShape(16.dp),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = Brush.horizontalGradient(
                listOf(AccentCyan.copy(alpha = 0.45f), AccentCyan.copy(alpha = 0.1f), Color.Transparent)
            )
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stateLabel,
                    color = AccentCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "LIVE RESPONSE STREAM",
                    color = TextTertiary,
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 1.sp
                )
            }

            Spacer(modifier = Modifier.height(6.dp))

            val scrollState = rememberScrollState()
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
            ) {
                Text(
                    text = if (streamingText.isNotBlank()) streamingText else "Tap the mic or say 'Hey Atlas' to talk...",
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
            text = "🔍 SQLite Recall",
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
            .background(Color(0x991E2638))
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
                focusedContainerColor = Color(0xCC0E1524),
                unfocusedContainerColor = Color(0xCC0E1524),
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

        // 2. Primary Mic Toggle Button (with Glowing HUD ring)
        Button(
            onClick = onToggleRecording,
            enabled = isConnected,
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isRecording) AccentRed else AccentCyan,
                contentColor = BackgroundDark,
                disabledContainerColor = SurfaceVariantDark
            ),
            modifier = Modifier
                .size(64.dp)
                .border(2.dp, if (isRecording) AccentRed.copy(alpha = 0.5f) else AccentCyan.copy(alpha = 0.5f), CircleShape)
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
                containerColor = Color(0x991E2638),
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
