package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.runtime.RuntimeBridgeProtocol.HostMessage

class RuntimeStateReplayTest {
    private fun msg(raw: String): HostMessage = RuntimeBridgeProtocol.parseHostMessage(raw).getOrThrow()

    @Test fun replaysInContractOrder() {
        val replay = RuntimeStateReplay()
        replay.offer(msg("""{"type":"discovered-server","server":{}}"""))
        replay.offer(msg("""{"type":"command","command":"skip-item"}"""))
        replay.offer(msg("""{"type":"identify","name":"Lobby","durationSeconds":5}"""))
        replay.offer(msg("""{"type":"plugins","plugins":[]}"""))
        replay.offer(msg("""{"type":"presentation","activation":{"activationId":"a1","generation":1},"presentation":{}}"""))
        val types = replay.collectReplay().map {
            when (it) {
                is HostMessage.Presentation -> "presentation"
                is HostMessage.Plugins -> "plugins"
                is HostMessage.Identify -> "identify"
                is HostMessage.Command -> "command"
                is HostMessage.DiscoveredServer -> "discovered-server"
            }
        }
        assertEquals(listOf("presentation", "plugins", "identify", "command", "discovered-server"), types)
    }

    @Test fun ignoresUnchangedActivationResend() {
        val replay = RuntimeStateReplay()
        val raw = """{"type":"presentation","activation":{"activationId":"a1","generation":1},"presentation":{"state":"idle"}}"""
        replay.offer(msg(raw))
        replay.offer(msg(raw))
        assertEquals(1, replay.collectReplay().size)
        replay.offer(msg("""{"type":"presentation","activation":{"activationId":"a1","generation":2},"presentation":{"state":"idle"}}"""))
        val current = replay.collectReplay().first() as HostMessage.Presentation
        assertEquals(2L, current.generation)
    }

    @Test fun commandRemainsPendingUntilDeliveredReplayIsAcknowledged() {
        val replay = RuntimeStateReplay()
        replay.offer(msg("""{"type":"presentation","activation":{"activationId":"a1","generation":1},"presentation":{}}"""))
        replay.offer(msg("""{"type":"command","command":"skip-item"}"""))

        val first = replay.collectReplay()
        assertTrue(first.any { it is HostMessage.Command })
        assertTrue(replay.collectReplay().any { it is HostMessage.Command })

        replay.acknowledgeDelivered(first)
        val afterAck = replay.collectReplay()
        assertFalse(afterAck.any { it is HostMessage.Command })
        assertTrue(afterAck.any { it is HostMessage.Presentation })
    }

    @Test fun acknowledgingOlderReplayDoesNotClearNewerCommand() {
        val replay = RuntimeStateReplay()
        replay.offer(msg("""{"type":"command","command":"skip-item"}"""))
        val older = replay.collectReplay()

        // A new command can arrive while the older state response is in flight.
        replay.offer(msg("""{"type":"command","command":"skip-item"}"""))
        replay.acknowledgeDelivered(older)

        assertTrue(replay.collectReplay().any { it is HostMessage.Command })
    }

    @Test fun clearVolatileKeepsPresentationAndPlugins() {
        val replay = RuntimeStateReplay()
        replay.offer(msg("""{"type":"presentation","activation":{"activationId":"a1","generation":1},"presentation":{}}"""))
        replay.offer(msg("""{"type":"identify","name":"Lobby","durationSeconds":5}"""))
        replay.clearVolatile()
        assertEquals(1, replay.collectReplay().size)
    }
}
