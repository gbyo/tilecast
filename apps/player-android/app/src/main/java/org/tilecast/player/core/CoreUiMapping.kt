package org.tilecast.player.core

/**
 * ViewModel-owned setup phase: what the Player does before Core pairing
 * takes over the screen. Discovery and address validation stay in Kotlin
 * (Android NSD plus a credential-free identity fetch); everything after
 * [Requesting] is Core's pairing state projected below.
 */
sealed interface SetupPhase {
    data object Boot : SetupPhase
    data object Discovering : SetupPhase
    /** The search result so far. The search keeps running while this shows. */
    data class Browsing(val servers: List<DiscoveredServer>) : SetupPhase
    data class Manual(val error: String? = null) : SetupPhase
    data class Validating(val serverUrl: String) : SetupPhase
    data object Requesting : SetupPhase
    data class Failed(val message: String) : SetupPhase
}

/**
 * The server a pairing attempt began against: the approval screen names
 * it and says when the connection is local HTTP.
 */
data class PairingTarget(val serverUrl: String, val localInsecure: Boolean)

/**
 * The pairing approval screen's code. Only what the screen shows: the
 * poll secret never crosses into Kotlin UI state.
 */
data class PairingCodeUi(
    val code: String,
    val expiresAt: String?,
    val serverTime: String?,
    val approvalUrl: String,
)

/**
 * Projects Core host and pairing state plus the local setup phase onto
 * the single [PlayerState] the setup screens render. Pure: every branch
 * is covered by JVM tests, and production re-maps on each state change.
 *
 * Precedence is deliberate. An identity mismatch owns the screen first:
 * it needs an explicit reset. A live pairing session comes next, because
 * it is how a revoked screen recovers. A stopped link with a revoked
 * credential owns the screen before any binding or setup phase, so
 * revocation never flashes setup behind it. A live binding owns the
 * screen next, and the local setup phase only shows while Core has
 * nothing to say.
 */
fun mapPlayerState(
    host: CoreHostState,
    pairing: CorePairingState,
    setup: SetupPhase,
    target: PairingTarget? = null,
): PlayerState {
    val status = (host as? CoreHostState.Ready)?.status
    if (host is CoreHostState.Failed) {
        return PlayerState.ConnectionError("Tilecast could not start (${host.code})", recoverable = false)
    }
    if (status?.linkReason == "installation_identity_mismatch") {
        return PlayerState.ServerIdentityMismatch(
            status.linkExpected ?: status.installationId ?: "unknown",
            status.linkActual ?: "unknown",
        )
    }
    if (pairing is CorePairingState.Waiting) {
        // Core resumes a session by itself after a restart, so the target
        // may be unknown here; the binding still names the server.
        val server = target?.serverUrl ?: status?.serverUrl ?: status?.retainedServerUrl ?: ""
        return PlayerState.WaitingForApproval(
            server,
            pairing.organizationName ?: status?.organizationName ?: "",
            pairing.codeUi(),
            target?.localInsecure ?: ServerUrlPolicy.normalize(server).getOrNull()?.localInsecure ?: false,
        )
    }
    if (pairing is CorePairingState.Renewing) return PlayerState.PairingRequest
    when (status?.linkReason) {
        "device_credential_rejected", "device_credential_missing" ->
            return PlayerState.CredentialRevoked(status.screenName)
    }
    if (pairing is CorePairingState.Paired ||
        pairing is CorePairingState.Enrolled ||
        status?.paired == true
    ) {
        val name = status?.screenName ?: "Tilecast screen"
        return when (status?.linkState) {
            "connected" -> PlayerState.PairedIdle(name, true)
            "unbound", null -> PlayerState.PairedConnecting(name)
            else -> PlayerState.PairedIdle(name, false, status.linkReason)
        }
    }
    if (pairing is CorePairingState.AddressRejected) {
        return PlayerState.ConnectionError("The server did not accept this address")
    }
    if (host is CoreHostState.Idle || host is CoreHostState.Starting) return PlayerState.Discovering
    return when (setup) {
        SetupPhase.Boot -> PlayerState.Unconfigured
        SetupPhase.Discovering -> PlayerState.Discovering
        is SetupPhase.Browsing -> PlayerState.ServerSelection(setup.servers)
        is SetupPhase.Manual -> PlayerState.ManualServerEntry(setup.error)
        is SetupPhase.Validating -> PlayerState.ValidatingServer(setup.serverUrl)
        SetupPhase.Requesting -> PlayerState.PairingRequest
        is SetupPhase.Failed -> PlayerState.ConnectionError(setup.message)
    }
}

/** The approval screen's projection of a waiting pairing session. */
fun CorePairingState.Waiting.codeUi(): PairingCodeUi =
    PairingCodeUi(code = code, expiresAt = expiresAt, serverTime = serverTime, approvalUrl = approvalUrl)
