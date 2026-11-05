package org.tilecast.player.content

import org.junit.Assert.assertThrows
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.network.PlayerUpdateMetadata
import java.io.File
import java.nio.file.Files

class PlayerUpdateManagerTest {
    private val update=PlayerUpdateMetadata("release","org.tilecast.player",9,"0.9.0",23,100,"a".repeat(64),"b".repeat(64),"/apk")
    @Test fun acceptsMatchingUpgrade(){PlayerUpdateVerifier.validate(update,5,35,ArchiveMetadata("org.tilecast.player",9,"b".repeat(64)),"b".repeat(64))}
    @Test fun rejectsPackageMismatch(){assertThrows(IllegalArgumentException::class.java){PlayerUpdateVerifier.validate(update,5,35,ArchiveMetadata("other.app",9,"b".repeat(64)),"b".repeat(64))}}
    @Test fun rejectsDowngrade(){assertThrows(IllegalArgumentException::class.java){PlayerUpdateVerifier.validate(update,9,35,ArchiveMetadata("org.tilecast.player",9,"b".repeat(64)),"b".repeat(64))}}
    @Test fun rejectsCertificateMismatch(){assertThrows(IllegalArgumentException::class.java){PlayerUpdateVerifier.validate(update,5,35,ArchiveMetadata("org.tilecast.player",9,"c".repeat(64)),"b".repeat(64))}}
    @Test fun rejectsInstalledCertificateMismatch(){assertThrows(IllegalArgumentException::class.java){PlayerUpdateVerifier.validate(update,5,35,ArchiveMetadata("org.tilecast.player",9,"b".repeat(64)),"c".repeat(64))}}
    @Test fun rejectsUnsupportedSdk(){assertThrows(IllegalArgumentException::class.java){PlayerUpdateVerifier.validate(update.copy(minimumSdk=36),5,35,ArchiveMetadata("org.tilecast.player",9,"b".repeat(64)),"b".repeat(64))}}
    @Test fun requestsUnattendedSelfUpdateOnAndroid12AndNewer(){assertFalse(PlayerUpdateInstallPolicy.canRequestUnattended(30));assertTrue(PlayerUpdateInstallPolicy.canRequestUnattended(31));assertTrue(PlayerUpdateInstallPolicy.canRequestUnattended(35))}
    @Test fun selectsTheExactRequestedArtifactWhenSeveralAreStaged(){
        val directory=Files.createTempDirectory("tilecast-updates").toFile()
        val older=File(directory,stagedArtifactName("release-old","android-tv"));older.writeText("old")
        val requested=File(directory,stagedArtifactName("release-new","android-tv"));requested.writeText("requested")
        requested.setLastModified(older.lastModified()+60_000)
        assertEquals(requested.canonicalFile,selectExactStagedArtifact(directory,"release-new","android-tv")?.canonicalFile)
        assertEquals(null,selectExactStagedArtifact(directory,"missing","android-tv"))
        directory.deleteRecursively()
    }
    private val interrupted=UpdateUiState("deployment","0.8.0","0.9.0","installing",100,100,"Installing verified player update",releaseId="release",artifactId="artifact",expectedSha256="a".repeat(64),expectedVersionCode=9,exactPath="/updates/release-artifact.apk")
    @Test fun interruptedStagingOffersARetryWhenTheStagedFileIsStillThere(){
        val recovered=interruptedStagingState(interrupted,true)
        assertEquals("waiting_for_user",recovered.state)
        assertTrue(recovered.installReady)
        assertEquals(null,recovered.errorCode)
        assertEquals(interrupted.exactPath,recovered.exactPath)
        assertEquals(interrupted.expectedSha256,recovered.expectedSha256)
    }
    @Test fun interruptedStagingFailsExplicitlyWhenTheStagedFileIsGone(){
        val recovered=interruptedStagingState(interrupted,false)
        assertEquals("failed",recovered.state)
        assertFalse(recovered.installReady)
        assertEquals("staged_update_missing",recovered.errorCode)
    }
}
