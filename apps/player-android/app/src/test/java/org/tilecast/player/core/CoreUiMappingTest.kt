package org.tilecast.player.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.ServerIdentity

/** Every [mapPlayerState] branch: Core owns the screen, setup only fills silence. */
class CoreUiMappingTest {
    private fun status(json: String): CoreHostStatus = CoreHostStatus.parse(json)

    private fun ready(json: String): CoreHostState.Ready =
        CoreHostState.Ready("0.25.0", status(json), coreRunning = true)

    private fun waiting(): CorePairingState.Waiting =
        CorePairingState.Waiting("ABC123", "https://signs.example/approve", "Org", "2026-10-05T01:00:00Z", "2026-10-05T00:50:00Z")

    @Test fun hostFailureOwnsTheScreen() {
        val state = mapPlayerState(CoreHostState.Failed("open_failed"), CorePairingState.Unknown, SetupPhase.Boot)
        assertTrue(state is PlayerState.ConnectionError)
        assertTrue((state as PlayerState.ConnectionError).message.contains("open_failed"))
    }

    @Test fun revocationBeatsPairingAndSetup() {
        val host = ready("""{"ok":true,"paired":true,"screenName":"Lobby","linkState":"stopped","linkReason":"device_credential_rejected"}""")
        val revoked = mapPlayerState(host, CorePairingState.Paired, SetupPhase.Boot)
        assertEquals(PlayerState.CredentialRevoked("Lobby"), revoked)
        val missing = ready("""{"ok":true,"paired":false,"linkState":"stopped","linkReason":"device_credential_missing"}""")
        assertEquals(PlayerState.CredentialRevoked(null), mapPlayerState(missing, CorePairingState.Setup, SetupPhase.Boot))
    }

    @Test fun identityMismatchShowsBothInstallations() {
        val host = ready("""{"ok":true,"paired":true,"installationId":"old","linkState":"stopped","linkReason":"installation_identity_mismatch","linkExpected":"old","linkActual":"new"}""")
        assertEquals(
            PlayerState.ServerIdentityMismatch("old", "new"),
            mapPlayerState(host, CorePairingState.Paired, SetupPhase.Boot),
        )
    }

    @Test fun pairedProjectsConnection() {
        val connected = ready("""{"ok":true,"paired":true,"screenName":"Lobby","linkState":"connected"}""")
        assertEquals(PlayerState.PairedIdle("Lobby", true), mapPlayerState(connected, CorePairingState.Paired, SetupPhase.Boot))
        val retrying = ready("""{"ok":true,"paired":true,"screenName":"Lobby","linkState":"retrying","linkReason":"network_unreachable"}""")
        assertEquals(
            PlayerState.PairedIdle("Lobby", false, "network_unreachable"),
            mapPlayerState(retrying, CorePairingState.Paired, SetupPhase.Boot),
        )
        val binding = ready("""{"ok":true,"paired":true,"screenName":"Lobby","linkState":"unbound"}""")
        assertEquals(PlayerState.PairedConnecting("Lobby"), mapPlayerState(binding, CorePairingState.Unknown, SetupPhase.Boot))
        val enrolled = ready("""{"ok":true,"paired":true,"screenName":"Lobby","linkState":"connected"}""")
        assertEquals(PlayerState.PairedIdle("Lobby", true), mapPlayerState(enrolled, CorePairingState.Enrolled, SetupPhase.Boot))
    }

    @Test fun waitingProjectsTheApprovalScreen() {
        val state = mapPlayerState(
            ready("""{"ok":true,"paired":false,"linkState":"unbound"}"""),
            waiting(),
            SetupPhase.Requesting,
            beginUrl = "https://signs.example",
        )
        assertTrue(state is PlayerState.WaitingForApproval)
        state as PlayerState.WaitingForApproval
        assertEquals("https://signs.example", state.serverUrl)
        assertEquals("Org", state.organizationName)
        assertEquals("ABC123", state.pairing.code)
        assertEquals("2026-10-05T01:00:00Z", state.pairing.expiresAt)
        assertEquals("2026-10-05T00:50:00Z", state.pairing.serverTime)
        assertEquals("https://signs.example/approve", state.pairing.approvalUrl)
    }

    @Test fun renewingAndRejectedAddressMap() {
        val host = ready("""{"ok":true,"paired":false}""")
        assertEquals(PlayerState.PairingRequest, mapPlayerState(host, CorePairingState.Renewing("expired"), SetupPhase.Boot))
        val rejected = mapPlayerState(host, CorePairingState.AddressRejected, SetupPhase.Boot)
        assertTrue(rejected is PlayerState.ConnectionError)
    }

    @Test fun startingHostShowsLoading() {
        assertEquals(PlayerState.Discovering, mapPlayerState(CoreHostState.Starting, CorePairingState.Unknown, SetupPhase.Boot))
        assertEquals(PlayerState.Discovering, mapPlayerState(CoreHostState.Idle, CorePairingState.Unknown, SetupPhase.Boot))
    }

    @Test fun setupPhaseShowsWhileCoreIsSilent() {
        val host = ready("""{"ok":true,"paired":false,"linkState":"unbound"}""")
        assertEquals(PlayerState.Unconfigured, mapPlayerState(host, CorePairingState.Setup, SetupPhase.Boot))
        assertEquals(PlayerState.Discovering, mapPlayerState(host, CorePairingState.Setup, SetupPhase.Discovering))
        val servers = listOf(DiscoveredServer("Library", "http://lib.local:8080", null))
        assertEquals(
            PlayerState.ServerSelection(servers),
            mapPlayerState(host, CorePairingState.Setup, SetupPhase.Browsing(servers)),
        )
        assertEquals(
            PlayerState.ManualServerEntry("bad"),
            mapPlayerState(host, CorePairingState.Setup, SetupPhase.Manual("bad")),
        )
        assertEquals(
            PlayerState.ValidatingServer("http://x"),
            mapPlayerState(host, CorePairingState.Setup, SetupPhase.Validating("http://x")),
        )
        val url = NormalizedServerUrl("https://signs.example", false)
        val identity = ServerIdentity("tilecast", "i1", "Org", "v1", true)
        assertEquals(
            PlayerState.ServerConfirmation(url, identity),
            mapPlayerState(host, CorePairingState.Setup, SetupPhase.Confirm(url, identity)),
        )
        assertEquals(PlayerState.PairingRequest, mapPlayerState(host, CorePairingState.Setup, SetupPhase.Requesting))
        val failed = mapPlayerState(host, CorePairingState.Setup, SetupPhase.Failed("nope"))
        assertEquals(PlayerState.ConnectionError("nope"), failed)
    }
}
