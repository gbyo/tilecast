package org.tilecast.player.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.tilecast.player.network.PlayerBranding
import org.tilecast.player.network.PlayerPowerPolicy

internal enum class OutsideActiveHoursDisplay { BouncingLogo, CustomText, Black }

internal data class OutsideActiveHoursPresentation(
    val display: OutsideActiveHoursDisplay,
    val text: String = "",
)

internal fun outsideActiveHoursPresentation(
    power: PlayerPowerPolicy?,
    branding: PlayerBranding?,
): OutsideActiveHoursPresentation {
    val display = when (power?.outsideActiveHoursDisplay) {
        "bouncing_logo" -> OutsideActiveHoursDisplay.BouncingLogo
        "custom_text" -> OutsideActiveHoursDisplay.CustomText
        else -> OutsideActiveHoursDisplay.Black
    }
    val text = power?.outsideActiveHoursText.orEmpty().trim()
        .ifBlank { branding?.footerText.orEmpty().trim() }
        .ifBlank { "Powered by Tilecast" }
    return OutsideActiveHoursPresentation(display, text)
}

@Composable
internal fun OutsideActiveHoursScreen(
    power: PlayerPowerPolicy?,
    branding: PlayerBranding?,
    textColor: Color,
) {
    val presentation = outsideActiveHoursPresentation(power, branding)
    when (presentation.display) {
        OutsideActiveHoursDisplay.BouncingLogo -> BouncingTilecastLogo()
        OutsideActiveHoursDisplay.CustomText -> Box(
            Modifier.fillMaxSize().background(Color.Black).padding(80.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                presentation.text,
                color = textColor,
                fontSize = 42.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
        }
        OutsideActiveHoursDisplay.Black -> Box(Modifier.fillMaxSize().background(Color.Black))
    }
}

@Composable
private fun BouncingTilecastLogo() {
    val logoWidth = 250.dp
    val logoHeight = logoWidth * (CastLogoTiming.CANVAS_HEIGHT / CastLogoTiming.CANVAS_WIDTH)
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
        val maxX = (maxWidth - logoWidth).coerceAtLeast(0.dp).value
        val maxY = (maxHeight - logoHeight).coerceAtLeast(0.dp).value
        val movement = rememberInfiniteTransition(label = "outside-hours-logo")
        val x by movement.animateFloat(
            initialValue = 0f,
            targetValue = maxX,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 12_000, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "outside-hours-logo-x",
        )
        val y by movement.animateFloat(
            initialValue = 0f,
            targetValue = maxY,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 8_500, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "outside-hours-logo-y",
        )
        TilecastCastLogo(Modifier.offset(x.dp, y.dp).width(logoWidth))
    }
}
