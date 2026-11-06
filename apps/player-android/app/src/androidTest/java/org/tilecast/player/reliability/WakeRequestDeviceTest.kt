package org.tilecast.player.reliability

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.tilecast.player.MainActivity

/** Run on a disposable Player device: launching the Activity starts Core. */
@RunWith(AndroidJUnit4::class)
class WakeRequestDeviceTest {
    @Test
    fun repeatedWakeRequestsKeepTheExistingActivity() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var original: MainActivity
            scenario.onActivity { original = it }
            repeat(3) {
                scenario.onActivity { activity ->
                    assertEquals(
                        "device_wake_requested",
                        ReliabilityController(activity.applicationContext).requestWake(),
                    )
                }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity { assertSame(original, it) }
            }
        }
    }
}
