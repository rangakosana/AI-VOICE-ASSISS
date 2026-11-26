package com.atlas.ai.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = AccentCyan,
    secondary = AccentNeonBlue,
    background = BackgroundDark,
    surface = SurfaceDark,
    surfaceVariant = SurfaceVariantDark,
    onPrimary = BackgroundDark,
    onSecondary = BackgroundDark,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    error = AccentRed
)

@Composable
fun AtlasTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}

