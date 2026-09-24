package org.tilecast.player.content

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.tilecast.player.network.CalendarEvent
import org.tilecast.player.network.CalendarSourceConfig
import org.tilecast.player.network.ManifestDataSource
import org.tilecast.player.network.ManifestItem
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

internal fun visibleCalendarEvents(
    config: CalendarSourceConfig,
    now: Instant,
    firstDayOfWeek: DayOfWeek = DayOfWeek.MONDAY,
): List<CalendarEvent> {
    val zone = runCatching { ZoneId.of(config.timezone) }.getOrDefault(ZoneId.of("UTC"))
    val localNow = now.atZone(zone)
    val startOfToday = localNow.toLocalDate().atStartOfDay(zone).toInstant()
    val endOfToday = localNow.toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
    val weekStart = localNow.toLocalDate().with(TemporalAdjusters.previousOrSame(firstDayOfWeek)).atStartOfDay(zone).toInstant()
    val weekEnd = weekStart.atZone(zone).toLocalDate().plusDays(7).atStartOfDay(zone).toInstant()
    return config.data.events
        .asSequence()
        .filter { event ->
            val start = runCatching { Instant.parse(event.start) }.getOrNull() ?: return@filter false
            val end = runCatching { Instant.parse(event.end) }.getOrDefault(start)
            when (config.displayMode) {
                "today" -> start < endOfToday && end >= startOfToday
                "this_week" -> start < weekEnd && end >= weekStart
                else -> end >= now
            }
        }
        .sortedBy { it.start }
        .take(config.maxEvents.coerceIn(1, 100))
        .toList()
}

@Composable
fun CalendarSourceItem(
    item: ManifestItem,
    dataSource: ManifestDataSource,
    config: CalendarSourceConfig,
    onDone: () -> Unit,
    onStatus: (WidgetPlaybackStatus) -> Unit,
    startOffsetMs: Long = 0,
) {
    val now = Instant.now()
    val regional = LocalTilecastRegionalFormatting.current
    val events = visibleCalendarEvents(config, now, regional.firstDay())
    val state = if (config.data.unavailable) "unavailable" else if (config.data.usingCachedData) "cached" else if (events.isEmpty()) "empty" else "ready"
    DisposableEffect(dataSource.id, state) {
        onStatus(WidgetPlaybackStatus(dataSource.id, "calendar", state))
        onDispose { onStatus(WidgetPlaybackStatus()) }
    }
    LaunchedEffect(item.id, startOffsetMs) {
        delay(((item.durationMs ?: 30_000) - startOffsetMs).coerceAtLeast(1))
        onDone()
    }
    Column(
        modifier = Modifier.fillMaxSize().background(Color(0xFF0E141B)).padding(horizontal = 56.dp, vertical = 40.dp),
    ) {
        Text(dataSource.name, color = Color(0xFFF5F7FA), fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(24.dp))
        if (config.data.unavailable || events.isEmpty()) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if(config.data.unavailable) "Calendar temporarily unavailable" else config.emptyState, color = Color(0xFFB8C2CC), fontSize = 26.sp)
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                items(events, key = { it.id }) { event -> CalendarEventRow(event, config) }
            }
        }
    }
}

@Composable
private fun CalendarEventRow(event: CalendarEvent, config: CalendarSourceConfig) {
    val zone = runCatching { ZoneId.of(config.timezone) }.getOrDefault(ZoneId.of("UTC"))
    val regional = LocalTilecastRegionalFormatting.current
    val start = Instant.parse(event.start).atZone(zone)
    val end = Instant.parse(event.end).atZone(zone)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        if (config.fields.date || config.fields.startTime || config.fields.endTime) {
            Column(Modifier.fillMaxWidth(0.24f)) {
                if (config.fields.date) Text(regional.formatDate(start.toLocalDate()), color = Color(0xFF9FB7CB), fontSize = 18.sp)
                if (event.allDay) Text("All day", color = Color(0xFFF5F7FA), fontSize = 20.sp)
                else if (config.fields.startTime) {
                    val range = if (config.fields.endTime) "${regional.formatTime(start)} - ${regional.formatTime(end)}" else regional.formatTime(start)
                    Text(range, color = Color(0xFFF5F7FA), fontSize = 20.sp)
                }
            }
        }
        Column(Modifier.weight(1f)) {
            if (config.fields.title) Text(event.title.ifBlank { "Untitled event" }, color = Color(0xFFF5F7FA), fontSize = 24.sp, fontWeight = FontWeight.Medium)
            if (config.fields.location && event.location.isNotBlank()) Text(event.location, color = Color(0xFFB8C2CC), fontSize = 17.sp)
            if (config.fields.descriptionExcerpt && event.descriptionExcerpt.isNotBlank()) Text(event.descriptionExcerpt, color = Color(0xFFB8C2CC), fontSize = 16.sp, maxLines = 2)
        }
    }
    HorizontalDivider(Modifier.padding(top = 12.dp), color = Color(0xFF273642))
}
