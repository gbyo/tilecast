package org.tilecast.player.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import org.tilecast.player.core.CoreHostState
import org.tilecast.player.core.PlayerCoreHost

/**
 * Periodic background proof that the bound server still recognizes
 * this player. Core owns the binding, the credential, and the ping;
 * the worker only starts the host and maps the outcome onto work.
 */
class HeartbeatWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val host = PlayerCoreHost.get(applicationContext)
        return try {
            host.start()
            if (host.state.value !is CoreHostState.Ready) return Result.retry()
            val ping = host.backgroundLiveness()
            if (ping.ok) {
                when (ping.outcome) {
                    "accepted" -> Result.success()
                    "mismatch" -> Result.failure()
                    "revoked" -> {
                        // The server rejected the credential while the UI
                        // was dead. Dropping it now means the next launch
                        // re-pairs against the retained server URL instead
                        // of failing every contact.
                        host.resetServer()
                        Result.failure()
                    }
                    else -> Result.retry()
                }
            } else if (ping.code == "not_paired") {
                // No binding, no credential: nothing to prove.
                Result.success()
            } else {
                Result.retry()
            }
        } catch (error: CancellationException) { throw error
        } catch (_: Exception) { Result.retry() }
    }
}
