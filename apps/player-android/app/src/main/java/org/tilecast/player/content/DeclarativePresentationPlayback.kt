package org.tilecast.player.content

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.layout.ContentScale
import android.graphics.BitmapFactory
import java.io.File
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.tilecast.player.network.DocumentDataset
import org.tilecast.player.network.DocumentRecord
import org.tilecast.player.network.DocumentValue
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.PresentationBinding
import org.tilecast.player.network.PresentationNode

data class PresentationContext(
    val datasets: Map<String, DocumentDataset>,
    val localFiles: Map<String, String>,
    val assets: Map<String, ManifestAsset> = emptyMap(),
    val record: DocumentRecord? = null,
    val repeatIndex: Int = 0,
    val now: Instant = Instant.now(),
    val regionalFormatting: org.tilecast.player.network.RegionalFormatting? = null,
    val repeatCurrencies: Map<String, String> = emptyMap(),
    /** The surface's author textScale as a multiplier, applied to role typography. */
    val textScale: Float = 1f,
)

@Composable
fun DeclarativeWidgetItem(item:ManifestItem,widget: ManifestWidget, session: PlaybackSession,onDone:()->Unit,onSkip:()->Unit,onFailure: (String) -> Unit,onStatus:(WidgetPlaybackStatus)->Unit,startOffsetMs:Long=0,allowAutoSkip:Boolean=true) {
    DisposableEffect(widget.assetId) {
        onStatus(WidgetPlaybackStatus(widget.assetId, widget.provider.ifBlank { "declarative" }, "ready"))
        onDispose { onStatus(WidgetPlaybackStatus()) }
    }
    LaunchedEffect(item.id,startOffsetMs){delay(((item.durationMs?:30_000)-startOffsetMs).coerceAtLeast(1));onDone()}
    val presentation = widget.presentation ?: return onFailure("Presentation is unavailable")
    val native = presentation.native ?: return onFailure("Native presentation is unavailable")
    var now by remember { mutableStateOf(session.content.serverNow()) }
    LaunchedEffect(widget.assetId) {
        while (true) {
            now = session.content.serverNow()
            delay(1_000)
        }
    }
    val datasets = buildMap {
        session.content.manifest.dataSources.forEach { source ->
            source.dataDocument?.datasets?.forEach { dataset ->
                put("${source.id}:${dataset.id}", dataset)
            }
        }
    }
    val context = PresentationContext(
        datasets,
        session.content.localFiles,
        session.content.manifest.assets.associateBy { it.variantId },
        now = now,
        regionalFormatting = session.playbackDefaults?.regionalFormat,
    )
    val shouldSkip = allowAutoSkip && presentationSignalsEmpty(native.root, context)
    if (shouldSkip) {
        LaunchedEffect(item.id, shouldSkip) {
            onStatus(WidgetPlaybackStatus(widget.assetId, widget.provider.ifBlank { "declarative" }, "empty"))
            onSkip()
        }
        return
    }
    PresentationNodeView(native.root, context)
}

internal fun presentationSignalsEmpty(root: PresentationNode, context: PresentationContext): Boolean {
    // A non-primitive or malformed flag keeps the widget on screen with its empty state.
    if ((root.props["autoSkipWhenEmpty"] as? JsonPrimitive)?.booleanOrNull != true) return false
    val conditionElement = root.props["emptyCondition"] ?: return false
    val condition = runCatching {
        Json.decodeFromJsonElement<org.tilecast.player.network.PresentationCondition>(conditionElement)
    }.getOrNull() ?: return false
    return conditionMatches(root.copy(condition = condition), context)
}

@Composable
private fun PresentationNodeView(node: PresentationNode, context: PresentationContext) {
    if (!conditionMatches(node, context)) return
    when (node.type) {
        // A surface carries the author's sizing: paddingPercent is a fraction of
        // each edge (10 gives the content the center 80 percent) and textScale
        // multiplies the role typography of every text below it.
        "surface" -> BoxWithConstraints(
            Modifier.fillMaxSize().background(node.color("backgroundColor", Color.Transparent)),
            contentAlignment = Alignment.Center,
        ) {
            val inset = widgetPaddingFraction(node.int("paddingPercent", node.int("padding", 10)))
            val scoped = context.copy(textScale = widgetAuthorScale(node.int("textScale", 100)))
            Box(
                Modifier.fillMaxSize().padding(
                    horizontal = (maxWidth.value * inset).dp,
                    vertical = (maxHeight.value * inset).dp,
                ),
                contentAlignment = Alignment.Center,
            ) { node.children.forEach { PresentationNodeView(it, scoped) } }
        }
        "box", "stack" -> Box(
            Modifier.fillMaxSize()
                .background(node.color("backgroundColor", Color.Transparent))
                .padding(node.int("padding", 0).dp),
            contentAlignment = Alignment.Center,
        ) { node.children.forEach { PresentationNodeView(it, context) } }
        "row" -> Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = if (node.string("justify", "") == "center") Arrangement.spacedBy(node.int("gap", 12).dp, Alignment.CenterHorizontally) else Arrangement.spacedBy(node.int("gap", 12).dp),
            verticalAlignment = Alignment.CenterVertically,
        ) { node.children.forEach { PresentationNodeView(it, context) } }
        "column", "grouped_sections" -> Column(
            (if (node.bool("fill", true)) Modifier.fillMaxSize() else Modifier.fillMaxWidth())
                .background(
                    node.color("background", Color.Transparent),
                    RoundedCornerShape(node.int("radius", 0).dp),
                )
                .padding(node.int("padding", 0).dp),
            verticalArrangement = Arrangement.spacedBy(node.int("gap", 10).dp),
            horizontalAlignment = if (node.string("align", "") == "center") Alignment.CenterHorizontally else Alignment.Start,
        ) { node.children.forEach { PresentationNodeView(it, context) } }
        "grid" -> {
            val repeated = node.children.firstOrNull { it.type == "repeat" }
            if (repeated == null) {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(node.int("columns", 1).coerceIn(1, 4)),
                    horizontalArrangement = Arrangement.spacedBy(node.int("gap", 10).dp),
                    verticalArrangement = Arrangement.spacedBy(node.int("gap", 10).dp),
                ) { items(node.children.size) { index -> PresentationNodeView(node.children[index], context) } }
                return
            }
            val records = repeated.repeat?.let {
                temporalRecords(
                    context.datasets[it.dataset], context.now, it.selector, it.startField,
                    it.endField, context.regionalFormatting.firstDay(),
                    context.regionalFormatting.formatZone(),
                )
                    .drop(it.offset).take(it.limit)
            }.orEmpty()
            val template = repeated.children.firstOrNull()
            LazyVerticalGrid(
                columns = GridCells.Fixed(node.int("columns", 1).coerceIn(1, 4)),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (records.isEmpty()) item { Text(repeated.string("emptyState", "No information available"), color = Color.White) }
                val currencies = context.datasets[repeated.repeat?.dataset]?.fields.orEmpty().mapNotNull { field -> field.currency.takeIf(String::isNotBlank)?.let { field.key to it } }.toMap()
                items(records.size, key = { records[it].id }) { index -> template?.let { PresentationNodeView(it, context.copy(record = records[index], repeatIndex = index + 1, repeatCurrencies = currencies)) } }
            }
        }
        "spacer" -> Spacer(Modifier.height(node.int("height", 8).dp))
        "divider" -> HorizontalDivider(color = node.color("color", Color.White.copy(alpha = .18f)))
        "repeat" -> {
            val repeat = node.repeat ?: return
            val records = temporalRecords(
                context.datasets[repeat.dataset],
                context.now,
                repeat.selector,
                repeat.startField,
                repeat.endField,
                context.regionalFormatting.firstDay(),
                context.regionalFormatting.formatZone(),
            ).drop(repeat.offset).take(repeat.limit)
            if (records.isEmpty()) {
                Text(node.string("emptyState", "No information available"), color = Color.White)
            }
            records.forEachIndexed { index, record ->
                val currencies = context.datasets[repeat.dataset]?.fields.orEmpty().mapNotNull { field -> field.currency.takeIf(String::isNotBlank)?.let { field.key to it } }.toMap()
                node.children.forEach { PresentationNodeView(it, context.copy(record = record, repeatIndex = index + 1, repeatCurrencies = currencies)) }
            }
        }
        "text", "badge" -> {
            val role = node.string("role", "body")
            val size = when (role) { "metric" -> 58; "title" -> 26; "label" -> 19; else -> 18 }
            val value = resolve(node.binding, context)
            // The author's scale sets the starting size; measured overflow below
            // shrinks it back so an enlarged value stays inside the margins.
            var fontSize by remember(value, node.int("fontSize", size), context.textScale) {
                mutableFloatStateOf(node.int("fontSize", size) * context.textScale)
            }
            Text(
                value,
                color = node.color("color", Color.White),
                fontSize = fontSize.sp,
                fontWeight = if (role in setOf("metric", "title")) FontWeight.Bold else FontWeight.Normal,
                textAlign = when (node.string("align", "left")) { "center" -> TextAlign.Center; "right" -> TextAlign.End; else -> TextAlign.Start },
                maxLines = node.int("maxLines", if (role == "body") 3 else 1),
                overflow = TextOverflow.Ellipsis,
                modifier = if (node.type == "badge") Modifier.background(node.color("badgeColor", Color.White.copy(alpha = .12f))).padding(6.dp) else Modifier,
                onTextLayout = { result ->
                    if ((result.didOverflowWidth || result.didOverflowHeight) && fontSize > 8f) {
                        fontSize = (fontSize * 0.9f).coerceAtLeast(8f)
                    }
                },
            )
        }
        "marquee" -> MarqueeNode(node, resolve(node.binding, context))
        "qr_code" -> QRNode(resolve(node.binding, context))
        "icon" -> IconNode(node, resolve(node.binding, context))
        "asset_image" -> AssetImageNode(node, context)
        "progress" -> ProgressNode(node, context)
        "line_chart", "bar_chart", "donut_chart" -> ChartNode(node, context)
        "conditional" -> node.children.forEach { PresentationNodeView(it, context) }
    }
}

@Composable
private fun MarqueeNode(node: PresentationNode, value: String) {
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        val duration = when (node.string("speed", "normal")) { "slow" -> 30_000; "fast" -> 10_000; else -> 18_000 }
        val transition = rememberInfiniteTransition(label = "declarative-marquee")
        val right = node.string("direction", "left") == "right"
        val offset by transition.animateFloat(
            initialValue = if (right) -value.length * 20f else maxWidth.value,
            targetValue = if (right) maxWidth.value else -value.length * 20f,
            animationSpec = infiniteRepeatable(tween(duration, easing = LinearEasing), RepeatMode.Restart),
            label = "declarative-marquee-offset",
        )
        Text(value, Modifier.graphicsLayer { translationX = offset }, color = node.color("color", Color.White), fontSize = 34.sp, maxLines = 1, softWrap = false)
    }
}

@Composable
private fun QRNode(value: String) {
    val bitmap = remember(value) {
        val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 512, 512, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
        android.graphics.Bitmap.createBitmap(512, 512, android.graphics.Bitmap.Config.ARGB_8888).apply {
            for (y in 0 until 512) for (x in 0 until 512) setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        }
    }
    Image(bitmap.asImageBitmap(), null, Modifier.fillMaxSize())
}

private fun resolve(binding: PresentationBinding?, context: PresentationContext): String {
    binding ?: return ""
    var currencyCode: String? = null
    var inferredFormat = ""
    val raw = when (binding.source) {
        "literal" -> binding.value
        "repeat" -> {
            currencyCode = context.repeatCurrencies[binding.path]
            context.record?.values?.get(binding.path)?.display().orEmpty()
        }
        "repeat_index" -> context.repeatIndex.toString()
        "dataset" -> {
            val dataset = context.datasets[binding.dataset] ?: context.datasets.values.firstOrNull()
            val records = temporalRecords(
                dataset, context.now, binding.selector, binding.startField,
                binding.endField, context.regionalFormatting.firstDay(),
                context.regionalFormatting.formatZone(),
            )
            if (binding.path.isNotBlank()) {
                val field = dataset?.fields?.firstOrNull { it.key == binding.path }
                currencyCode = field?.currency
                inferredFormat = field?.type.orEmpty()
                val objectValue = dataset?.value?.objectValue?.get(binding.path)?.display()
                objectValue ?: records.firstOrNull()?.values?.get(binding.path)?.display().orEmpty()
            } else {
            records.mapNotNull { record ->
                binding.fields.mapNotNull { record.values[it]?.display()?.takeIf(String::isNotBlank) }
                    .joinToString(" ").takeIf(String::isNotBlank)
            }.joinToString(binding.separator)
            }
        }
        "environment" -> formatEnvironment(binding, context.now, context.regionalFormatting)
        else -> ""
    }
    val format = binding.format.ifBlank { inferredFormat.ifBlank { "text" } }
    return binding.prefix + formatValue(raw.ifBlank { binding.fallback }, format, binding.precision, context.now, context.regionalFormatting, currencyCode) + binding.suffix
}

private fun formatEnvironment(binding: PresentationBinding, now: Instant, regional: org.tilecast.player.network.RegionalFormatting?): String {
    val parts = binding.format.split(':')
    return when (parts.firstOrNull()) {
        "time" -> {
            val explicit = parts.getOrNull(1)?.takeIf { it == "12" || it == "24" }
            val seconds = parts.getOrNull(2) == "true"
            val zone = runCatching { ZoneId.of(parts.getOrNull(3) ?: regional?.timezone ?: "UTC") }.getOrDefault(regional.formatZone())
            regional.formatTime(now.atZone(zone), explicit, seconds)
        }
        "date" -> {
            val style = when (parts.getOrNull(1)) { "short" -> java.time.format.FormatStyle.SHORT; "medium" -> java.time.format.FormatStyle.MEDIUM; "long" -> java.time.format.FormatStyle.LONG; "full" -> java.time.format.FormatStyle.FULL; else -> null }
            val zone = runCatching { ZoneId.of(parts.getOrNull(2) ?: regional?.timezone ?: "UTC") }.getOrDefault(regional.formatZone())
            regional.formatDate(now.atZone(zone).toLocalDate(), style)
        }
        "countdown" -> {
            if (parts.getOrNull(1) == "v2") {
                fun decode(index: Int) = URLDecoder.decode(parts.getOrNull(index).orEmpty(), StandardCharsets.UTF_8.name())
                return formatCountdown(
                    target = decode(2),
                    timezone = decode(3).ifBlank { "UTC" },
                    mode = parts.getOrNull(4) ?: "countdown",
                    recurrence = parts.getOrNull(5) ?: "none",
                    completionAction = parts.getOrNull(6) ?: "completed_text",
                    visibleUnits = parts.getOrNull(7) ?: "1111",
                    completionText = decode(8).ifBlank { "Complete" },
                    now = now,
                ).orEmpty()
            }
            val zone = runCatching { ZoneId.of(parts.getOrNull(2) ?: "UTC") }.getOrDefault(ZoneId.of("UTC"))
            val target = runCatching {
                val value = parts.getOrNull(1).orEmpty()
                if (value.endsWith("Z") || value.contains("+")) Instant.parse(value) else LocalDateTime.parse(value).atZone(zone).toInstant()
            }.getOrDefault(now)
            val duration = Duration.between(if (parts.getOrNull(3) == "count_up") target else now, if (parts.getOrNull(3) == "count_up") now else target)
            if (duration.isNegative) parts.getOrNull(4) ?: "Complete" else "${duration.toDays()}d ${duration.toHoursPart()}h ${duration.toMinutesPart()}m ${duration.toSecondsPart()}s"
        }
        else -> ""
    }
}

internal fun formatValue(
    value: String,
    format: String,
    precision: Int?,
    now: Instant = Instant.now(),
    regional: org.tilecast.player.network.RegionalFormatting? = null,
    currencyCode: String? = null,
): String = regional.formatValue(value, format, precision, currencyCode, now)

private fun selectedRecords(dataset: DocumentDataset?, now: Instant, firstDayOfWeek: java.time.DayOfWeek = java.time.DayOfWeek.MONDAY): List<DocumentRecord> {
    dataset ?: return emptyList()
    val selection = dataset.dateSelection ?: return dataset.records
    val zone = runCatching { ZoneId.of(selection.timezone) }.getOrDefault(ZoneId.of("UTC"))
    val today = now.atZone(zone).toLocalDate()
    val target = if (selection.mode == "tomorrow") today.plusDays(1) else today
    val dated = dataset.records.mapNotNull { record ->
        val raw = record.values[selection.field]?.display().orEmpty()
        val date = runCatching { if (raw.contains('T')) Instant.parse(raw).atZone(zone).toLocalDate() else LocalDate.parse(raw.take(10)) }.getOrNull()
        date?.let { it to record }
    }
    val matches = dated.filter { (date, _) ->
        when (selection.mode) {
            "next_available" -> !date.isBefore(target)
            "current_week" -> {
                val start = today.with(java.time.temporal.TemporalAdjusters.previousOrSame(firstDayOfWeek))
                !date.isBefore(start) && !date.isAfter(start.plusDays(6))
            }
            "custom_range" -> runCatching { !date.isBefore(LocalDate.parse(selection.customStartDate)) && !date.isAfter(LocalDate.parse(selection.customEndDate)) }.getOrDefault(false)
            else -> date == target
        }
    }
    if (selection.mode == "next_available" && matches.isNotEmpty()) {
        val first = matches.minOf { it.first }
        return matches.filter { it.first == first }.map { it.second }
    }
    return matches.map { it.second }
}

private fun parseRecordInstant(value: String, timezone: ZoneId): Instant? = runCatching {
    Instant.parse(value)
}.recoverCatching {
    LocalDateTime.parse(value).atZone(timezone).toInstant()
}.getOrNull()

internal fun temporalRecords(
    dataset: DocumentDataset?,
    now: Instant,
    selector: String,
    startField: String,
    endField: String,
    firstDayOfWeek: java.time.DayOfWeek = java.time.DayOfWeek.MONDAY,
    timezone: ZoneId = ZoneId.of("UTC"),
): List<DocumentRecord> {
    val records = selectedRecords(dataset, now, firstDayOfWeek)
    if (selector.isBlank() || selector == "all") return records
    if (startField.isBlank()) return emptyList()
    val timed = records.mapNotNull { record ->
        parseRecordInstant(record.values[startField]?.display().orEmpty(), timezone)?.let {
            Triple(it, record, parseRecordInstant(record.values[endField]?.display().orEmpty(), timezone))
        }
    }.sortedBy { it.first }
    val current = timed.filter { (start, _, end) ->
        !start.isAfter(now) && end?.isAfter(now) == true
    }.map { it.second }
    val upcoming = timed.filter { (start, _, _) -> start.isAfter(now) }.map { it.second }
    return when (selector) {
        "current" -> current
        "next" -> upcoming.take(1)
        "upcoming" -> upcoming
        "current_or_next" -> current.ifEmpty { upcoming.take(1) }
        else -> emptyList()
    }
}

private fun conditionMatches(node: PresentationNode, context: PresentationContext): Boolean {
    val condition = node.condition ?: return true
    val value = resolve(condition.binding, context)
    val numeric = value.toDoubleOrNull()
    val expected = condition.value.toDoubleOrNull()
    val instant = parseComparableInstant(value)
    val expectedInstant = parseComparableInstant(condition.value)
    return when (condition.op) {
        "equals" -> value == condition.value
        "not_equals" -> value != condition.value
        "empty" -> value.isEmpty()
        "not_empty" -> value.isNotEmpty()
        "greater_than" -> numeric != null && expected != null && numeric > expected
        "greater_or_equal" -> numeric != null && expected != null && numeric >= expected
        "less_than" -> numeric != null && expected != null && numeric < expected
        "less_or_equal" -> numeric != null && expected != null && numeric <= expected
        "before" -> instant != null && expectedInstant != null && instant.isBefore(expectedInstant)
        "after" -> instant != null && expectedInstant != null && instant.isAfter(expectedInstant)
        else -> false
    }
}

@Composable
private fun AssetImageNode(node: PresentationNode, context: PresentationContext) {
    val variantId = node.string("variantId", "")
    val available = context.assets[variantId]?.isAvailableAt(context.now) == true
    val path = variantId.takeIf { available }?.let(context.localFiles::get)
    val bitmap = remember(path) { path?.let(BitmapFactory::decodeFile) }
    if (bitmap != null) {
        Image(
            bitmap.asImageBitmap(),
            contentDescription = node.string("contentDescription", ""),
            modifier = Modifier.fillMaxSize(),
            contentScale = when (node.string("fit", "contain")) {
                "cover" -> ContentScale.Crop
                "stretch" -> ContentScale.FillBounds
                else -> ContentScale.Fit
            },
        )
    } else {
        Box(Modifier.fillMaxSize().background(node.color("fallbackColor", Color.DarkGray)))
    }
}

@Composable
private fun IconNode(node: PresentationNode, value: String) {
    val glyph = when (value.ifBlank { node.string("name", "info") }) {
        "check", "operational", "complete" -> "✓"
        "warning", "degraded" -> "!"
        "error", "down", "cancelled" -> "×"
        "clock", "scheduled" -> "◷"
        "location" -> "●"
        "up" -> "↑"
        "down_arrow" -> "↓"
        else -> "•"
    }
    Text(glyph, color = node.color("color", Color.White), fontSize = node.int("fontSize", 28).sp)
}

@Composable
private fun ProgressNode(node: PresentationNode, context: PresentationContext) {
    val value = resolve(node.binding, context).toFloatOrNull() ?: 0f
    val target = if (node.bool("targetIsField", false)) {
        val field = node.string("target", "")
        val binding = node.binding?.copy(path = field)
        resolve(binding, context).toFloatOrNull() ?: 0f
    } else node.float("target", 100f)
    val ratio = if (target > 0) (value / target).coerceIn(0f, 1f) else 0f
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LinearProgressIndicator(progress = { ratio }, modifier = Modifier.fillMaxWidth())
        if (node.bool("showPercent", true)) {
            Text(if (ratio >= 1f && node.string("completionText", "").isNotBlank()) node.string("completionText", "") else "${(ratio * 100).toInt()}%", color = node.color("color", Color.White), fontSize = 24.sp)
        }
    }
}

private data class ChartSeriesValues(val label: String, val color: Color, val values: List<Float>)

@Composable
private fun ChartNode(node: PresentationNode, context: PresentationContext) {
    val binding = node.binding ?: return
    val dataset = context.datasets[binding.dataset] ?: return
    val labels = node.stringList("seriesLabels")
    val colors = node.stringList("seriesColors")
    val palette = listOf(Color(0xFF4DB6FF), Color(0xFFFFB547), Color(0xFF57D38C), Color(0xFFE879F9))
    val series = binding.fields.mapIndexed { index, field ->
        val values = if (dataset.kind == "time_series") dataset.points.mapNotNull { it.values[field]?.display()?.toFloatOrNull() }
        else selectedRecords(dataset, context.now, context.regionalFormatting.firstDay()).mapNotNull { it.values[field]?.display()?.toFloatOrNull() }
        ChartSeriesValues(labels.getOrNull(index).orEmpty().ifBlank { field }, parseOptionalColor(colors.getOrNull(index)) ?: palette[index % palette.size], values)
    }.filter { it.values.isNotEmpty() }
    if (series.isEmpty()) {
        Text(node.string("emptyState", "No chart data available"), color = Color.White)
        return
    }
    val explicitMin = node.optionalFloat("minimum")
    val explicitMax = node.optionalFloat("maximum")
    val minimum = explicitMin ?: minOf(0f, series.minOf { it.values.min() })
    val maximum = explicitMax ?: maxOf(1f, series.maxOf { it.values.max() })
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Canvas(Modifier.fillMaxWidth().weight(1f)) {
            val span = (maximum - minimum).takeIf { it > 0 } ?: 1f
            if (node.type == "donut_chart") {
                val totals = series.map { it.values.sum().coerceAtLeast(0f) }
                val total = totals.sum().takeIf { it > 0 } ?: 1f
                var start = -90f
                totals.forEachIndexed { index, value ->
                    val sweep = value / total * 360f
                    drawArc(series[index].color, start, sweep, false, style = Stroke(width = size.minDimension * .18f, cap = StrokeCap.Butt))
                    start += sweep
                }
            } else if (node.type == "bar_chart") {
                val count = series.maxOf { it.values.size }.coerceAtLeast(1)
                val groupWidth = size.width / count
                val barWidth = groupWidth / (series.size + 1)
                series.forEachIndexed { seriesIndex, item ->
                    item.values.forEachIndexed { index, value ->
                        val height = (value - minimum) / span * size.height
                        drawRect(item.color, topLeft = androidx.compose.ui.geometry.Offset(index * groupWidth + seriesIndex * barWidth, size.height - height), size = androidx.compose.ui.geometry.Size(barWidth * .8f, height))
                    }
                }
            } else {
                series.forEach { item ->
                    val path = Path()
                    item.values.forEachIndexed { index, value ->
                        val x = if (item.values.size == 1) size.width / 2 else index.toFloat() / (item.values.size - 1) * size.width
                        val y = size.height - (value - minimum) / span * size.height
                        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    drawPath(path, item.color, style = Stroke(width = 4f, cap = StrokeCap.Round))
                }
            }
        }
        if (node.bool("showLegend", true)) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                series.forEach { item -> Row(verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(10.dp).background(item.color)); Spacer(Modifier.width(5.dp)); Text(item.label, color = Color.White, fontSize = 14.sp) } }
            }
        }
    }
}

private fun parseComparableInstant(value: String): Instant? =
    runCatching { Instant.parse(value) }.getOrElse { runCatching { LocalDate.parse(value).atStartOfDay(ZoneId.of("UTC")).toInstant() }.getOrNull() }

private fun DocumentValue.display(): String = when (kind) {
    "number", "percent", "currency" -> number?.toString()
    "integer" -> integer?.toString()
    "boolean" -> boolean?.toString()
    "date" -> date
    "datetime" -> datetime
    "duration" -> durationSeconds?.toString()
    "url" -> url
    "asset" -> assetId
    else -> text
}.orEmpty()

private fun PresentationNode.string(key: String, fallback: String): String = props[key]?.jsonPrimitive?.contentOrNull ?: fallback
private fun PresentationNode.int(key: String, fallback: Int): Int = props[key]?.jsonPrimitive?.intOrNull ?: fallback
private fun PresentationNode.float(key: String, fallback: Float): Float = props[key]?.jsonPrimitive?.contentOrNull?.toFloatOrNull() ?: fallback
private fun PresentationNode.optionalFloat(key: String): Float? = props[key]?.jsonPrimitive?.contentOrNull?.toFloatOrNull()
private fun PresentationNode.bool(key: String, fallback: Boolean): Boolean = props[key]?.jsonPrimitive?.booleanOrNull ?: fallback
private fun PresentationNode.stringList(key: String): List<String> = (props[key] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
private fun PresentationNode.color(key: String, fallback: Color): Color = runCatching { Color(android.graphics.Color.parseColor(string(key, ""))) }.getOrDefault(fallback)
private fun parseOptionalColor(value: String?): Color? = value?.takeIf(String::isNotBlank)?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() }
