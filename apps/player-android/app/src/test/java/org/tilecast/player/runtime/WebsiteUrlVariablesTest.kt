package org.tilecast.player.runtime

import java.net.URL
import java.net.URLDecoder
import java.time.Instant
import java.util.TimeZone
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.ManifestDataSource

class WebsiteUrlVariablesTest {
    private val source = ManifestDataSource(
        id = "school-list",
        name = "Rooms",
        provider = "manual",
        configuration = buildJsonObject {
            putJsonArray("records") {
                addJsonObject {
                    put("id", "1")
                    putJsonObject("values") { put("room", "Кабинет & 3") }
                }
                addJsonObject {
                    put("id", "2")
                    putJsonObject("values") { put("room", "Актовый зал") }
                }
            }
        },
    )
    private fun param(url: String, name: String): String {
        val encoded = URL(url).query.split('&').first { it.substringBefore('=') == name }
        return URLDecoder.decode(encoded.substringAfter('=', ""), "UTF-8")
    }

    @Test fun expandsScreenAndDataFieldsSafely() {
        val result = WebsiteUrlVariables.resolve(
            "https://example.org/screen?s={screen.id}&room={data.room}&next={data.room:1}&all={data.json}",
            screenId = "screen-123",
            dataSourceId = "school-list",
            sources = listOf(source),
        )
        requireNotNull(result)
        assertEquals("example.org", URL(result).host)
        assertEquals("/screen", URL(result).path)
        assertEquals("screen-123", param(result, "s"))
        assertEquals("Кабинет & 3", param(result, "room"))
        assertEquals("Актовый зал", param(result, "next"))
        assertTrue(param(result, "all").contains("Актовый зал"))
    }

    @Test fun timestampsUseLocalDateAndTime() {
        val original = TimeZone.getDefault()
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
            val result = WebsiteUrlVariables.resolve(
                "https://example.org/?d={date}&t={time}",
                "screen-1",
                Instant.parse("2026-11-07T09:05:04Z"),
            )
            requireNotNull(result)
            assertEquals("2026-11-07", param(result, "d"))
            assertEquals("09:05:04", param(result, "t"))
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test fun staticUrlIsUnchangedAndUnknownValuesFailClosed() {
        val static = "https://example.org/x?q=1&room=%26"
        assertEquals(static, WebsiteUrlVariables.resolve(static, "screen-1"))
        assertNull(WebsiteUrlVariables.resolve("https://example.org/?x={missing}", "s"))
        assertNull(WebsiteUrlVariables.resolve("https://example.org/{date}", "s"))
        assertNull(WebsiteUrlVariables.resolve("https://{screen.id}.org/?x=1", "s"))
    }
}
