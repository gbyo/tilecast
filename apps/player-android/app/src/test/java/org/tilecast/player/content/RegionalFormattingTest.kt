package org.tilecast.player.content

import java.util.Locale
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.RegionalFormatting

class RegionalFormattingTest {
    private fun profile(
        locale: String,
        timezone: String = "UTC",
        dateFormat: String = "locale",
        timeFormat: String = "locale",
        firstDayOfWeek: String = "monday",
    ) = RegionalFormatting(locale, timezone, dateFormat, timeFormat, firstDayOfWeek)

    @Test
    fun organizationLocaleControlsNumberSeparatorsIndependentOfDeviceLocale() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val cases = listOf(
                "en-US" to "12,345.6",
                "en-GB" to "12,345.6",
                "de-DE" to "12.345,6",
                "es-ES" to "12.345,6",
                "ru-RU" to "12\u00a0345,6",
            )
            cases.forEach { (locale, expected) ->
                val result = profile(locale).formatValue("12345.6", "number", 1)
                    .replace('\u202f', '\u00a0')
                assertTrue("$locale produced $result", result.contains(expected))
            }
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test
    fun explicitEuroMetadataWinsOverUsDeviceCurrency() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val result = profile("de-DE").formatValue("1234.5", "currency", 2, "EUR")
                .replace('\u00a0', ' ')
                .replace('\u202f', ' ')
            assertTrue(result.contains("1.234,50"))
            assertTrue(result.contains("€"))
            assertFalse(result.contains("$"))
            assertFalse(result.contains("USD"))
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test
    fun currencyWithoutMetadataIsAPlainLocalizedNumber() {
        val result = profile("de-DE").formatValue("1234.5", "currency", 2)
        assertTrue(result.replace('\u00a0', ' ').contains("1.234,50"))
        assertFalse(result.contains("€"))
        assertFalse(result.contains("$"))
    }

    @Test
    fun organizationTimezoneControlsDateAndExplicitClockChoiceWins() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val instant = "2026-01-01T00:30:00Z"
            val berlin = profile("de-DE", "Europe/Berlin", timeFormat = "24-hour")
                .formatValue(instant, "time", null)
            val tokyo = profile("ja-JP", "Asia/Tokyo", timeFormat = "24-hour")
                .formatValue(instant, "time", null)
            val sydney = profile("en-AU", "Australia/Sydney", timeFormat = "24-hour")
                .formatValue(instant, "time", null)
            assertTrue(berlin.contains("01:30"))
            assertTrue(tokyo.contains("09:30"))
            assertTrue(sydney.contains("11:30"))

            val twelveHour = profile("de-DE", timeFormat = "12-hour")
                .formatTime(java.time.Instant.parse("2026-01-01T13:05:00Z").atZone(java.time.ZoneId.of("UTC")))
            val twentyFourHour = profile("en-US", timeFormat = "24-hour")
                .formatTime(java.time.Instant.parse("2026-01-01T13:05:00Z").atZone(java.time.ZoneId.of("UTC")))
            assertTrue(twelveHour.contains("1:05 PM"))
            assertTrue(twentyFourHour.contains("13:05"))
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test
    fun explicitDatePreferenceControlsDateOrder() {
        val result = profile("de-DE", dateFormat = "dd/MM/yyyy")
            .formatValue("2026-07-04", "date", null)
        assertTrue(result.contains("04/07/2026"))
    }

    @Test
    fun legacyServerWithoutRegionalProfileRetainsDeviceFallback() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US)
            val result = (null as RegionalFormatting?).formatValue("1234.5", "number", 1)
            assertTrue(result.contains("1,234.5"))
        } finally {
            Locale.setDefault(original)
        }
    }
}
