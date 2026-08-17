plugins {
    id("com.android.application") version "9.3.1" apply false
    // Hold Kotlin at 2.4.0: the CodeQL extractor does not yet support 2.4.10,
    // and AGP 9's built-in Kotlin takes its compiler version from these plugins.
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.0" apply false
    id("com.google.devtools.ksp") version "2.3.11" apply false
}

