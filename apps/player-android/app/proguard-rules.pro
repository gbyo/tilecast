-keepattributes *Annotation*
-dontwarn javax.annotation.**

# Static JNI entry points into the native Player Core host: the Rust crate
# exports these exact names, so R8 must not rename or drop them.
-keep class org.tilecast.player.core.PlayerCoreNative { *; }

# The Kotlin handler Core calls back into: Rust looks its methods up by
# name, which R8 cannot see.
-keep class org.tilecast.player.core.CoreBridgeHandler { *; }

# rustls-platform-verifier reaches its Kotlin component over JNI, which R8
# cannot see; keep it from looking like dead code.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
