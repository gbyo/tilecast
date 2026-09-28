package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.tilecast.player.runtime.MediaAuthorization.AuthorizedMedia

class TcMediaBridgeTest {
    @get:Rule
    val files = TemporaryFolder()

    private val authorized = setOf(AuthorizedMedia("a1", "v1"))
    private val videoBytes = ByteArray(1024) { it.toByte() }

    private fun setup(): Map<String, String> {
        val file = files.newFile("v1.mp4")
        file.writeBytes(videoBytes)
        return mapOf("v1" to file.absolutePath)
    }

    private fun mime() = mapOf("v1" to "video/mp4")

    @Test fun servesFullFileWithLengthAndType() {
        val resolved = TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), null)!!
        assertEquals(200, resolved.statusCode)
        assertEquals(1024L, resolved.contentLength)
        assertEquals("video/mp4", resolved.mimeType)
        assertNull(resolved.contentRange)
        assertEquals(0L, resolved.offset)
    }

    @Test fun serves206PartialWithContentRange() {
        val resolved = TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), "bytes=100-199")!!
        assertEquals(206, resolved.statusCode)
        assertEquals(100L, resolved.contentLength)
        assertEquals("bytes 100-199/1024", resolved.contentRange)
        assertEquals(100L, resolved.offset)
        val headers = TcMediaBridge.responseHeaders(resolved)
        assertEquals("bytes 100-199/1024", headers["Content-Range"])
        assertEquals("video/mp4", headers["Content-Type"])
        assertEquals("bytes", headers["Accept-Ranges"])
        assertEquals("100", headers["Content-Length"])
        val body = TcMediaBridge.openStream(resolved)!!.readBytes()
        assertEquals(100, body.size)
        assertEquals(videoBytes[100], body[0])
    }

    @Test fun servesSuffixAndOpenRanges() {
        val suffix = TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), "bytes=-10")!!
        assertEquals(206, suffix.statusCode)
        assertEquals(10L, suffix.contentLength)
        val open = TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), "bytes=1020-")!!
        assertEquals(4L, open.contentLength)
    }

    @Test fun rejectsUnsatisfiableRangeWith416() {
        val resolved = TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), "bytes=2000-")!!
        assertEquals(416, resolved.statusCode)
        assertEquals("bytes */1024", resolved.contentRange)
        assertEquals("bytes */1024", TcMediaBridge.responseHeaders(resolved)["Content-Range"])
        assertNull(TcMediaBridge.openStream(resolved))
    }

    @Test fun refusesUnauthorizedAndMissingMedia() {
        assertNull(TcMediaBridge.resolve("tcmedia:evil/v1", authorized, setup(), mime(), null))
        assertNull(TcMediaBridge.resolve("tcmedia:a1/v9", authorized, setup(), mime(), null))
        assertNull(TcMediaBridge.resolve("tcmedia:a1/v1", authorized, emptyMap(), mime(), null))
        assertNull(TcMediaBridge.resolve("tcmedia:a1/v1", authorized, setup(), mime(), "bytes=0-1,3-4"))
        assertNull(TcMediaBridge.resolve("file:///etc/passwd", authorized, setup(), mime(), null))
    }
}
