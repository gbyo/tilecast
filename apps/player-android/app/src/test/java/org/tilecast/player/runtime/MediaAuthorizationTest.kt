package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.runtime.MediaAuthorization.AuthorizedMedia
import org.tilecast.player.runtime.MediaAuthorization.RangeDecision

class MediaAuthorizationTest {
    private val authorized = setOf(AuthorizedMedia("asset1", "v720"))

    @Test fun authorizesOnlyActiveManifestMedia() {
        assertEquals(AuthorizedMedia("asset1", "v720"), MediaAuthorization.authorize("tcmedia:asset1/v720", authorized))
        assertEquals(AuthorizedMedia("asset1", "v720"), MediaAuthorization.authorize("tcmedia://asset1/v720", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:other/v720", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/v1080", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/v720", emptySet()))
    }

    @Test fun refusesPathsAndSchemes() {
        assertNull(MediaAuthorization.authorize("/data/data/org.tilecast.player/files/a", authorized))
        assertNull(MediaAuthorization.authorize("file:///android_asset/a", authorized))
        assertNull(MediaAuthorization.authorize("content://media/external/a", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:../secret/x", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/../../x", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/v720?evil=1", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/v720#frag", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1", authorized))
        assertNull(MediaAuthorization.authorize("tcmedia:asset1/v720/extra", authorized))
        assertNull(MediaAuthorization.authorize("https://example.com/a.mp4", authorized))
        assertNull(MediaAuthorization.authorize(null, authorized))
    }

    @Test fun rangeDecisions() {
        assertEquals(RangeDecision.Full(100), MediaAuthorization.decideRange(null, 100))
        assertEquals(
            RangeDecision.Partial(MediaAuthorization.ByteRange(10, 29), 100),
            MediaAuthorization.decideRange("bytes=10-29", 100),
        )
        assertEquals(
            RangeDecision.Partial(MediaAuthorization.ByteRange(90, 99), 100),
            MediaAuthorization.decideRange("bytes=-10", 100),
        )
        assertEquals(
            RangeDecision.Partial(MediaAuthorization.ByteRange(50, 99), 100),
            MediaAuthorization.decideRange("bytes=50-", 100),
        )
        assertEquals(RangeDecision.Unsatisfiable(100), MediaAuthorization.decideRange("bytes=100-", 100))
        assertTrue(MediaAuthorization.decideRange("bytes=0-10,20-30", 100) is RangeDecision.Invalid)
        assertTrue(MediaAuthorization.decideRange("items=0-10", 100) is RangeDecision.Invalid)
        assertTrue(MediaAuthorization.decideRange("bytes=abc", 100) is RangeDecision.Invalid)
    }

    @Test fun contentRangeFormat() {
        assertEquals(
            "bytes 10-29/100",
            MediaAuthorization.contentRangeHeader(MediaAuthorization.ByteRange(10, 29), 100),
        )
    }
}
