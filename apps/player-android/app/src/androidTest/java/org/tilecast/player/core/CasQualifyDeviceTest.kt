package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the native CAS storage checklist on the device filesystem and
 * requires every check to pass. This is the Android CAS qualification:
 * verified commits, size and digest enforcement, symlink refusal, partial
 * resume, crash reconciliation, pin-aware eviction, and free-space reserve
 * behavior, all proven on real app-private storage rather than assumed
 * from host Filesystem behavior.
 */
class CasQualifyDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun casChecklistPassesOnDeviceStorage() {
        val raw = PlayerCoreNative.nativeQualifyCas(context.filesDir.absolutePath)
        assertTrue("qualify returned null", raw != null)
        val report = JSONObject(raw!!)
        assertTrue("report not ok: $raw", report.optBoolean("ok", false))
        val checks = report.getJSONArray("checks")
        val names = mutableSetOf<String>()
        for (i in 0 until checks.length()) {
            val check = checks.getJSONObject(i)
            val name = check.getString("name")
            names += name
            assertTrue(
                "check $name failed: ${check.optString("detail")}",
                check.getBoolean("passed"),
            )
        }
        val expected = setOf(
            "space_probe",
            "commit_and_serve",
            "size_bound",
            "digest_enforced",
            "tamper_detected",
            "symlink_import_refused",
            "symlink_object_not_served",
            "crash_resume",
            "pins_survive_eviction",
            "space_reserve",
            "remove_refuses_pinned",
            "cleanup",
        )
        assertEquals("checklist changed: $names", expected, names)
    }
}
