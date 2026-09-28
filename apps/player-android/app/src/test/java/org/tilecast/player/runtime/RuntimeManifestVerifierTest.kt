package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class RuntimeManifestVerifierTest {
    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun manifestJson(vararg entries: Pair<String, ByteArray>): String {
        val files = entries.joinToString(",") { (path, bytes) ->
            """{"path":${quoted(path)},"bytes":${bytes.size},"sha256":"${sha256(bytes)}"}"""
        }
        return """{"name":"@tilecast/player-runtime","version":"0.1.0","contractVersion":1,"files":[$files]}"""
    }

    private fun quoted(s: String): String = "\"" + s.replace("\"", "\\\"") + "\""

    private val indexBytes = "<html></html>".toByteArray()
    private val jsBytes = "console.log(1)".toByteArray()

    @Test fun acceptsExactArtifact() {
        val manifest = manifestJson("index.html" to indexBytes, "runtime.js" to jsBytes)
        val files = listOf(
            RuntimeManifestVerifier.FileBytes("index.html", indexBytes),
            RuntimeManifestVerifier.FileBytes("runtime.js", jsBytes),
        )
        assertEquals(RuntimeManifestVerifier.Result.Ok, RuntimeManifestVerifier.verify(manifest, files))
    }

    @Test fun ignoresManifestFileItself() {
        val manifest = manifestJson("index.html" to indexBytes)
        val files = listOf(
            RuntimeManifestVerifier.FileBytes("index.html", indexBytes),
            RuntimeManifestVerifier.FileBytes("runtime-manifest.json", manifest.toByteArray()),
        )
        assertEquals(RuntimeManifestVerifier.Result.Ok, RuntimeManifestVerifier.verify(manifest, files))
    }

    @Test fun refusesMissingFile() {
        val manifest = manifestJson("index.html" to indexBytes, "runtime.js" to jsBytes)
        val result = RuntimeManifestVerifier.verify(
            manifest, listOf(RuntimeManifestVerifier.FileBytes("index.html", indexBytes)),
        )
        assertTrue(result is RuntimeManifestVerifier.Result.Refused)
    }

    @Test fun refusesExtraFile() {
        val manifest = manifestJson("index.html" to indexBytes)
        val files = listOf(
            RuntimeManifestVerifier.FileBytes("index.html", indexBytes),
            RuntimeManifestVerifier.FileBytes("stale.js", jsBytes),
        )
        val result = RuntimeManifestVerifier.verify(manifest, files)
        assertTrue(result is RuntimeManifestVerifier.Result.Refused)
    }

    @Test fun refusesHashMismatch() {
        val manifest = manifestJson("index.html" to indexBytes)
        val result = RuntimeManifestVerifier.verify(
            manifest, listOf(RuntimeManifestVerifier.FileBytes("index.html", jsBytes)),
        )
        assertTrue(result is RuntimeManifestVerifier.Result.Refused)
    }

    @Test fun refusesPathTraversalAndDuplicates() {
        val traversal = manifestJson("../evil.js" to jsBytes)
        assertTrue(
            RuntimeManifestVerifier.verify(
                traversal, listOf(RuntimeManifestVerifier.FileBytes("../evil.js", jsBytes)),
            ) is RuntimeManifestVerifier.Result.Refused,
        )
        val dupe = """{"files":[{"path":"a.js","bytes":1,"sha256":"${sha256(byteArrayOf(1))}"},{"path":"a.js","bytes":1,"sha256":"${sha256(byteArrayOf(1))}"}]}"""
        assertTrue(
            RuntimeManifestVerifier.verify(
                dupe, listOf(RuntimeManifestVerifier.FileBytes("a.js", byteArrayOf(1))),
            ) is RuntimeManifestVerifier.Result.Refused,
        )
    }

    @Test fun refusesMalformedManifest() {
        assertTrue(
            RuntimeManifestVerifier.verify(
                "not json", listOf(RuntimeManifestVerifier.FileBytes("a.js", byteArrayOf(1))),
            ) is RuntimeManifestVerifier.Result.Refused,
        )
    }
}
