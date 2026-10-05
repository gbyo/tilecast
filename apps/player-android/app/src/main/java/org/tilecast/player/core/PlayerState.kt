package org.tilecast.player.core

import org.tilecast.player.network.ServerIdentity

sealed interface PlayerState {
    data object Unconfigured : PlayerState
    data object Discovering : PlayerState
    data class ServerSelection(val servers: List<DiscoveredServer>, val message: String? = null) : PlayerState
    data class ManualServerEntry(val error: String? = null) : PlayerState
    data class ValidatingServer(val serverUrl: String) : PlayerState
    data class ServerConfirmation(val serverUrl: NormalizedServerUrl, val identity: ServerIdentity) : PlayerState
    data object PairingRequest : PlayerState
    data class WaitingForApproval(val serverUrl: String, val organizationName: String, val pairing: PairingCodeUi) : PlayerState
    data object Enrolling : PlayerState
    data class PairedConnecting(val screenName: String) : PlayerState
    data class PairedIdle(val screenName: String, val connected: Boolean, val detail: String? = null) : PlayerState
    data class CredentialRevoked(val screenName: String?) : PlayerState
    data class ServerIdentityMismatch(val expected: String, val actual: String) : PlayerState
    data class ConnectionError(val message: String, val recoverable: Boolean = true) : PlayerState
}

data class DiscoveredServer(val name: String, val baseUrl: String, val installationId: String?)
