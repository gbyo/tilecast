package org.tilecast.player.content

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.tilecast.player.network.LayoutDocument
import org.tilecast.player.network.LayoutPlacement
import org.tilecast.player.network.ManifestViewport
import org.tilecast.player.network.StructuredSourceConfig
import org.tilecast.player.R
import java.time.Instant
import java.time.LocalDate

@Composable
fun LayoutPrimitiveCanvas(
    document: LayoutDocument,
    modifier: Modifier = Modifier,
    structuredSources: Map<String, StructuredSourceConfig> = emptyMap(),
    placementIds: Set<String>? = null,
    drawBackground: Boolean = true,
    viewport: ManifestViewport? = null,
    nowProvider: () -> Instant = { Instant.now() },
) {
    var now by remember { mutableStateOf(nowProvider()) }
    val regional = LocalTilecastRegionalFormatting.current
    LaunchedEffect(structuredSources) { while (true) { now = nowProvider(); kotlinx.coroutines.delay(30_000) } }
    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val sourceWidth = viewport?.width ?: document.canvas.width
        val sourceHeight = viewport?.height ?: document.canvas.height
        val originX = viewport?.x ?: 0
        val originY = viewport?.y ?: 0
        val sourceRatio = sourceWidth.toFloat() / sourceHeight
        val targetRatio = maxWidth.value / maxHeight.value
        val width: Dp
        val height: Dp
        if (targetRatio > sourceRatio) {
            height = maxHeight
            width = height * sourceRatio
        } else {
            width = maxWidth
            height = width / sourceRatio
        }
        val sx = width.value / sourceWidth
        val sy = height.value / sourceHeight
        val hiddenGroups = document.placements.filter { it.primitive?.kind == "group" && it.primitive.binding?.hideWhenEmpty == true }.filter { group ->
            val binding = group.primitive?.binding ?: return@filter false
            structuredSources[binding.dataSourceId]?.let { resolveLayoutBinding(binding, it, now, regional).isBlank() } ?: true
        }.map { it.id }.toSet()
        val canvasModifier = if (drawBackground) {
            Modifier.size(width, height).background(layoutColor(document.canvas.backgroundColor))
        } else {
            Modifier.size(width, height)
        }
        Box(canvasModifier) {
            document.placements.filter {
                it.visible &&
                    it.type == "primitive" &&
                    it.primitive?.kind != "group" &&
                    placementGroupVisible(it, hiddenGroups) &&
                    (placementIds == null || it.id in placementIds)
            }.sortedBy { it.layer }.forEach { placement ->
                val left = maxOf(placement.x, originX.toFloat())
                val top = maxOf(placement.y, originY.toFloat())
                val right = minOf(placement.x + placement.width, (originX + sourceWidth).toFloat())
                val bottom = minOf(placement.y + placement.height, (originY + sourceHeight).toFloat())
                if (right > left && bottom > top) {
                    PrimitivePlacement(placement.copy(x = left - originX, y = top - originY, width = right - left, height = bottom - top), sx, sy, structuredSources, now, regional)
                }
            }
        }
    }
}

private fun placementGroupVisible(placement: LayoutPlacement, hiddenGroups: Set<String>) = placement.groupId == null || placement.groupId !in hiddenGroups

@Composable
private fun PrimitivePlacement(placement: LayoutPlacement, sx: Float, sy: Float, structuredSources: Map<String, StructuredSourceConfig>, now: Instant, regional: org.tilecast.player.network.RegionalFormatting?) {
    val primitive = placement.primitive ?: return
    val shape = RoundedCornerShape((primitive.cornerRadius * minOf(sx, sy)).dp)
    val box = Modifier.offset((placement.x * sx).dp, (placement.y * sy).dp).size((placement.width * sx).dp, (placement.height * sy).dp).alpha(placement.opacity).clip(shape)
    when (primitive.kind) {
        "text" -> {
            var textModifier = box.background(layoutColor(primitive.backgroundColor))
            if (primitive.borderWidth > 0) textModifier = textModifier.border((primitive.borderWidth * sx).dp, layoutColor(primitive.borderColor), shape)
            Box(
            textModifier.padding((primitive.padding * sx).dp),
            contentAlignment = when (primitive.verticalAlign) { "top" -> Alignment.TopStart; "bottom" -> Alignment.BottomStart; else -> Alignment.CenterStart },
        ) {
            val resolved = primitive.binding?.let { binding -> structuredSources[binding.dataSourceId]?.let { resolveLayoutBinding(binding, it, now, regional) } }
            if (primitive.binding?.hideWhenEmpty == true && resolved.isNullOrEmpty()) return@Box
            Text(
                text = resolved ?: primitive.text,
                modifier = Modifier.fillMaxSize(),
                color = layoutColor(primitive.color),
                fontSize = (primitive.fontSize * sx).sp,
                fontFamily = layoutFontFamily(primitive.fontFamily),
                fontWeight = FontWeight(primitive.fontWeight),
                textAlign = when (primitive.textAlign) { "center" -> TextAlign.Center; "right" -> TextAlign.Right; else -> TextAlign.Left },
                lineHeight = (primitive.fontSize * primitive.lineHeight * sx).sp,
                letterSpacing = (primitive.letterSpacing * sx).sp,
                maxLines = primitive.maximumLines,
                overflow = if (primitive.overflow == "clip") TextOverflow.Clip else TextOverflow.Ellipsis,
            )
        }
        }
        "rectangle" -> Canvas(box) {
            drawRoundRect(layoutColor(primitive.fillColor), cornerRadius = androidx.compose.ui.geometry.CornerRadius(primitive.cornerRadius * sx))
            if (primitive.strokeWidth > 0) drawRoundRect(layoutColor(primitive.strokeColor), cornerRadius = androidx.compose.ui.geometry.CornerRadius(primitive.cornerRadius * sx), style = Stroke(primitive.strokeWidth * sx))
        }
        "circle" -> Canvas(box) {
            drawOval(layoutColor(primitive.fillColor))
            if (primitive.strokeWidth > 0) drawOval(layoutColor(primitive.strokeColor), style = Stroke(primitive.strokeWidth * sx))
        }
        "line" -> Canvas(box) { drawLine(layoutColor(primitive.strokeColor), Offset(0f, size.height / 2), Offset(size.width, size.height / 2), (primitive.strokeWidth * sx).coerceAtLeast(1f)) }
    }
}

private val interLayoutFont = FontFamily(Font(R.font.inter_variable))
private val robotoLayoutFont = FontFamily(Font(R.font.roboto_variable))
private val sourceSans3LayoutFont = FontFamily(Font(R.font.source_sans_3_variable))
private val notoSansLayoutFont = FontFamily(Font(R.font.noto_sans_variable))

internal fun layoutFontFamily(name: String): FontFamily = when (name) {
    "Inter" -> interLayoutFont
    "Roboto" -> robotoLayoutFont
    "Source Sans 3" -> sourceSans3LayoutFont
    "Noto Sans" -> notoSansLayoutFont
    else -> FontFamily.SansSerif
}

internal fun resolveLayoutBinding(binding: org.tilecast.player.network.LayoutBinding, source: StructuredSourceConfig, now: Instant, regional: org.tilecast.player.network.RegionalFormatting? = null): String {
    val record = selectDateAwareRecords(source, now, regional.firstDay()).firstOrNull()
    val raw = record?.let { when (binding.field) { "title" -> it.title; "subtitle" -> it.subtitle; "date" -> it.values["date"] ?: it.date; "author" -> it.author; "description" -> it.description; else -> it.values[binding.field] } }.orEmpty()
    if (raw.isBlank()) return binding.fallbackText
    val currency = source.data.fieldCurrencies[binding.field]
    val formatted = regional.formatValue(raw, binding.format, null, currency)
    return binding.prefix + formatted + binding.suffix
}

internal fun layoutColor(value: String): Color = runCatching { Color(android.graphics.Color.parseColor(value)) }.getOrDefault(Color.Transparent)
