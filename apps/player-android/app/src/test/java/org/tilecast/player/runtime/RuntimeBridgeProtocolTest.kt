package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.runtime.RuntimeBridgeProtocol.HostMessage
import org.tilecast.player.runtime.RuntimeBridgeProtocol.RuntimeReport

class RuntimeBridgeProtocolTest {
    private fun presentation(type: String = "some-future-widget"): HostMessage.Presentation {
        val raw = """{"type":"presentation","activation":{"activationId":"a1","generation":7},"presentation":{"state":"playing","items":[{"kind":"widget","component":{"type":${quoted(type)},"version":1}}]}}"""
        val parsed = RuntimeBridgeProtocol.parseHostMessage(raw).getOrThrow()
        assertTrue(parsed is HostMessage.Presentation)
        return parsed as HostMessage.Presentation
    }

    private fun quoted(s: String): String = "\"$s\""

    @Test fun forwardsUnknownWidgetTypesWithoutInterpreting() {
        val parsed = presentation("some-future-widget")
        assertEquals("a1", parsed.activationId)
        assertEquals(7L, parsed.generation)
        assertTrue(parsed.body.toString().contains("some-future-widget"))
    }

    @Test fun parsesAllHostMessageTypes() {
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("""{"type":"plugins","plugins":[]}""").getOrThrow() is HostMessage.Plugins)
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("""{"type":"identify","name":"Lobby","durationSeconds":5}""").getOrThrow() is HostMessage.Identify)
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("""{"type":"command","command":"skip-item"}""").getOrThrow() is HostMessage.Command)
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("""{"type":"discovered-server","server":{}}""").getOrThrow() is HostMessage.DiscoveredServer)
    }

    @Test fun refusesUnknownTypesAndMalformedEnvelopes() {
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("""{"type":"invoke","method":"exec"}""").isFailure)
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("").isFailure)
        assertTrue(RuntimeBridgeProtocol.parseHostMessage("{oops").isFailure)
    }

    @Test fun acceptsReadyAndRejectsWrongContract() {
        val ready = RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"ready","contractVersion":1,"runtimeVersion":"0.1.0"}""")
        assertEquals(RuntimeReport.Ready(1, "0.1.0"), ready)
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"ready","contractVersion":2,"runtimeVersion":"0.1.0"}"""))
    }

    @Test fun validatesEvidenceVocabulary() {
        val ok = RuntimeBridgeProtocol.parseRuntimeReport(
            """{"type":"evidence","activationId":"a1","itemId":"i1","kind":"widget-shown","zoneId":"z"}""",
        )
        assertEquals(RuntimeReport.Evidence("a1", "i1", "widget-shown", "z"), ok)
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"evidence","kind":"widget-hacked"}"""))
    }

    @Test fun parsesResultsAndErrors() {
        assertEquals(
            RuntimeReport.PresentationResult("a1", "accepted"),
            RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"presentation.accepted","activation":{"activationId":"a1"}}"""),
        )
        val error = RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"playback-error","activationId":"a1","message":"boom"}""")
        assertEquals(RuntimeReport.PlaybackError("a1", null, "boom"), error)
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"playback-error"}"""))
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport(""))
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"invoke","method":"x"}"""))
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":{}}"""))
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":[],"kind":"image-shown"}"""))
        assertNull(RuntimeBridgeProtocol.parseRuntimeReport("""{"type":"evidence","kind":{}}"""))
    }

    @Test fun pr1AdvertisesNoPresentationCapabilities() {
        val caps = RuntimeBridgeProtocol.pr1Capabilities()
        assertNull(caps["remoteWeb"])
        assertEquals(false, caps["synchronizedPlayback"])
        assertEquals(false, caps["setup"])
        assertEquals(false, caps["discovery"])
    }

    @Test fun defaultBootstrapPublishesRequiredHostContract() {
        val script = RuntimeBridgeProtocol.bootstrapScript()
        assertTrue(script.contains(RuntimeBridgeProtocol.HOST_GLOBAL))
        assertTrue(script.contains(RuntimeBridgeProtocol.BRIDGE_NAME))
        assertTrue(script.contains("contractVersion:" + RuntimeBridgeProtocol.CONTRACT_VERSION))
        listOf(
            "subscribe:function",
            "ready:function",
            "presentationResult:function",
            "reportEvidence:function",
            "reportPlaybackError:function",
            "__tilecastHostNudge",
        ).forEach { member -> assertTrue("missing " + member, script.contains(member)) }
    }

    @Test fun jsonLibrarySanity() {
        assertEquals("presentation", Json.parseToJsonElement("""{"type":"presentation"}""").jsonObject["type"].toString().trim('"'))
    }
}
