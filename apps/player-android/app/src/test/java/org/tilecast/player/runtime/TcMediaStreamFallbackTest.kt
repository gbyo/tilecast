package org.tilecast.player.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TcMediaStreamFallbackTest {
    private val authorized = setOf(MediaAuthorization.AuthorizedMedia("a1", "v1"))
    private val paths = mapOf("v1" to "/api/v1/player/media/a1/v1")
    private val mimes = mapOf("v1" to "video/mp4")
    private val target = TcMediaStreamFallback.StreamTarget("a1", "v1", "/api/v1/player/media/a1/v1", "video/mp4")

    @Test fun resolvesAuthorizedTargetToServerPath() {
        assertEquals(
            target,
            TcMediaStreamFallback.resolveTarget("tcmedia://variant/a1/v1", authorized, paths, mimes),
        )
    }

    @Test fun rejectsUnauthorizedUnknownAndMalformedUris() {
        assertNull(TcMediaStreamFallback.resolveTarget("tcmedia://variant/a1/v1", emptySet(), paths, mimes))
        assertNull(TcMediaStreamFallback.resolveTarget("tcmedia://variant/a1/v9", authorized, paths, mimes))
        assertNull(TcMediaStreamFallback.resolveTarget("tcmedia://variant/evil/v1", authorized, paths, mimes))
        assertNull(TcMediaStreamFallback.resolveTarget("file:///etc/passwd", authorized, paths, mimes))
        assertNull(TcMediaStreamFallback.resolveTarget(null, authorized, paths, mimes))
    }

    @Test fun rejectsVariantsWithoutAServerPath() {
        val noPath = setOf(MediaAuthorization.AuthorizedMedia("a2", "v2"))
        assertNull(TcMediaStreamFallback.resolveTarget("tcmedia://variant/a2/v2", noPath, paths, mimes))
    }

    @Test fun requestCarriesCredentialAndRange() {
        val request = TcMediaStreamFallback.buildRequest("https://example.com/", "cred", target, "bytes=100-199")!!
        assertEquals("https://example.com/api/v1/player/media/a1/v1", request.url.toString())
        assertEquals("Bearer cred", request.header("Authorization"))
        assertEquals("bytes=100-199", request.header("Range"))
    }

    @Test fun requestOmitsRangeWhenAbsentAndRefusesWithoutCredential() {
        val plain = TcMediaStreamFallback.buildRequest("https://example.com", "cred", target, null)!!
        assertEquals(null, plain.header("Range"))
        assertNull(TcMediaStreamFallback.buildRequest("https://example.com", "", target, null))
        assertNull(TcMediaStreamFallback.buildRequest("", "cred", target, null))
    }

    @Test fun responseHeadersPreserveRangeSemantics() {
        assertEquals(
            mapOf(
                "Accept-Ranges" to "bytes",
                "Content-Type" to "video/mp4",
                "Content-Length" to "100",
                "Content-Range" to "bytes 100-199/1000",
            ),
            TcMediaStreamFallback.responseHeaders(target, "100", "bytes 100-199/1000"),
        )
        assertEquals(
            mapOf("Accept-Ranges" to "bytes", "Content-Type" to "video/mp4"),
            TcMediaStreamFallback.responseHeaders(target, null, null),
        )
    }
}
