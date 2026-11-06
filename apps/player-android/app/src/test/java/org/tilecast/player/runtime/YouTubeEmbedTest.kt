package org.tilecast.player.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.runtime.RemoteWebHostManager.YouTubeContent

class YouTubeEmbedTest {
    private fun content(
        videoId: String? = "M7lc1UVf-VE",
        playlistId: String? = null,
        loop: Boolean = false,
        muted: Boolean = false,
        endSeconds: Int? = null,
        captions: Boolean = false,
        language: String = "",
    ) = YouTubeContent(videoId, playlistId, 5, endSeconds, loop, muted, 60, captions, language, false)

    @Test fun passesConfigurationAsOneJsonLiteral() {
        val html = YouTubeEmbed.html(content(loop = true, endSeconds = 90, captions = true, language = "en-US"))
        assertTrue(html.contains("""var CFG={"playlist":false,"id":"M7lc1UVf-VE","start":5,"end":90,"loop":true,"muted":false,"volume":60,"captions":true,"captionLanguage":"en-US","controls":false,"origin":"https://org.tilecast.player"};"""))
        assertTrue(html.contains("https://www.youtube.com/iframe_api"))
    }

    @Test fun playlistsUseTheListParameters() {
        val html = YouTubeEmbed.html(content(videoId = null, playlistId = "PLabcdef123"))
        assertTrue(html.contains(""""playlist":true,"id":"PLabcdef123""""))
        assertTrue(html.contains("vars.listType='playlist';vars.list=CFG.id;"))
    }

    @Test fun nullEndStaysNullAndMarkupIsEscaped() {
        assertTrue(YouTubeEmbed.html(content()).contains(""""end":null"""))
        // Validation rejects such ids; the document builder must still never emit raw markup.
        val html = YouTubeEmbed.html(content(videoId = "</script><script>x()</script>"))
        assertFalse(html.contains("</script><script>x()"))
        assertTrue(html.contains("\\u003c/script>"))
    }

    @Test fun mapsWrapperStatesToRemoteEvents() {
        assertEquals("media-ended" to null, YouTubeEmbed.eventFor("ended", null))
        assertEquals("loaded" to null, YouTubeEmbed.eventFor("ready", null))
        assertEquals("stream-ready" to null, YouTubeEmbed.eventFor("playing", null))
        assertEquals("failed" to "youtube_150", YouTubeEmbed.eventFor("player_error", "youtube_150"))
        assertEquals("failed" to "autoplay_blocked", YouTubeEmbed.eventFor("autoplay_blocked", null))
        assertNull(YouTubeEmbed.eventFor("paused", null))
        assertNull(YouTubeEmbed.eventFor("buffering", null))
    }

    @Test fun muteFollowsAuthorRuntimeAndVisibility() {
        assertFalse(YouTubeEmbed.effectiveMute(content(), surfaceMuted = false, visible = true))
        assertTrue(YouTubeEmbed.effectiveMute(content(muted = true), surfaceMuted = false, visible = true))
        assertTrue(YouTubeEmbed.effectiveMute(content(), surfaceMuted = true, visible = true))
        assertTrue(YouTubeEmbed.effectiveMute(content(), surfaceMuted = false, visible = false))
    }

    @Test fun audioScriptClampsVolume() {
        assertEquals(
            "if(window.tilecastSetMuted){window.tilecastSetMuted(true);}if(window.player){window.player.setVolume(100);}",
            YouTubeEmbed.audioScript(true, 400),
        )
    }
}
