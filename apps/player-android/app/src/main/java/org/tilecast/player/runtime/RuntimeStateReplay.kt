package org.tilecast.player.runtime

import org.tilecast.player.runtime.RuntimeBridgeProtocol.HostMessage

/** Authoritative host-side runtime state with ordered replay.
 *
 * Follows `TilecastRuntimeHostV1.subscribe` semantics: a (re)created runtime
 * receives the latest presentation first, then plugins, then the newest
 * volatile messages. Re-sending an unchanged activation is a no-op so a
 * WebView recreation after a renderer crash cannot restart visible playback.
 */
class RuntimeStateReplay {
    private var presentation: HostMessage.Presentation? = null
    private var plugins: HostMessage.Plugins? = null
    private var identify: HostMessage.Identify? = null
    private var command: HostMessage.Command? = null
    private var discoveredServer: HostMessage.DiscoveredServer? = null

    fun offer(message: HostMessage) {
        when (message) {
            is HostMessage.Presentation -> {
                val current = presentation
                if (current != null &&
                    current.activationId == message.activationId &&
                    current.generation == message.generation &&
                    current.body.toString() == message.body.toString()
                ) {
                    return
                }
                presentation = message
            }
            is HostMessage.Plugins -> plugins = message
            is HostMessage.Identify -> identify = message
            is HostMessage.Command -> command = message
            is HostMessage.DiscoveredServer -> discoveredServer = message
        }
    }

    /** Ordered snapshot for a runtime that just became ready. Commands are actions,
     * so consume them after one delivery instead of replaying them to every new runtime. */
    fun collectReplay(): List<HostMessage> {
        val replay = listOfNotNull(
            presentation,
            plugins,
            identify,
            command,
            discoveredServer,
        )
        command = null
        return replay
    }

    fun clearVolatile() {
        identify = null
        command = null
    }
}
