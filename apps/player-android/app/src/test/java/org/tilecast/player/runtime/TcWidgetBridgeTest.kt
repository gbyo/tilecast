package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.tilecast.player.runtime.FrameAuthorization.AuthorizedFrame
import java.io.File

class TcWidgetBridgeTest {
    @get:Rule
    val files = TemporaryFolder()

    private val token = "d".repeat(64)
    private val authorized = setOf(AuthorizedFrame(token))
    private val frameBytes = "<!doctype html><title>frame</title>".toByteArray()

    private fun setup(): Map<String, String> {
        val file = files.newFile()
        file.writeBytes(frameBytes)
        return mapOf(token to file.absolutePath)
    }

    @Test fun servesWholeDocumentAsHtml() {
        val resolved = TcWidgetBridge.resolve("tcwidget://cap/$token", authorized, setup(), null)!!
        assertEquals(200, resolved.statusCode)
        assertEquals(frameBytes.size.toLong(), resolved.contentLength)
        assertNull(resolved.contentRange)
        val headers = TcWidgetBridge.responseHeaders(resolved)
        assertEquals("text/html", headers["Content-Type"])
        assertEquals(sharedResponsePolicy(), headers["Content-Security-Policy"])
        assertEquals("nosniff", headers["X-Content-Type-Options"])
        assertEquals("none", headers["Accept-Ranges"])
        assertEquals("no-store", headers["Cache-Control"])
        val body = TcWidgetBridge.openStream(resolved)!!.readBytes()
        assertArrayEquals(frameBytes, body)
    }

    @Test fun anyRangeAnswers416() {
        val resolved = TcWidgetBridge.resolve("tcwidget://cap/$token", authorized, setup(), "bytes=0-10")!!
        assertEquals(416, resolved.statusCode)
        assertEquals("bytes */${frameBytes.size}", resolved.contentRange)
        assertNull(resolved.file)
        assertNull(TcWidgetBridge.openStream(resolved))
    }

    @Test fun unknownTokensAndMissingFilesAnswerNull() {
        assertNull(TcWidgetBridge.resolve("tcwidget://cap/${"e".repeat(64)}", authorized, setup(), null))
        assertNull(TcWidgetBridge.resolve("tcwidget://cap/$token", authorized, emptyMap(), null))
        val gone = setup().mapValues { files.root.absolutePath + "/missing.html" }
        assertNull(TcWidgetBridge.resolve("tcwidget://cap/$token", authorized, gone, null))
    }

    @Test fun frameHeaderIsTheSharedPolicyAndKeepsPassiveLoadsOffTheOpenWeb() {
        assertEquals(sharedResponsePolicy(), TcWidgetBridge.SANDBOX_POLICY)
        val directives = TcWidgetBridge.SANDBOX_POLICY.split("; ").associate {
            it.substringBefore(" ") to it.substringAfter(" ", "")
        }
        // A Widget could otherwise encode granted data into an attacker URL
        // through an image, media, or font request.
        for (name in listOf("img-src", "media-src", "font-src")) {
            val sources = directives.getValue(name).split(" ").toSet()
            assertEquals(name, setOf("data:", "tcmedia:"), sources)
        }
        for (name in listOf("default-src", "connect-src", "worker-src", "object-src", "base-uri", "form-action")) {
            assertEquals(name, "'none'", directives[name])
        }
    }

    private fun sharedResponsePolicy(): String {
        var directory = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(directory, "packages/player-contracts/fixtures/widget-frames.json")
            if (candidate.isFile) {
                val constants = Json.parseToJsonElement(candidate.readText()).jsonObject.getValue("constants").jsonObject
                return constants.getValue("responsePolicy").jsonPrimitive.content
            }
            directory = directory.parentFile ?: error("repository root not found from user.dir")
        }
    }
}
