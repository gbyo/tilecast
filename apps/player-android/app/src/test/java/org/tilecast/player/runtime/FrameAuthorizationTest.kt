package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test
import org.tilecast.player.runtime.FrameAuthorization.AuthorizedFrame

class FrameAuthorizationTest {
    private val token = "d".repeat(64)
    private val authorized = setOf(AuthorizedFrame(token))

    @Test fun authorizesOnlyGrantedFrameTokens() {
        assertEquals(AuthorizedFrame(token), FrameAuthorization.authorize("tcwidget://cap/$token", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/${"e".repeat(64)}", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/$token", emptySet()))
        assertNull(FrameAuthorization.authorize("tcmedia://cap/$token", authorized))
    }

    @Test fun stripsHandshakeFragments() {
        assertEquals(
            AuthorizedFrame(token),
            FrameAuthorization.authorize("tcwidget://cap/$token#handshake-token", authorized),
        )
    }

    @Test fun extractsTokensWithoutAnAuthorizedSet() {
        assertEquals(token, FrameAuthorization.tokenOf("tcwidget://cap/$token"))
        assertNull(FrameAuthorization.tokenOf("tcwidget://cap/short"))
        assertNull(FrameAuthorization.tokenOf(null))
    }

    @Test fun refusesMalformedUris() {
        assertNull(FrameAuthorization.authorize("tcwidget://cap/short", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/${"D".repeat(64)}", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/$token/extra", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/$token?evil=1", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://other/$token", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget:$token", authorized))
        assertNull(FrameAuthorization.authorize("tcwidget://cap/../secret", authorized))
        assertNull(FrameAuthorization.authorize("file:///android_asset/a", authorized))
        assertNull(FrameAuthorization.authorize(null, authorized))
    }
}
