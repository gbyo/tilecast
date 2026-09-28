package org.tilecast.player.content

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.YouTubeSourceConfig

class YouTubePlaybackTest {
    @Test
    fun embedIncludesOriginReferrerAndVideoControls() {
        val html = youtubeHTML(
            YouTubeSourceConfig(
                url = "https://youtu.be/dQw4w9WgXcQ",
                videoId = "dQw4w9WgXcQ",
                controls = true,
                volume = 70,
                startSeconds = 10,
            ),
            "https://tilecast.example",
            5_500,
        )
        assertTrue(html.contains("content=\"origin\""))
        assertTrue(html.contains("origin:'https://tilecast.example'"))
        assertTrue(html.contains("videoId:'dQw4w9WgXcQ'"))
        assertTrue(html.contains("controls:1"))
        assertTrue(html.contains("setVolume(70)"))
        assertTrue(html.contains("tilecastSetMuted"))
        assertTrue(html.contains("start:15.5"))
        assertFalse(html.contains("end:0"))
    }

    @Test
    fun playlistUsesYouTubePlaylistModeWithoutAnApiKey() {
        val html = youtubeHTML(
            YouTubeSourceConfig(
                url = "https://youtube.com/playlist?list=PL1234567890",
                kind = "playlist",
                playlistId = "PL1234567890",
            ),
            "https://tilecast.example",
        )
        assertTrue(html.contains("listType:'playlist'"))
        assertTrue(html.contains("list:'PL1234567890'"))
        assertFalse(html.contains("apiKey"))
    }
}
