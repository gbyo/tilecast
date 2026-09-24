package org.tilecast.player.content

import java.time.Instant
import java.time.LocalDate
import java.time.DayOfWeek
import java.time.temporal.TemporalAdjusters
import java.time.ZoneId
import org.tilecast.player.network.StructuredRecord
import org.tilecast.player.network.StructuredSourceConfig

// Structured Data Sources are never rendered directly; Widgets and Layout text bindings
// display their cached records. This local, offline selection is re-evaluated from the
// already cached dataset, so date changes, DST transitions, reboots, sleep recovery,
// timezone changes, and clock corrections never require a new manifest.
internal fun selectDateAwareRecords(config: StructuredSourceConfig, now: Instant, firstDayOfWeek: DayOfWeek = DayOfWeek.MONDAY): List<StructuredRecord> {
	val selection = config.dateSelection
	if (!selection.enabled) return config.data.records
	val zone = runCatching { ZoneId.of(selection.timezone) }.getOrDefault(ZoneId.of("UTC"))
	val today = now.atZone(zone).toLocalDate()
	val target = if (selection.mode == "tomorrow") today.plusDays(1) else today
	fun date(record: StructuredRecord): LocalDate? = runCatching { if (record.date.contains('T')) Instant.parse(record.date).atZone(zone).toLocalDate() else LocalDate.parse(record.date.take(10)) }.getOrNull()
	val dated = config.data.records.mapNotNull { record -> date(record)?.let { it to record } }
	var matches = dated.filter { (value, _) -> !selection.excludePast || !value.isBefore(today) }.filter { (value, _) -> when (selection.mode) {
		"next_available" -> !value.isBefore(target)
		"current_week" -> { val start = today.with(TemporalAdjusters.previousOrSame(firstDayOfWeek)); !value.isBefore(start) && !value.isAfter(start.plusDays(6)) }
		"custom_range" -> runCatching { !value.isBefore(LocalDate.parse(selection.customStartDate)) && !value.isAfter(LocalDate.parse(selection.customEndDate)) }.getOrDefault(false)
		else -> value == target
	} }
	if (selection.mode == "next_available" && matches.isNotEmpty()) { val first = matches.minOf { it.first }; matches = matches.filter { it.first == first } }
	if (matches.isNotEmpty()) return matches.map { it.second }
	return when (selection.noMatchBehavior) {
		"next_available" -> { val future = dated.filter { it.first.isAfter(target) }; future.minOfOrNull { it.first }?.let { next -> future.filter { it.first == next }.map { it.second } } ?: emptyList() }
		"last_known_good" -> { val past = dated.filter { it.first.isBefore(target) }; past.maxOfOrNull { it.first }?.let { last -> past.filter { it.first == last }.map { it.second } } ?: emptyList() }
		"fallback_text" -> listOf(StructuredRecord("date-fallback", selection.fallbackText))
		else -> emptyList()
	}
}
