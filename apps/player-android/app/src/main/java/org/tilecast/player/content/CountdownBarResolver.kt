package org.tilecast.player.content

import org.tilecast.player.network.ManifestPlugin
import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlin.math.roundToInt

/**
 * Countdown Bar schedule resolution. This mirrors the Linux renderer's
 * countdown-bar-resolver: the same weekly, one-time, DST, completion, priority,
 * and fill rules, so a bar targeted at both platforms behaves identically.
 * Recurrence is evaluated locally from the cached manifest, so an offline player
 * keeps showing and hiding bars on schedule.
 */
internal data class ActiveCountdownBar(
    val id: String,
    val message: String,
    val value: String,
    val displayMode: String,
    val heightPx: Int,
    val priority: Int,
    val targetAt: Instant,
    val completed: Boolean,
    val showBar: Boolean,
    val showConfetti: Boolean,
    val urgencyStage: String,
    val urgencyLabel: String,
    val pulse: Boolean,
    /**
     * Share of the lead window still to run: 1 when the bar appears, 0 at the
     * target, and 0 while completion text shows. Null when the instance asked
     * for no fill.
     */
    val remainingFraction: Float?,
    /** Gutter on each side, as a percentage of the bar width. */
    val contentPadding: Int,
    /** Type size in scale-independent pixels, already scaled. */
    val fontSizeSp: Float,
)

private val CompletionDisplay: Duration = Duration.ofMinutes(1)
private val ConfettiDisplay: Duration = Duration.ofSeconds(12)

internal fun resolveCountdownBar(
    plugins: List<ManifestPlugin>,
    now: Instant,
    clockOffsetSeconds: Long? = null,
    clockOffsetMillis: Long? = null,
): ActiveCountdownBar? {
    val at = now.plusMillis(clockOffsetMillis ?: (clockOffsetSeconds ?: 0) * 1_000L)
    val active = mutableListOf<ActiveCountdownBar>()
    for (plugin in plugins) {
        if (plugin.type != "countdown_bar" || plugin.version != 1) continue
        val config = plugin.config
        val leadMs = config.leadTimeSeconds * 1_000L
        for (target in countdownBarTargets(plugin, at)) {
            val remainingMs = Duration.between(at, target).toMillis()
            val completionText = config.completionText.trim()
            val completionVisible =
                remainingMs <= 0 &&
                    remainingMs >= -CompletionDisplay.toMillis() &&
                    completionText.isNotEmpty()
            val confettiVisible =
                remainingMs <= 0 &&
                    remainingMs >= -ConfettiDisplay.toMillis() &&
                    config.showConfetti
            if (remainingMs > leadMs || (remainingMs <= 0 && !completionVisible && !confettiVisible)) continue
            val fraction = if (leadMs > 0) (remainingMs.toFloat() / leadMs).coerceIn(0f, 1f) else 0f
            val urgencyStage =
                when {
                    !config.urgencyEnabled || remainingMs <= 0 -> "normal"
                    remainingMs <= config.pulseSeconds.coerceIn(1, 60) * 1_000L -> "final"
                    remainingMs <= config.urgentSeconds.coerceIn(2, 3_600) * 1_000L -> "urgent"
                    remainingMs <= config.startingSoonSeconds.coerceIn(2, 86_400) * 1_000L -> "starting_soon"
                    else -> "normal"
                }
            val finalScale = if (urgencyStage == "final") 1.25f else 1f
            val baseHeight = config.heightPx.coerceIn(40, 320)
            active +=
                ActiveCountdownBar(
                    id = plugin.id,
                    // Completion text is the whole ending message. Retaining
                    // the normal prefix would render phrases such as
                    // "Lunch ends in Lunch is over".
                    message = if (remainingMs <= 0) "" else config.message,
                    value =
                        when {
                            completionVisible -> completionText
                            remainingMs > 0 -> compactCountdown(remainingMs)
                            else -> ""
                        },
                    displayMode = config.displayMode,
                    heightPx = (baseHeight * finalScale).roundToInt(),
                    priority = config.priority,
                    targetAt = target,
                    completed = remainingMs <= 0,
                    showBar = remainingMs > 0 || completionVisible,
                    showConfetti = confettiVisible,
                    urgencyStage = urgencyStage,
                    urgencyLabel =
                        when (urgencyStage) {
                            "starting_soon" -> "Starting soon"
                            "urgent", "final" -> "Urgent"
                            else -> ""
                        },
                    pulse = urgencyStage == "final",
                    remainingFraction = if (config.progressFill == "drain") fraction else null,
                    contentPadding = config.contentPadding.coerceIn(0, 40),
                    fontSizeSp = countdownBarFontSize(config.heightPx, config.textScale) * finalScale,
                )
        }
    }
    return active
        .sortedWith(
            compareByDescending<ActiveCountdownBar> { it.priority }
                .thenBy { it.targetAt }
                .thenBy { it.id },
        )
        .firstOrNull()
}

/**
 * Candidate targets around now. A lead window may open up to 30 days before its
 * target, and looking backwards as well keeps completion text alive just after
 * the preceding occurrence.
 */
private fun countdownBarTargets(plugin: ManifestPlugin, now: Instant): List<Instant> {
    val config = plugin.config
    if (config.scheduleType == "one_time") {
        val parsed =
            config.oneTimeAt?.let { value ->
                runCatching { Instant.parse(value) }.getOrNull()
                    ?: runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
            }
        return listOfNotNull(parsed)
    }
    val time = parseTargetTime(config.targetTime) ?: return emptyList()
    if (config.daysOfWeek.isEmpty()) return emptyList()
    val zone = runCatching { ZoneId.of(config.timezone) }.getOrDefault(ZoneId.of("UTC"))
    val days = config.daysOfWeek.mapNotNull(::isoDayOfWeek).toSet()
    if (days.isEmpty()) return emptyList()
    val today = now.atZone(zone).toLocalDate()
    val targets = mutableListOf<Instant>()
    for (offset in -31L..31L) {
        val date: LocalDate = today.plusDays(offset)
        if (date.dayOfWeek !in days) continue
        // ZonedDateTime resolves a wall time that a DST jump skipped or repeated,
        // which is what keeps a 12:00 bar at local noon across the boundary.
        targets += date.atTime(time).atZone(zone).toInstant()
    }
    return targets
}

/** Manifest days are 0=Sunday through 6=Saturday. */
private fun isoDayOfWeek(day: Int): DayOfWeek? =
    when (day) {
        0 -> DayOfWeek.SUNDAY
        1 -> DayOfWeek.MONDAY
        2 -> DayOfWeek.TUESDAY
        3 -> DayOfWeek.WEDNESDAY
        4 -> DayOfWeek.THURSDAY
        5 -> DayOfWeek.FRIDAY
        6 -> DayOfWeek.SATURDAY
        else -> null
    }

/** Accepts the HH:MM the API publishes and the HH:MM:SS Postgres can render. */
private fun parseTargetTime(value: String?): LocalTime? {
    val match = Regex("^(\\d{2}):(\\d{2})(?::(\\d{2}))?$").matchEntire(value ?: "") ?: return null
    val hour = match.groupValues[1].toIntOrNull() ?: return null
    val minute = match.groupValues[2].toIntOrNull() ?: return null
    val second = match.groupValues[3].takeIf { it.isNotEmpty() }?.toIntOrNull() ?: 0
    if (hour > 23 || minute > 59 || second > 59) return null
    return LocalTime.of(hour, minute, second)
}

/**
 * Type size follows the bar height, clamped as the Linux stylesheet clamps it,
 * then scaled. The scale multiplies the clamped result so a bar can exceed the
 * unscaled 72 ceiling deliberately rather than by accident.
 */
internal fun countdownBarFontSize(heightPx: Int, textScale: Int): Float {
    val base = (heightPx * 0.42f).coerceIn(22f, 72f)
    return base * (textScale.coerceIn(25, 500) / 100f)
}

/**
 * The same compact vocabulary the Linux renderer and Studio use, so one bar does
 * not read "5m 4s" on one platform and "5:04" on another.
 */
internal fun compactCountdown(remainingMilliseconds: Long): String {
    if (remainingMilliseconds <= 0) return "Now"
    val totalSeconds = remainingMilliseconds / 1_000
    val days = totalSeconds / 86_400
    val hours = (totalSeconds % 86_400) / 3_600
    val minutes = (totalSeconds % 3_600) / 60
    val seconds = totalSeconds % 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}m"
        minutes > 0 -> "${minutes}m ${seconds}s"
        else -> "${seconds}s"
    }
}
