package org.tilecast.player.content

import org.junit.Test
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.tilecast.player.network.PlayerCachePolicy
import org.tilecast.player.network.PlayerConfig
import org.tilecast.player.network.DataEnvelope
import org.tilecast.player.network.PlayerReliabilityPolicy
import org.tilecast.player.network.RegionalFormatting
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

class PlayerConfigManagerTest {
	@Test fun playerConfigV1AcceptsOldAndAdditiveRegionalPlaybackPayloads() {
		val json = Json { ignoreUnknownKeys = true }
		val oldServer = json.decodeFromString(
			DataEnvelope.serializer(PlayerConfig.serializer()),
			"""{"data":{"schemaVersion":1,"configRevision":4,"generatedAt":"2026-07-12T18:00:00Z","playback":{"defaultVolume":0.5}}}""",
		).data
		assertEquals(null, oldServer.playback.regionalFormat)

		val newServer = json.decodeFromString(
			DataEnvelope.serializer(PlayerConfig.serializer()),
			"""{"data":{"schemaVersion":1,"configRevision":5,"generatedAt":"2026-07-12T18:00:00Z","playback":{"regionalFormat":{"locale":"de-DE","timezone":"Europe/Berlin","dateFormat":"locale","timeFormat":"locale","firstDayOfWeek":"monday"}}}}""",
		).data
		assertEquals(RegionalFormatting("de-DE", "Europe/Berlin", "locale", "locale", "monday"), newServer.playback.regionalFormat)
	}

	@Test fun webviewWatchdogUsesTheAuthoritativeWebviewThreshold(){
		val policy=PlayerReliabilityPolicy(playbackStallSeconds=30,webviewStallSeconds=75)
		assertEquals(75,watchdogThresholdSeconds(policy,true))
		assertEquals(30,watchdogThresholdSeconds(policy,false))
	}
    @Test fun validatesSafeConfiguration(){PlayerConfigValidator.validate(PlayerConfig(1,2,"2026-07-12T18:00:00Z"))}
    @Test(expected=IllegalArgumentException::class) fun rejectsUnsafeReportingInterval(){PlayerConfigValidator.validate(PlayerConfig(1,2,"2026-07-12T18:00:00Z",cache=PlayerCachePolicy(concurrentDownloads=20)))}
    @Test fun rejectsStaleOrDuplicateRevisions(){
        assertFalse(shouldAcceptPlayerConfig(4, 3))
        assertFalse(shouldAcceptPlayerConfig(4, 4))
    }
    @Test fun acceptsFirstAndNewerRevisions(){
        assertTrue(shouldAcceptPlayerConfig(null, 1))
        assertTrue(shouldAcceptPlayerConfig(4, 5))
    }
    @Test fun acceptsSameRevisionToRepairAnUnverifiedCache(){
        assertTrue(shouldAcceptPlayerConfig(4, 4, activeConfigVerified = false))
    }
    @Test fun onlySendsConditionalRequestAfterConfigVerification(){
        assertEquals("etag-1", playerConfigEtagForRequest(true, "etag-1"))
        assertEquals(null, playerConfigEtagForRequest(false, "etag-1"))
    }
}
