package org.tilecast.player.core

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

/**
 * Blank host for renderer device tests. Production attaches the
 * trusted WebView to the player UI; the harness reproduces that so
 * view-posted work (nudges, the component probe) actually runs.
 */
class RendererHarnessActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this))
    }
}
