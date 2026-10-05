package org.tilecast.player.core

import org.tilecast.player.network.ServerIdentity

/**
 * ViewModel-owned setup phase: what the user is doing before Core pairing
 * takes over the screen. Discovery and address validation stay in Kotlin
 * (Android NSD plus a credential-free identity fetch); everything after
 * [Requesting] is Core's pairing state projected below.
 */
sealed interface SetupPhase {
    data object Boot : SetupPhase
    data object Discovering : SetupPhase
    data class Browsing(val servers: List<DiscoveredServer>) : SetupPhase
    data class Manual(val error: String? = null) : SetupPhase
    data class Validating(val serverUrl: String) : SetupPhase
    data class Confirm(val serverUrl: NormalizedServerUrl, val identity: ServerIdentity) : SetupPhase
    data object Requesting : SetupPhase
    data class Failed(val message: String) : SetupPhase
}

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
 * Precedence is deliberate. A stopped link with a terminal reason owns
 * the screen even when the pairing projection lags it: revocation and
 * identity mismatch must never flash setup behind them. A live binding
 * owns the screen next. Pairing progress follows, and the local setup
 * phase only shows while Core has nothing to say.
 */
fun mapPlayerState(
    host: CoreHostState,
    pairing: CorePairingState,
    setup: SetupPhase,
    /** The URL the current pairing attempt began against, for the approval screen. */
    beginUrl: String? = null,
): PlayerState {
    val status = (host as? CoreHostState.Ready)?.status
    if (host is CoreHostState.Failed) {
        return PlayerState.ConnectionError("Player Core could not start (${host.code})")
    }
    when (status?.linkReason) {
        "device_credential_rejected", "device_credential_missing" ->
            return PlayerState.CredentialRevoked(status.screenName)
        "installation_identity_mismatch" ->
            return PlayerState.ServerIdentityMismatch(
                status.linkExpected ?: status.installationId ?: "unknown",
                status.linkActual ?: "unknown",
            )
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
    if (pairing is CorePairingState.Waiting) {
        return PlayerState.WaitingForApproval(
            beginUrl ?: "",
            pairing.organizationName ?: "",
            pairing.codeUi(),
        )
    }
    if (pairing is CorePairingState.Renewing) return PlayerState.PairingRequest
    if (pairing is CorePairingState.AddressRejected) {
        return PlayerState.ConnectionError("The server address was rejected")
    }
    if (host is CoreHostState.Idle || host is CoreHostState.Starting) return PlayerState.Discovering
    return when (setup) {
        SetupPhase.Boot -> PlayerState.Unconfigured
        SetupPhase.Discovering -> PlayerState.Discovering
        is SetupPhase.Browsing -> PlayerState.ServerSelection(setup.servers)
        is SetupPhase.Manual -> PlayerState.ManualServerEntry(setup.error)
        is SetupPhase.Validating -> PlayerState.ValidatingServer(setup.serverUrl)
        is SetupPhase.Confirm -> PlayerState.ServerConfirmation(setup.serverUrl, setup.identity)
        SetupPhase.Requesting -> PlayerState.PairingRequest
        is SetupPhase.Failed -> PlayerState.ConnectionError(setup.message)
    }
}

/** The approval screen's projection of a waiting pairing session. */
fun CorePairingState.Waiting.codeUi(): PairingCodeUi =
    PairingCodeUi(code = code, expiresAt = expiresAt, serverTime = serverTime, approvalUrl = approvalUrl)
