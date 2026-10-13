package org.tilecast.player.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import org.tilecast.player.R

/**
 * Geist, the Tilecast typeface, for every Tilecast-owned native surface.
 *
 * The one variable font ships in the APK (see `syncGeistFont` in
 * `app/build.gradle.kts`): nothing loads from the network, so an offline
 * display keeps its typeface. On Android 8.0 and later each weight is a
 * variation of the same file; earlier releases ignore variation settings and
 * draw the default weight. Glyphs Geist does not contain fall back to the
 * system font per character.
 *
 * This is the only place a native font family is chosen. Text composables
 * take their family from [SignalTypography] through the theme and never set
 * their own.
 */
val TilecastFontFamily = FontFamily(
    listOf(
        FontWeight.Normal to 400,
        FontWeight.Medium to 500,
        FontWeight.SemiBold to 600,
        FontWeight.Bold to 700,
    ).map { (weight, value) ->
        Font(
            R.font.geist_variable,
            weight = weight,
            variationSettings = FontVariation.Settings(FontVariation.weight(value)),
        )
    },
)

private val base = Typography(
    displayLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 52.sp, lineHeight = 60.sp),
    headlineLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 48.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 32.sp, lineHeight = 40.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 20.sp, lineHeight = 29.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 17.sp, lineHeight = 25.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp),
)

/** Every Material text style, including the ones the theme leaves at their defaults, in Geist. */
val SignalTypography = base.copy(
    displayLarge = base.displayLarge.copy(fontFamily = TilecastFontFamily),
    displayMedium = base.displayMedium.copy(fontFamily = TilecastFontFamily),
    displaySmall = base.displaySmall.copy(fontFamily = TilecastFontFamily),
    headlineLarge = base.headlineLarge.copy(fontFamily = TilecastFontFamily),
    headlineMedium = base.headlineMedium.copy(fontFamily = TilecastFontFamily),
    headlineSmall = base.headlineSmall.copy(fontFamily = TilecastFontFamily),
    titleLarge = base.titleLarge.copy(fontFamily = TilecastFontFamily),
    titleMedium = base.titleMedium.copy(fontFamily = TilecastFontFamily),
    titleSmall = base.titleSmall.copy(fontFamily = TilecastFontFamily),
    bodyLarge = base.bodyLarge.copy(fontFamily = TilecastFontFamily),
    bodyMedium = base.bodyMedium.copy(fontFamily = TilecastFontFamily),
    bodySmall = base.bodySmall.copy(fontFamily = TilecastFontFamily),
    labelLarge = base.labelLarge.copy(fontFamily = TilecastFontFamily),
    labelMedium = base.labelMedium.copy(fontFamily = TilecastFontFamily),
    labelSmall = base.labelSmall.copy(fontFamily = TilecastFontFamily),
)
