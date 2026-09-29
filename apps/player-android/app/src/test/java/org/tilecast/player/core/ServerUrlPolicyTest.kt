package org.tilecast.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlPolicyTest {
    @Test fun normalizesHttpsAndTrailingSlash() {
        assertEquals("https://signage.example.com", ServerUrlPolicy.normalize(" signage.example.com/ ").getOrThrow().value)
        assertFalse(ServerUrlPolicy.normalize("https://signage.example.com/").getOrThrow().localInsecure)
    }
    @Test fun acceptsExplicitPortsAndPrivateLanHttp() {
        val values = listOf("http://192.168.1.50:8080", "http://10.2.3.4", "http://172.16.0.2", "http://tilecast.local:8080", "http://localhost:8080", "http://169.254.1.2")
        values.forEach { assertTrue(it, ServerUrlPolicy.normalize(it).getOrThrow().localInsecure) }
    }
    @Test fun rejectsPublicHttpAndUnsupportedSchemes() {
        assertTrue(ServerUrlPolicy.normalize("http://example.com").isFailure)
        assertTrue(ServerUrlPolicy.normalize("ftp://192.168.1.2").isFailure)
        assertTrue(ServerUrlPolicy.normalize("https://example.com/path").isFailure)
    }
    @Test fun matchesSharedServerUrlPolicyFixtures() {
        val root = Json.parseToJsonElement(sharedFixture().readText()).jsonObject
        for (element in root.getValue("cases").jsonArray) {
            val entry = element.jsonObject
            val name = entry.getValue("name").jsonPrimitive.content
            val result = ServerUrlPolicy.normalize(entry.getValue("input").jsonPrimitive.content)
            val accepted = entry.getValue("accepted").jsonPrimitive.boolean
            assertEquals(name, accepted, result.isSuccess)
            if (accepted) {
                assertEquals(name, entry.getValue("normalized").jsonPrimitive.content, result.getOrThrow().value)
            }
        }
    }

    private fun sharedFixture(): File {
        var directory = File(System.getProperty("user.dir")).absoluteFile
        while (true) {
            val candidate = File(directory, "packages/player-contracts/fixtures/server-url-policy.json")
            if (candidate.isFile) return candidate
            directory = directory.parentFile ?: error("repository root not found from user.dir")
        }
    }

}
