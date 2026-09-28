package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test

class RuntimeCrashPolicyTest {
    @Test fun freshGenerationAcceptsReports() {
        val policy = RuntimeCrashPolicy()
        assertTrue(policy.acceptsReport(1))
        assertFalse(policy.isReady())
    }

    @Test fun deadGenerationNeverReportsAgain() {
        val policy = RuntimeCrashPolicy()
        policy.onRendererGone()
        assertFalse(policy.acceptsReport(1))
        val next = policy.onRecreated()
        assertEquals(2L, next)
        assertTrue(policy.acceptsReport(2))
        assertFalse(policy.acceptsReport(1))
    }

    @Test fun readyOnlyAfterRecreatedRuntimeSignals() {
        val policy = RuntimeCrashPolicy()
        policy.onRendererGone()
        policy.onRecreated()
        policy.onRuntimeReady(1)
        assertFalse(policy.isReady())
        policy.onRuntimeReady(2)
        assertTrue(policy.isReady())
    }

    @Test fun hostRejectsStaleBridgeCallbacks() {
        val host = AndroidRuntimeHost("0.25.0", "webview/1")
        assertNotNull(
            host.handleRuntimeMessage("""{"type":"ready","contractVersion":1,"runtimeVersion":"0.1.0"}""", 1),
        )
        host.onRendererGone()
        assertNull(
            host.handleRuntimeMessage("""{"type":"evidence","kind":"image-shown"}""", 1),
        )
        val next = host.onRecreated()
        host.onRuntimeReady(next)
        assertTrue(host.isReady())
        assertNotNull(
            host.handleRuntimeMessage("""{"type":"evidence","kind":"image-shown"}""", next),
        )
    }

    @Test fun hostAcknowledgesCommandOnlyAfterDelivery() {
        val host = AndroidRuntimeHost("0.25.0", "webview/1")
        host.offer(
            RuntimeBridgeProtocol.parseHostMessage(
                """{"type":"command","command":"skip-item"}""",
            ).getOrThrow(),
        )

        val pending = host.replayForReady()
        assertTrue(pending.any { it is RuntimeBridgeProtocol.HostMessage.Command })
        assertTrue(host.replayForReady().any { it is RuntimeBridgeProtocol.HostMessage.Command })

        host.acknowledgeReplay(pending)
        assertFalse(host.replayForReady().any { it is RuntimeBridgeProtocol.HostMessage.Command })
    }

    @Test fun replaySurvivesRecreation() {
        val host = AndroidRuntimeHost("0.25.0", "webview/1")
        host.offer(
            RuntimeBridgeProtocol.parseHostMessage(
                """{"type":"presentation","activation":{"activationId":"a1","generation":3},"presentation":{}}""",
            ).getOrThrow(),
        )
        host.onRendererGone()
        host.onRecreated()
        assertEquals(1, host.replayForReady().size)
    }
}
