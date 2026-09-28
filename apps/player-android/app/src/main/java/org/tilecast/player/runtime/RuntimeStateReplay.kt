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

    /** Ordered snapshot for a runtime that just became ready.
     *
     * Commands are actions, but collecting a snapshot does not prove the page
     * received it. The caller must acknowledge a successfully delivered
     * snapshot with [acknowledgeDelivered].
     */
    fun collectReplay(): List<HostMessage> = listOfNotNull(
        presentation,
        plugins,
        identify,
        command,
        discoveredServer,
    )

    /** Consumes only the command that was part of a successfully delivered snapshot.
     *
     * Identity comparison matters here: if a newer command was offered while an
     * older response was in flight, acknowledging the older response must not
     * clear the newer command even when both commands have identical bodies.
     */
    fun acknowledgeDelivered(delivered: List<HostMessage>) {
        val deliveredCommand = delivered.filterIsInstance<HostMessage.Command>().singleOrNull()
            ?: return
        if (command === deliveredCommand) command = null
    }

    fun clearVolatile() {
        identify = null
        command = null
    }
}
