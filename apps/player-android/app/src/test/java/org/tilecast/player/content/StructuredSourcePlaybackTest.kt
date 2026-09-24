package org.tilecast.player.content

import java.time.Instant
import java.time.DayOfWeek
import org.junit.Assert.assertEquals
import org.junit.Test
import org.tilecast.player.network.DateSelection
import org.tilecast.player.network.StructuredPreparedData
import org.tilecast.player.network.StructuredRecord
import org.tilecast.player.network.StructuredSourceConfig

class StructuredSourcePlaybackTest {
    @Test fun currentWeekUsesConfiguredFirstDay() {
        val config = StructuredSourceConfig(
            dateSelection = DateSelection(enabled = true, timezone = "UTC", mode = "current_week"),
            data = StructuredPreparedData(records = listOf(
                StructuredRecord("friday", "Friday", date = "2026-07-10"),
                StructuredRecord("sunday", "Sunday", date = "2026-07-12"),
                StructuredRecord("saturday", "Saturday", date = "2026-07-18"),
            )),
        )
        val now = Instant.parse("2026-07-15T12:00:00Z")
        assertEquals(listOf("Sunday", "Saturday"), selectDateAwareRecords(config, now, DayOfWeek.SUNDAY).map { it.title })
        assertEquals(listOf("Saturday"), selectDateAwareRecords(config, now, DayOfWeek.MONDAY).map { it.title })
        assertEquals(listOf("Friday", "Sunday"), selectDateAwareRecords(config, now, DayOfWeek.FRIDAY).map { it.title })
    }

    @Test fun selectsLocalDateWithoutAssumingTwentyFourHours() {
        val config = StructuredSourceConfig(
            dateSelection = DateSelection(enabled = true, timezone = "America/New_York", mode = "today", noMatchBehavior = "empty"),
            data = StructuredPreparedData(records = listOf(
                StructuredRecord("before", "Sunday", date = "2026-03-08"),
                StructuredRecord("after", "Monday", date = "2026-03-09"),
            )),
        )
        val selected = selectDateAwareRecords(config, Instant.parse("2026-03-09T03:30:00Z"))
        assertEquals(listOf("Sunday"), selected.map { it.title })
    }

    @Test fun lastKnownGoodRequiresExplicitBehavior() {
        val data = StructuredPreparedData(records = listOf(StructuredRecord("old", "Friday menu", date = "2026-08-07")))
        val empty = StructuredSourceConfig(dateSelection = DateSelection(enabled = true, timezone = "UTC", mode = "today", noMatchBehavior = "empty"), data = data)
        assertEquals(0, selectDateAwareRecords(empty, Instant.parse("2026-08-08T12:00:00Z")).size)
        val fallback = empty.copy(dateSelection = empty.dateSelection.copy(noMatchBehavior = "last_known_good"))
        assertEquals("Friday menu", selectDateAwareRecords(fallback, Instant.parse("2026-08-08T12:00:00Z")).single().title)
    }
}
