package org.tilecast.player.ui

import java.io.File
import java.nio.ByteBuffer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.runtime.TrustedRuntimeOrigin
import org.tilecast.player.ui.theme.SignalTypography
import org.tilecast.player.ui.theme.TilecastFontFamily

/**
 * Tilecast-owned native text is Geist, and the shared runtime still carries
 * its own Geist for the WebView. Both are asserted here so neither can slip
 * back to the platform's sans-serif without a failing build.
 */
class TilecastTypographyTest {
    // Gradle runs unit tests with the module directory as the working directory.
    private fun module(path: String) = File(path).takeIf { it.exists() } ?: File("app/$path")

    @Test fun everyMaterialTextStyleUsesTheGeistFamily() {
        val styles = with(SignalTypography) {
            listOf(
                displayLarge, displayMedium, displaySmall,
                headlineLarge, headlineMedium, headlineSmall,
                titleLarge, titleMedium, titleSmall,
                bodyLarge, bodyMedium, bodySmall,
                labelLarge, labelMedium, labelSmall,
            )
        }
        assertEquals(15, styles.size)
        for (style in styles) assertEquals(TilecastFontFamily, style.fontFamily)
    }

    @Test fun noNativeSourceChoosesAPlatformFontFamily() {
        val sources = module("src/main/java").walkTopDown().filter { it.extension == "kt" }.toList()
        assertTrue(sources.size > 20)
        for (file in sources) {
            val text = file.readText()
            for (forbidden in listOf("FontFamily.SansSerif", "FontFamily.Default", "FontFamily.Serif", "FontFamily.Monospace", "FontFamily.Cursive")) {
                assertFalse("${file.name} must not use $forbidden: Tilecast text takes Geist from the theme", forbidden in text)
            }
            // Only the typography definition names a family.
            if (file.name != "Type.kt") {
                assertFalse("${file.name} must not set its own fontFamily", Regex("""fontFamily\s*=""").containsMatchIn(text))
            }
        }
    }

    private fun sfntTables(bytes: ByteArray): Set<String> {
        val buffer = ByteBuffer.wrap(bytes)
        val tag = buffer.getInt(0)
        assertTrue("a TrueType or OpenType font", tag == 0x00010000 || tag == 0x4F54544F)
        val count = buffer.getShort(4).toInt() and 0xFFFF
        return (0 until count).map { index -> String(bytes, 12 + index * 16, 4, Charsets.US_ASCII) }.toSet()
    }

    @Test fun thePackagedFontIsTheVendoredGeistVariableFont() {
        val packaged = module("build/generated/geist/res/font/geist_variable.ttf")
        assertTrue("run syncGeistFont: ${packaged.path}", packaged.isFile)
        val source = module("../../ios/Tilecast/Resources/Fonts/Geist-Variable.ttf")
        assertTrue(source.isFile)
        // One vendored copy, not a second binary that can drift.
        assertTrue(packaged.readBytes().contentEquals(source.readBytes()))
        val bytes = packaged.readBytes()
        assertTrue("variable font (fvar)", "fvar" in sfntTables(bytes))
        // Name records are Mac Roman (ASCII) or Windows (UTF-16BE) strings.
        assertTrue(
            "family name inside the font",
            String(bytes, Charsets.ISO_8859_1).contains("Geist") || String(bytes, Charsets.UTF_16BE).contains("Geist") ||
                String(bytes, 1, bytes.size - 1, Charsets.UTF_16BE).contains("Geist"),
        )
        val license = module("build/generated/geist/assets/licenses/Geist-OFL.txt")
        assertTrue(license.isFile && license.readText().contains("SIL OPEN FONT LICENSE"))
    }

    @Test fun theSharedRuntimeStillPackagesAndServesItsOwnGeist() {
        val runtime = module("src/main/assets/shared-runtime")
        val manifest = Json.parseToJsonElement(File(runtime, "runtime-manifest.json").readText()).jsonObject
        val packaged = manifest["files"]!!.jsonArray.map { it.jsonObject["path"]!!.jsonPrimitive.content }.toSet()
        val css = File(runtime, "runtime.css").readText()
        val referenced = Regex("""url\("(fonts/[^"]+)"\)""").findAll(css).map { it.groupValues[1] }.toSet()
        assertTrue("runtime.css declares Geist faces", referenced.any { "geist-latin-wght" in it })
        assertTrue("font-family Tilecast UI", "\"Tilecast UI\"" in css)
        for (font in referenced) {
            assertTrue("$font is in the verified runtime manifest", font in packaged)
            assertTrue("$font is present in the APK assets", File(runtime, font).isFile)
            // Served by the asset loader under the trusted app origin, same-origin with the document.
            val url = "${TrustedRuntimeOrigin.origin}${TrustedRuntimeOrigin.RUNTIME_PATH_PREFIX}$font"
            assertTrue(TrustedRuntimeOrigin.isTrustedDocument(url))
            assertEquals("https://appassets.androidplatform.net/assets/shared-runtime/$font", url)
        }
        assertTrue("fonts/OFL.txt" in packaged)
    }
}
