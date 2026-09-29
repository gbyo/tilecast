package org.tilecast.player.conformance

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

/**
 * Debug-only host for the Player Runtime conformance suite (never ships).
 * A blank fullscreen container; the test sizes and drives one WebView per
 * fixture. Mirrors the Electron runner's test-only preload: the bridge here
 * exists only to hand fixtures in and results out.
 */
class ConformanceActivity : Activity() {
    lateinit var container: FrameLayout
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = FrameLayout(this)
        setContentView(container)
    }
}
