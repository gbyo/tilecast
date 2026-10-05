package org.tilecast.player.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CastLogoTimingTest {
    @Test
    fun backTilesStartHiddenAtTheirOffsetAndSettleAtRest() {
        val delayed = CastLogoTiming.frame(0, 0.22f)
        assertEquals(0f, delayed.alpha, 0.001f)
        assertEquals(75.4f, delayed.dx, 0.001f)
        assertEquals(66.1f, delayed.dy, 0.001f)

        val near = CastLogoTiming.frame(1, 0.55f * CastLogoTiming.LOOP_SECONDS)
        assertEquals(1f, near.alpha, 0.001f)
        assertEquals(0f, near.dx, 0.001f)
        assertEquals(0f, near.dy, 0.001f)
    }

    @Test
    fun backTilesFadeOutPastTheirRestingPosition() {
        val gone = CastLogoTiming.frame(1, 0.9f * CastLogoTiming.LOOP_SECONDS)
        assertEquals(0f, gone.alpha, 0.001f)
        assertEquals(-13.2f, gone.dx, 0.001f)
        assertEquals(-11.6f, gone.dy, 0.001f)
    }

    @Test
    fun delayedTileLagsTheOtherBackTile() {
        val seconds = 0.4f
        assertTrue(CastLogoTiming.frame(0, seconds).alpha < CastLogoTiming.frame(1, seconds).alpha)
    }

    @Test
    fun frontTileTapsThenSettles() {
        assertEquals(1f, CastLogoTiming.frame(2, 0f).scale, 0.001f)
        assertEquals(0.94f, CastLogoTiming.frame(2, 0.08f * CastLogoTiming.LOOP_SECONDS).scale, 0.001f)
        assertEquals(1.02f, CastLogoTiming.frame(2, 0.2f * CastLogoTiming.LOOP_SECONDS).scale, 0.001f)
        assertEquals(1f, CastLogoTiming.frame(2, 0.5f * CastLogoTiming.LOOP_SECONDS).scale, 0.001f)
        assertEquals(0f, CastLogoTiming.frame(2, 1f).dx, 0f)
    }
}
