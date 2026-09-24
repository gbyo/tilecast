package org.tilecast.player.content

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.time.Instant
import java.time.ZoneId
import java.time.format.FormatStyle
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import org.tilecast.player.network.ClockWidgetConfig
import org.tilecast.player.network.CountdownWidgetConfig
import org.tilecast.player.network.CardsWidgetConfig
import org.tilecast.player.network.DateWidgetConfig
import org.tilecast.player.network.DisplayWidgetConfig
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.MetricWidgetConfig
import org.tilecast.player.network.QRCodeWidgetConfig
import org.tilecast.player.network.StructuredSourceConfig
import org.tilecast.player.network.TickerWidgetConfig
import org.tilecast.player.network.TypedRecordData
import org.tilecast.player.network.WeatherWidgetConfig

@Composable
fun WidgetItem(item: ManifestItem, widget: ManifestWidget, session: PlaybackSession, onDone: () -> Unit, onFailure: (String) -> Unit, onStatus: (WidgetPlaybackStatus) -> Unit, startOffsetMs: Long = 0) {
    DisposableEffect(widget.assetId) { onStatus(WidgetPlaybackStatus(widget.assetId, widget.provider, "ready")); onDispose { onStatus(WidgetPlaybackStatus()) } }
    LaunchedEffect(item.id, startOffsetMs) { delay(((item.durationMs ?: 30_000) - startOffsetMs).coerceAtLeast(1)); onDone() }
    CompositionLocalProvider(LocalTilecastServerNow provides { session.content.serverNow() }) {
    when (widget.provider) {
        "clock" -> runCatching { Json.decodeFromJsonElement<ClockWidgetConfig>(widget.configuration) }.onSuccess { ClockWidget(it) }.onFailure { onFailure("Clock Widget configuration is invalid") }
        "date" -> runCatching { Json.decodeFromJsonElement<DateWidgetConfig>(widget.configuration) }.onSuccess { DateWidget(it) }.onFailure { onFailure("Date Widget configuration is invalid") }
        "qrcode" -> runCatching { Json.decodeFromJsonElement<QRCodeWidgetConfig>(widget.configuration) }.onSuccess { QRCodeWidget(it) }.onFailure { onFailure("QR Code Widget configuration is invalid") }
        "countdown" -> runCatching { Json.decodeFromJsonElement<CountdownWidgetConfig>(widget.configuration) }.onSuccess { ExpandedCountdownWidget(it) }.onFailure { onFailure("Countdown Widget configuration is invalid") }
        "ticker" -> runCatching { Json.decodeFromJsonElement<TickerWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data = session.content.manifest.dataSources.firstOrNull { it.id == config.dataSourceId } ?: return@onSuccess onFailure("Ticker data is unavailable")
            if(session.content.manifest.schemaVersion>=12){
                val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Ticker data is invalid")}
                ExpandedTickerWidget(config,typed)
                return@onSuccess
            }
            val structured = runCatching { Json.decodeFromJsonElement<StructuredSourceConfig>(data.configuration) }.getOrElse { return@onSuccess onFailure("Ticker data is invalid") }
            TickerWidget(config, structured)
        }.onFailure { onFailure("Ticker Widget configuration is invalid") }
        "menu" -> runCatching { Json.decodeFromJsonElement<DisplayWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data = session.content.manifest.dataSources.firstOrNull { it.id == config.dataSourceId } ?: return@onSuccess onFailure("Menu data is unavailable")
            if(session.content.manifest.schemaVersion>=12){
                val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Menu data is invalid")}
                ExpandedDisplayWidget("menu",widget.name,config,typed)
                return@onSuccess
            }
            if (data.provider != "csv" && data.provider != "json") return@onSuccess onFailure("Menu data is incompatible")
            runCatching { Json.decodeFromJsonElement<StructuredSourceConfig>(data.configuration) }
                .onSuccess { MenuWidget(widget.name, config, it) }
                .onFailure { onFailure("Menu data is invalid") }
        }.onFailure { onFailure("Menu Widget configuration is invalid") }
        "list", "table", "agenda" -> runCatching { Json.decodeFromJsonElement<DisplayWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data = session.content.manifest.dataSources.firstOrNull { it.id == config.dataSourceId } ?: return@onSuccess onFailure("Widget data is unavailable")
            if(session.content.manifest.schemaVersion>=12){
                val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Widget data is invalid")}
                ExpandedDisplayWidget(widget.provider,widget.name,config,typed)
                return@onSuccess
            }
            when (data.provider) {
                "calendar" -> runCatching { Json.decodeFromJsonElement<org.tilecast.player.network.CalendarSourceConfig>(data.configuration) }.onSuccess { DisplayCalendarWidget(config, it) }.onFailure { onFailure("Agenda data is invalid") }
                else -> runCatching { Json.decodeFromJsonElement<StructuredSourceConfig>(data.configuration) }.onSuccess { DisplayStructuredWidget(config, it) }.onFailure { onFailure("Widget data is invalid") }
            }
        }.onFailure { onFailure("Widget configuration is invalid") }
        "metric" -> runCatching { Json.decodeFromJsonElement<MetricWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data=session.content.manifest.dataSources.firstOrNull{it.id==config.dataSourceId}?:return@onSuccess onFailure("Metric data is unavailable")
            val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Metric data is invalid")}
            ExpandedMetricWidget(config,typed)
        }.onFailure { onFailure("Metric Widget configuration is invalid") }
        "cards" -> runCatching { Json.decodeFromJsonElement<CardsWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data=session.content.manifest.dataSources.firstOrNull{it.id==config.dataSourceId}?:return@onSuccess onFailure("Cards data is unavailable")
            val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Cards data is invalid")}
            ExpandedCardsWidget(config,typed)
        }.onFailure { onFailure("Cards Widget configuration is invalid") }
        "weather" -> runCatching { Json.decodeFromJsonElement<WeatherWidgetConfig>(widget.configuration) }.onSuccess { config ->
            val data=session.content.manifest.dataSources.firstOrNull{it.id==config.dataSourceId}?:return@onSuccess onFailure("Weather data is unavailable")
            val typed=runCatching{Json.decodeFromJsonElement<TypedRecordData>(data.configuration)}.getOrElse{return@onSuccess onFailure("Weather data is invalid")}
            ExpandedWeatherWidget(config,typed)
        }.onFailure { onFailure("Weather Widget configuration is invalid") }
    }
    }
}

@Composable
private fun ClockWidget(config: ClockWidgetConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(config.timezone, config.showSeconds, regional) {
        while (true) {
            now = serverNow()
            delay(if (config.showSeconds) 1_000 else 15_000)
        }
    }
    val zone = runCatching { ZoneId.of(config.timezone) }.getOrDefault(regional.formatZone())
    val text = regional.formatTime(now.atZone(zone), config.format, config.showSeconds)
    CenteredWidget(config.backgroundColor, config.contentPadding) {
        FittedWidgetText(text, parseColor(config.foregroundColor), FontWeight.SemiBold, textScale = config.textScale)
    }
}

@Composable
private fun DateWidget(config: DateWidgetConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(config.timezone, regional) {
        while (true) {
            now = serverNow()
            delay(30_000)
        }
    }
    val style = when (config.format) {
        "locale" -> null
        "short" -> FormatStyle.SHORT
        "medium" -> FormatStyle.MEDIUM
        "long" -> FormatStyle.LONG
        else -> FormatStyle.FULL
    }
    val zone = runCatching { ZoneId.of(config.timezone) }.getOrDefault(regional.formatZone())
    val text = regional.formatDate(now.atZone(zone).toLocalDate(), style)
    CenteredWidget(config.backgroundColor, config.contentPadding) {
        FittedWidgetText(text, parseColor(config.foregroundColor), FontWeight.Medium, textScale = config.textScale)
    }
}
@Composable
private fun QRCodeWidget(config: QRCodeWidgetConfig) {
    val bitmap = remember(config) { qrBitmap(config) }
    CenteredWidget(config.backgroundColor, config.contentPadding) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val labelHeight = maxHeight.value * 0.18f
            val labelSize = scaledFittedFontSizeSp(
                config.label.length,
                maxWidth.value,
                labelHeight,
                LocalDensity.current.fontScale,
                maxLines = 2,
                textScale = config.textScale,
            )
            Column(
                Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy((maxHeight.value * 0.025f).dp),
            ) {
                Image(bitmap.asImageBitmap(), null, Modifier.weight(1f))
                if (config.label.isNotBlank()) {
                    Text(
                        config.label,
                        color = parseColor(config.foregroundColor),
                        fontSize = labelSize.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
@Composable
private fun TickerWidget(config: TickerWidgetConfig, data: StructuredSourceConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(data.dateSelection.timezone) {
        while (true) {
            now = serverNow()
            delay(30_000)
        }
    }
    val records = selectDateAwareRecords(data, now, regional.firstDay())
    val text = records.mapNotNull { record ->
        structuredFieldValue(record, config.field).takeIf { it.isNotBlank() }
    }.joinToString(config.separator).ifBlank { data.emptyState }
    CenteredWidget(config.backgroundColor, config.contentPadding) {
        FittedWidgetText(text, parseColor(config.foregroundColor), FontWeight.Normal, maxLines = 2, textScale = config.textScale)
    }
}
@Composable
private fun MenuWidget(name: String, config: DisplayWidgetConfig, data: StructuredSourceConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(data.dateSelection.timezone) {
        while (true) {
            now = serverNow()
            delay(30_000)
        }
    }
    val record = selectDateAwareRecords(data, now, regional.firstDay()).firstOrNull()
    BoxWithConstraints(Modifier.fillMaxSize().background(parseColor(config.backgroundColor))) {
        val horizontalInset = maxWidth.value * widgetPaddingFraction(config.contentPadding)
        val verticalInset = maxHeight.value * widgetPaddingFraction(config.contentPadding)
        val availableHeight = maxHeight.value - verticalInset * 2
        Box(
            Modifier.fillMaxSize().padding(horizontal = horizontalInset.dp, vertical = verticalInset.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (record == null) {
                FittedWidgetText(data.emptyState, parseColor(config.foregroundColor), FontWeight.Medium, maxLines = 3, textScale = config.textScale)
                return@Box
            }
            val values = config.fields.mapNotNull { field ->
                structuredFieldValue(record, field).takeIf(String::isNotBlank)?.let { field to it }
            }.take(config.maximumItems.coerceAtMost(8))
            if (values.isEmpty()) {
                FittedWidgetText(data.emptyState, parseColor(config.foregroundColor), FontWeight.Medium, maxLines = 3, textScale = config.textScale)
                return@Box
            }
            val contentScale = menuContentScale(values.size, availableHeight, config.textScale)
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(name.uppercase(), color = parseColor(config.foregroundColor), fontSize = (24f * contentScale).sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (record.date.isNotBlank()) Text(record.date, color = parseColor(config.foregroundColor).copy(alpha = 0.72f), fontSize = (18f * contentScale).sp, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                values.forEachIndexed { index, (field, value) ->
                    Text(
                        if (index == 0) "TODAY'S LUNCH" else menuFieldLabel(field).uppercase(),
                        color = parseColor(config.foregroundColor).copy(alpha = 0.72f),
                        fontSize = ((if (index == 0) 20f else 16f) * contentScale).sp,
                        fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = ((if (index == 0) 28f else 22f) * contentScale).dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        value,
                        color = parseColor(config.foregroundColor),
                        fontSize = ((if (index == 0) 52f else 34f) * contentScale).sp,
                        fontWeight = if (index == 0) FontWeight.Bold else FontWeight.Medium,
                        textAlign = TextAlign.Center,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

internal fun menuContentScale(itemCount: Int, availableHeightDp: Float, textScale: Int? = null): Float {
    val estimatedBaseHeight = 50f + itemCount.coerceAtLeast(1) * 150f
    val fitScale = availableHeightDp / estimatedBaseHeight
    return (fitScale * widgetAuthorScale(textScale)).coerceIn(0.05f, fitScale)
}

@Composable
private fun DisplayStructuredWidget(config: DisplayWidgetConfig, data: StructuredSourceConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val serverNow = LocalTilecastServerNow.current
    var now by remember { mutableStateOf(serverNow()) }
    LaunchedEffect(data.dateSelection.timezone) {
        while (true) {
            now = serverNow()
            delay(30_000)
        }
    }
    val rows = selectDateAwareRecords(data, now, regional.firstDay()).take(config.maximumItems).map { record ->
        config.fields.mapNotNull { field -> structuredFieldValue(record, field).takeIf(String::isNotBlank) }.joinToString("  ")
    }.filter(String::isNotBlank)
    DisplayRows(config, rows, data.emptyState)
}

private fun structuredFieldValue(record: org.tilecast.player.network.StructuredRecord, field: String): String = when (field) {
    "title" -> record.title
    "subtitle" -> record.subtitle
    "date" -> record.date
    "author" -> record.author
    "description" -> record.description
    else -> record.values[field].orEmpty()
}

internal fun menuFieldLabel(field: String): String {
    return when (field.lowercase()) {
        "option_2", "alternative", "secondary", "secondary_option" -> "Alternative"
        "option_1", "primary", "primary_option", "entree", "entrée" -> "Entrée"
        else -> field.replace('_', ' ').replace('-', ' ').trim().split(Regex("\\s+")).filter(String::isNotBlank).joinToString(" ") { token -> token.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() } }
    }
}
@Composable
private fun DisplayCalendarWidget(config: DisplayWidgetConfig, data: org.tilecast.player.network.CalendarSourceConfig) {
    val regional = LocalTilecastRegionalFormatting.current
    val now = LocalTilecastServerNow.current()
    val zone = runCatching { ZoneId.of(data.timezone) }.getOrDefault(regional.formatZone())
    val rows = visibleCalendarEvents(data, now, regional.firstDay()).take(config.maximumItems).map { event ->
        val whenText = runCatching {
            Instant.parse(event.start).atZone(zone).let { "${regional.formatDate(it.toLocalDate())} ${regional.formatTime(it)}" }
        }.getOrDefault(event.start)
        listOf(whenText, event.title, event.location).filter(String::isNotBlank).joinToString("  ")
    }
    DisplayRows(config, rows, "No items available")
}

@Composable
private fun DisplayRows(config: DisplayWidgetConfig, rows: List<String>, emptyState: String) {
    BoxWithConstraints(Modifier.fillMaxSize().background(parseColor(config.backgroundColor))) {
        val horizontalInset = maxWidth.value * widgetPaddingFraction(config.contentPadding)
        val verticalInset = maxHeight.value * widgetPaddingFraction(config.contentPadding)
        val availableWidth = (maxWidth.value - horizontalInset * 2).coerceAtLeast(1f)
        val availableHeight = (maxHeight.value - verticalInset * 2).coerceAtLeast(1f)
        if (rows.isEmpty()) {
            Box(
                Modifier.fillMaxSize().padding(horizontal = horizontalInset.dp, vertical = verticalInset.dp),
                contentAlignment = Alignment.Center,
            ) {
                FittedWidgetText(emptyState, parseColor(config.foregroundColor), FontWeight.Normal, maxLines = 3, textScale = config.textScale)
            }
            return@BoxWithConstraints
        }
        val gap = (availableHeight * 0.025f).coerceAtLeast(2f)
        val fontScale = LocalDensity.current.fontScale
        val maximumRows = (availableHeight / (8f * fontScale * 1.2f + gap)).toInt().coerceAtLeast(1)
        val visibleRows = rows.take(maximumRows)
        val rowHeight = ((availableHeight - gap * (visibleRows.size - 1)) / visibleRows.size).coerceAtLeast(1f)
        Column(
            Modifier.fillMaxSize().padding(horizontal = horizontalInset.dp, vertical = verticalInset.dp),
            verticalArrangement = Arrangement.spacedBy(gap.dp),
        ) {
            visibleRows.forEach { row ->
                val size = scaledFittedFontSizeSp(
                    row.length,
                    availableWidth,
                    rowHeight,
                    fontScale,
                    textScale = config.textScale,
                )
                Text(
                    row,
                    modifier = Modifier.fillMaxWidth().height(rowHeight.dp),
                    color = parseColor(config.foregroundColor),
                    fontSize = size.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
@Composable
private fun CenteredWidget(background: String, contentPadding: Int?, content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().background(parseColor(background))) {
        val inset = widgetPaddingFraction(contentPadding)
        Box(
            Modifier.fillMaxSize().padding(
                horizontal = (maxWidth.value * inset).dp,
                vertical = (maxHeight.value * inset).dp,
            ),
            contentAlignment = Alignment.Center,
        ) { content() }
    }
}

@Composable
private fun FittedWidgetText(
    text: String,
    color: Color,
    weight: FontWeight,
    maxLines: Int = 1,
    textScale: Int? = null,
) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val fontScale = LocalDensity.current.fontScale
        val initialSize = scaledFittedFontSizeSp(
            textLength = text.length,
            widthDp = maxWidth.value,
            heightDp = maxHeight.value,
            fontScale = fontScale,
            maxLines = maxLines,
            textScale = textScale,
        )
        var fontSize by remember(text, maxWidth, maxHeight, fontScale, maxLines, textScale) {
            mutableStateOf(initialSize)
        }
        Text(
            text = text,
            modifier = Modifier.fillMaxWidth(),
            color = color,
            fontSize = fontSize.sp,
            fontWeight = weight,
            maxLines = maxLines,
            softWrap = maxLines > 1,
            overflow = TextOverflow.Clip,
            textAlign = TextAlign.Center,
            onTextLayout = { result ->
                if ((result.didOverflowWidth || result.didOverflowHeight) && fontSize > 8f) {
                    fontSize = (fontSize * 0.9f).coerceAtLeast(8f)
                }
            },
        )
    }
}

internal fun widgetAuthorScale(textScale: Int?): Float =
    (textScale ?: 100).coerceIn(25, 500) / 100f

internal fun widgetPaddingFraction(contentPadding: Int?): Float =
    (contentPadding ?: 10).coerceIn(0, 40) / 100f

internal fun scaledFittedFontSizeSp(
    textLength: Int,
    widthDp: Float,
    heightDp: Float,
    fontScale: Float,
    maxLines: Int = 1,
    textScale: Int? = null,
): Float {
    val fitted = fittedFontSizeSp(
        textLength,
        widthDp,
        heightDp,
        fontScale,
        Float.MAX_VALUE,
        maxLines,
    )
    // The fitted size is a width-estimate, not a hard bound: capping the result
    // at it would make every scale above 100 percent a no-op. Enlarging is
    // allowed and the caller's measured-overflow guard is what actually keeps
    // the text inside the content area.
    return fitted * widgetAuthorScale(textScale)
}

internal fun fittedFontSizeSp(
    textLength: Int,
    widthDp: Float,
    heightDp: Float,
    fontScale: Float,
    maximumFontSizeSp: Float,
    maxLines: Int = 1,
): Float {
    val lines = maxLines.coerceAtLeast(1)
    val charactersPerLine = ((textLength.coerceAtLeast(1) + lines - 1) / lines).toFloat()
    val scale = fontScale.coerceAtLeast(0.5f)
    val widthLimit = widthDp / (charactersPerLine * 0.62f) / scale
    val heightLimit = heightDp * 0.72f / lines / scale
    return minOf(maximumFontSizeSp, widthLimit, heightLimit).coerceAtLeast(minOf(8f, maximumFontSizeSp))
}
private fun parseColor(value: String) = runCatching { Color(android.graphics.Color.parseColor(value)) }.getOrDefault(Color.Black)
private fun qrBitmap(config: QRCodeWidgetConfig): Bitmap { val level = when (config.errorCorrection) { "low" -> ErrorCorrectionLevel.L; "quartile" -> ErrorCorrectionLevel.Q; "high" -> ErrorCorrectionLevel.H; else -> ErrorCorrectionLevel.M }; val matrix = QRCodeWriter().encode(config.value, BarcodeFormat.QR_CODE, 480, 480, mapOf(EncodeHintType.ERROR_CORRECTION to level, EncodeHintType.MARGIN to 2)); val foreground = android.graphics.Color.parseColor(config.foregroundColor); val background = android.graphics.Color.parseColor(config.backgroundColor); return Bitmap.createBitmap(480, 480, Bitmap.Config.RGB_565).apply { for (x in 0 until 480) for (y in 0 until 480) setPixel(x, y, if (matrix[x, y]) foreground else background) } }
