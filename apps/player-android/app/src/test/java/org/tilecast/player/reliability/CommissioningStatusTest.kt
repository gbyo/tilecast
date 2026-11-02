package org.tilecast.player.reliability

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommissioningStatusTest {
    private val paired = Instant.parse("2026-07-13T12:00:00Z")

    @Test
    fun allSafeguardsInPlaceIsReady() {
        val status = CommissioningStatus(
            accessibilityEnabled = true,
            installPermissionGranted = true,
            bootLaunchVerified = true,
            immersiveVerified = true,
            keepAwakeVerified = true,
            completedAt = paired,
        )
        assertEquals("passed", status.selfTestResult)
        assertEquals("ready", status.readiness)
    }

    @Test
    fun missingOptionalPermissionsArePartialNotBlocking() {
        val status = CommissioningStatus(
            accessibilityEnabled = false,
            installPermissionGranted = false,
            bootLaunchVerified = true,
            immersiveVerified = true,
            keepAwakeVerified = true,
            completedAt = paired,
        )
        assertEquals("completed_with_warnings", status.selfTestResult)
        assertEquals("partially_ready", status.readiness)
    }

    @Test
    fun fireTvDoesNotNeedAccessibility() {
        val status = CommissioningStatus(
            accessibilitySupported = false,
            installPermissionGranted = true,
            bootLaunchVerified = true,
            immersiveVerified = true,
            keepAwakeVerified = true,
            completedAt = paired,
        )
        assertEquals("ready", status.readiness)
    }

    @Test
    fun anUnpairedPlayerHasNoVerdict() {
        assertNull(CommissioningStatus().selfTestResult)
        assertEquals("needs_setup", CommissioningStatus().readiness)
    }
}
