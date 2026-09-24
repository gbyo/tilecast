package org.tilecast.player.content

import androidx.compose.runtime.compositionLocalOf
import org.tilecast.player.network.RegionalFormatting
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.DecimalStyle
import java.time.DayOfWeek
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/** Organization-owned signage formatting; null means an older Server omitted it. */
val LocalTilecastRegionalFormatting = compositionLocalOf<RegionalFormatting?> { null }

internal fun RegionalFormatting?.formatLocale(): Locale {
    if (this == null) return Locale.getDefault() // Preserve the pre-contract Android behavior.
    return Locale.forLanguageTag(locale).takeIf { it.language.isNotBlank() } ?: Locale.ROOT
}

internal fun RegionalFormatting?.formatZone(): ZoneId {
    if (this == null) return ZoneId.systemDefault() // Preserve the pre-contract Android behavior.
    return runCatching { ZoneId.of(timezone) }.getOrDefault(ZoneId.of("UTC"))
}

internal fun RegionalFormatting?.firstDay(): DayOfWeek = when (this?.firstDayOfWeek) {
    "sunday" -> DayOfWeek.SUNDAY
    "monday" -> DayOfWeek.MONDAY
    "tuesday" -> DayOfWeek.TUESDAY
    "wednesday" -> DayOfWeek.WEDNESDAY
    "thursday" -> DayOfWeek.THURSDAY
    "friday" -> DayOfWeek.FRIDAY
    "saturday" -> DayOfWeek.SATURDAY
    else -> DayOfWeek.MONDAY // The existing Android selection behavior.
}

internal fun RegionalFormatting?.formatDate(
    date: LocalDate,
    explicitStyle: FormatStyle? = null,
): String {
    val locale = formatLocale()
    val pattern = if (explicitStyle == null) {
        when (this?.dateFormat) {
            "yyyy-MM-dd" -> "uuuu-MM-dd"
            "MM/dd/yyyy" -> "MM/dd/uuuu"
            "dd/MM/yyyy" -> "dd/MM/uuuu"
            else -> null
        }
    } else null
    val formatter = pattern?.let {
        DateTimeFormatter.ofPattern(it, locale).withDecimalStyle(DecimalStyle.of(locale))
    } ?: DateTimeFormatter.ofLocalizedDate(explicitStyle ?: FormatStyle.SHORT).withLocale(locale)
    return date.format(formatter)
}

internal fun RegionalFormatting?.formatTime(
    value: ZonedDateTime,
    explicitFormat: String? = null,
    showSeconds: Boolean = false,
): String {
    val choice = when (explicitFormat) {
        "12", "12-hour" -> "12-hour"
        "24", "24-hour" -> "24-hour"
        else -> this?.timeFormat ?: "locale"
    }
    if (choice == "locale") {
        val style = if (showSeconds) FormatStyle.MEDIUM else FormatStyle.SHORT
        return value.format(DateTimeFormatter.ofLocalizedTime(style).withLocale(formatLocale()))
    }
    val pattern = when (choice) {
        "12-hour" -> if (showSeconds) "h:mm:ss a" else "h:mm a"
        else -> if (showSeconds) "HH:mm:ss" else "HH:mm"
    }
    return value.format(DateTimeFormatter.ofPattern(pattern, formatLocale()))
}

internal fun RegionalFormatting?.formatValue(
    value: String,
    format: String,
    precision: Int?,
    currencyCode: String? = null,
    now: Instant = Instant.now(),
): String {
    if (format == "datetime") {
        val dateTime = parseRegionalDateTime(value, formatZone()) ?: return value
        return "${formatDate(dateTime.toLocalDate())} ${formatTime(dateTime)}"
    }
    if (format == "date" || format == "date-short" || format == "date-long") {
        val explicitStyle = when (format) {
            "date-short" -> FormatStyle.SHORT
            "date-long" -> FormatStyle.FULL
            else -> null
        }
        val date = parseRegionalDate(value, formatZone()) ?: return value
        return formatDate(date, explicitStyle)
    }
    if (format == "time") {
        val instant = parseRegionalInstant(value, formatZone()) ?: return value
        return formatTime(instant.atZone(formatZone()))
    }
    if (format == "relative-countdown") {
        val target = parseRegionalInstant(value, formatZone()) ?: return value
        return compactCountdown(java.time.Duration.between(now, target).toMillis())
    }
    val number = value.toDoubleOrNull() ?: return value
    val locale = formatLocale()
    val formatter = when (format) {
        "integer" -> NumberFormat.getIntegerInstance(locale)
        "percent" -> NumberFormat.getPercentInstance(locale)
        "currency" -> {
            val currency = currencyCode?.trim()?.uppercase(Locale.ROOT)
            if (currency.isNullOrBlank()) {
                NumberFormat.getNumberInstance(locale)
            } else {
                runCatching {
                    val semanticCurrency = Currency.getInstance(currency)
                    NumberFormat.getCurrencyInstance(locale).apply {
                        this.currency = semanticCurrency
                        if (precision == null && semanticCurrency.defaultFractionDigits >= 0) {
                            minimumFractionDigits = semanticCurrency.defaultFractionDigits
                            maximumFractionDigits = semanticCurrency.defaultFractionDigits
                        }
                    }
                }.getOrElse { NumberFormat.getNumberInstance(locale) }
            }
        }
        "number" -> NumberFormat.getNumberInstance(locale)
        else -> return value
    }
    if (format == "percent") formatter.formatterDigits(precision)
    else precision?.let { formatter.minimumFractionDigits = it; formatter.maximumFractionDigits = it }
    return formatter.format(if (format == "percent") number / 100 else number)
}

private fun NumberFormat.formatterDigits(precision: Int?) {
    precision?.let { minimumFractionDigits = it; maximumFractionDigits = it }
}

private fun parseRegionalDate(value: String, zone: ZoneId): LocalDate? {
    val trimmed = value.trim()
    if (trimmed.contains('T') || trimmed.contains(' ')) {
        parseRegionalInstant(trimmed, zone)?.let { return it.atZone(zone).toLocalDate() }
    }
    return runCatching { LocalDate.parse(trimmed.take(10)) }.getOrNull()
}

private fun parseRegionalDateTime(value: String, zone: ZoneId): ZonedDateTime? =
    runCatching { Instant.parse(value).atZone(zone) }.getOrNull()
        ?: runCatching { java.time.OffsetDateTime.parse(value).atZoneSameInstant(zone) }.getOrNull()
        ?: runCatching { java.time.LocalDateTime.parse(value).atZone(zone) }.getOrNull()

private fun parseRegionalInstant(value: String, zone: ZoneId): Instant? =
    runCatching { Instant.parse(value) }.getOrNull()
        ?: runCatching { java.time.OffsetDateTime.parse(value).toInstant() }.getOrNull()
        ?: runCatching { java.time.LocalDateTime.parse(value).atZone(zone).toInstant() }.getOrNull()
