package org.tilecast.player.runtime

import org.junit.Assert.*
import org.junit.Test

class TrustedRuntimeOriginTest {
    @Test fun trustsEntryPage() {
        assertTrue(TrustedRuntimeOrigin.isTrustedDocument(TrustedRuntimeOrigin.entryUrl))
    }

    @Test fun trustsRuntimeSubresources() {
        assertTrue(TrustedRuntimeOrigin.isTrustedDocument("https://appassets.androidplatform.net/assets/shared-runtime/runtime.js"))
        assertTrue(TrustedRuntimeOrigin.isTrustedDocument("https://appassets.androidplatform.net/assets/shared-runtime/fonts/geist-latin-wght-normal.woff2"))
    }

    @Test fun refusesUntrustedSchemesAndHosts() {
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("file:///android_asset/shared-runtime/index.html"))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("data:text/html,<h1>x</h1>"))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("https://example.com/assets/shared-runtime/index.html"))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("https://appassets.androidplatform.net.evil.com/assets/shared-runtime/index.html"))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("https://appassets.androidplatform.net/other/index.html"))
    }

    @Test fun refusesTraversalAndBlank() {
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("https://appassets.androidplatform.net/assets/shared-runtime/../secret"))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument(null))
        assertFalse(TrustedRuntimeOrigin.isTrustedDocument("  "))
    }

    @Test fun confinesTopLevelNavigationToRuntime() {
        assertTrue(TrustedRuntimeOrigin.allowsTopLevelNavigation(TrustedRuntimeOrigin.entryUrl))
        assertFalse(TrustedRuntimeOrigin.allowsTopLevelNavigation("https://example.com/video"))
        assertFalse(TrustedRuntimeOrigin.allowsTopLevelNavigation("javascript:alert(1)"))
    }
}
