package org.tilecast.player.content

import org.junit.Assert.assertEquals
import org.junit.Test
import org.tilecast.player.network.CalendarEvent
import org.tilecast.player.network.CalendarPreparedData
import org.tilecast.player.network.CalendarSourceConfig
import java.time.Instant
import java.time.DayOfWeek

class CalendarPlaybackTest {
    @Test
    fun thisWeekUsesConfiguredFirstDay() {
        val config = CalendarSourceConfig(
            displayMode = "this_week",
            timezone = "UTC",
            data = CalendarPreparedData(events = listOf(
                CalendarEvent("friday", "School", "Friday", "2026-07-10T09:00:00Z", "2026-07-10T10:00:00Z", false),
                CalendarEvent("sunday", "School", "Sunday", "2026-07-12T09:00:00Z", "2026-07-12T10:00:00Z", false),
                CalendarEvent("saturday", "School", "Saturday", "2026-07-18T09:00:00Z", "2026-07-18T10:00:00Z", false),
            )),
        )
        val now = Instant.parse("2026-07-15T12:00:00Z")
        assertEquals(listOf("Sunday", "Saturday"), visibleCalendarEvents(config, now, DayOfWeek.SUNDAY).map { it.title })
        assertEquals(listOf("Saturday"), visibleCalendarEvents(config, now, DayOfWeek.MONDAY).map { it.title })
        assertEquals(listOf("Friday", "Sunday"), visibleCalendarEvents(config, now, DayOfWeek.FRIDAY).map { it.title })
    }

    @Test
    fun todayUsesConfiguredTimezoneAndIncludesAllDayEvents() {
        val config = CalendarSourceConfig(
            displayMode = "today",
            timezone = "America/New_York",
            data = CalendarPreparedData(events = listOf(
                CalendarEvent("1", "School", "All day", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", true),
                CalendarEvent("2", "School", "Tomorrow", "2026-03-09T13:00:00Z", "2026-03-09T14:00:00Z", false),
            )),
        )
        val events = visibleCalendarEvents(config, Instant.parse("2026-03-08T16:00:00Z"))
        assertEquals(listOf("All day"), events.map { it.title })
    }
}
