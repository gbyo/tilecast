package org.tilecast.player.runtime

/** Android implementation of the `TilecastRuntimeHostV1` host side.
 *
 * PR1 scope: the bridge, ordered state replay and crash-generation gating.
 * No presentation capability is advertised yet; the legacy Compose stack
 * still owns the screen until the PR2 playback cutover.
 */
class AndroidRuntimeHost(
    val hostVersion: String,
    val engineVersion: String,
    private val replay: RuntimeStateReplay = RuntimeStateReplay(),
    private val crashPolicy: RuntimeCrashPolicy = RuntimeCrashPolicy(),
) {
    fun capabilities(): Map<String, Any?> = RuntimeBridgeProtocol.pr1Capabilities()

    fun info(): Map<String, String> =
        RuntimeBridgeProtocol.hostInfo(hostVersion, engineVersion)

    fun offer(message: RuntimeBridgeProtocol.HostMessage) = replay.offer(message)

    fun replayForReady(): List<RuntimeBridgeProtocol.HostMessage> = replay.collectReplay()

    /** Acknowledge a replay only after the page response was delivered. */
    fun acknowledgeReplay(delivered: List<RuntimeBridgeProtocol.HostMessage>) =
        replay.acknowledgeDelivered(delivered)

    /** Validates one runtime-originated payload; null when refused or stale. */
    fun handleRuntimeMessage(raw: String, generation: Long): RuntimeBridgeProtocol.RuntimeReport? {
        if (!crashPolicy.acceptsReport(generation)) return null
        return RuntimeBridgeProtocol.parseRuntimeReport(raw)
    }

    fun onRendererGone(): Long = crashPolicy.onRendererGone()

    /** Recreates the generation after a renderer death. Replay only after ready. */
    fun onRecreated(): Long = crashPolicy.onRecreated()

    fun onRuntimeReady(generation: Long) = crashPolicy.onRuntimeReady(generation)

    fun isReady(): Boolean = crashPolicy.isReady()
}
