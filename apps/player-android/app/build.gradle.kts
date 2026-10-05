import java.util.Properties
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ValueSource
import org.gradle.api.provider.ValueSourceParameters
import org.gradle.api.tasks.Sync
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

// Single source of truth for the pinned NDK: AGP installs this revision and
// the native build task resolves it for cargo-ndk.
val tilecastNdkVersion = "29.0.14206865"

android {
    namespace = "org.tilecast.player"
    compileSdk = 37
    // Pinned: the native Player Core build must not drift with the CI image.
    // NDK r28+ aligns 64-bit libraries to 16 KB by default; the explicit
    // max-page-size flags in .cargo/config.toml cover 32-bit ARM as well.
    ndkVersion = tilecastNdkVersion

    defaultConfig {
        applicationId = "org.tilecast.player"
        minSdk = 23
        targetSdk = 35
        // Keep versionCode monotonic for signed GitHub releases.
        versionCode = 46
        versionName = "0.25.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("long", "MEDIA_CACHE_BYTES", "${providers.gradleProperty("TILECAST_PLAYER_CACHE_BYTES").orElse("8589934592").get()}L")
        buildConfigField("long", "MINIMUM_FREE_BYTES", "${providers.gradleProperty("TILECAST_PLAYER_MINIMUM_FREE_BYTES").orElse("1073741824").get()}L")
        buildConfigField("long", "AUTOMATIC_VIDEO_THRESHOLD_BYTES", "${providers.gradleProperty("TILECAST_PLAYER_AUTOMATIC_VIDEO_THRESHOLD_BYTES").orElse("268435456").get()}L")
        buildConfigField("int", "CONCURRENT_DOWNLOADS", providers.gradleProperty("TILECAST_PLAYER_CONCURRENT_DOWNLOADS").orElse("2").get())
    }

    val releaseKeystore = providers.environmentVariable("TILECAST_ANDROID_KEYSTORE_PATH")
    val releaseStorePassword = providers.environmentVariable("TILECAST_ANDROID_KEYSTORE_PASSWORD")
    val releaseAlias = providers.environmentVariable("TILECAST_ANDROID_KEY_ALIAS")
    val releaseKeyPassword = providers.environmentVariable("TILECAST_ANDROID_KEY_PASSWORD")
    signingConfigs {
        if (releaseKeystore.isPresent && releaseStorePassword.isPresent && releaseAlias.isPresent && releaseKeyPassword.isPresent) {
            create("production") {
                storeFile = file(releaseKeystore.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("production")
        }
    }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    testOptions.unitTests.isIncludeAndroidResources = true
}

// AGP 9 ships built-in Kotlin support; the old android.kotlinOptions DSL is
// gone. Configure the JVM target through the Kotlin compiler options instead.
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // The legacy Room schema lives in androidTest now: only the legacy-import
    // device test seeds a pre-migration database for the native importer.
    // 2.7.0 matches the Room WorkManager already ships; consistent resolution
    // pins androidTest to the app's resolved version.
    androidTestImplementation("androidx.room:room-runtime:2.7.0")
    androidTestImplementation("androidx.room:room-ktx:2.7.0")
    kspAndroidTest("androidx.room:room-compiler:2.7.0")
    // WorkManager 2.12 raises minSdk to 24; Tilecast still supports API 23.
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    // Trusted Player Runtime host (WebViewAssetLoader, WebMessageListener).
    // minSdk stays 23: webkit 1.15.x is the newest stable line supporting API
    // 23 (1.16.x requires API 24). Required APIs are feature-detected at
    // runtime; an unsupported WebView fails closed, never silently downgrades.
    implementation("androidx.webkit:webkit:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    // Kotlin component of rustls-platform-verifier. The version stays
    // unpinned here: the resolution strategy below pins it to the
    // rustls-platform-verifier-android version in the root Cargo.lock, which
    // is the exact native component it must match.
    implementation("org.rustls:rustls-platform-verifier")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.google.zxing:core:3.5.4")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.0")
    testImplementation("androidx.room:room-testing:2.8.5")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Shared Player Runtime packaging: the APK serves the exact generated
// packages/player-runtime/dist/runtime artifact, never a committed snapshot.
// syncSharedRuntime copies it into (gitignored) app assets; verifySharedRuntime
// checks every file against runtime-manifest.json. preBuild depends on the
// verification so assembleDebug/assembleRelease cannot package a stale runtime.
val sharedRuntimeSource = layout.projectDirectory.dir("../../../packages/player-runtime/dist/runtime")
val sharedRuntimeAssets = layout.projectDirectory.dir("src/main/assets/shared-runtime")

tasks.register<Sync>("syncSharedRuntime") {
    group = "tilecast"
    description = "Copies the built shared Player Runtime into app assets."
    from(sharedRuntimeSource)
    into(sharedRuntimeAssets)
}

tasks.register<Exec>("verifySharedRuntime") {
    group = "tilecast"
    description = "Verifies packaged runtime files against runtime-manifest.json."
    dependsOn("syncSharedRuntime")
    inputs.dir(sharedRuntimeAssets)
    commandLine(
        "python3", "-c",
        """
        import hashlib, json, os, sys
        dest = sys.argv[1]
        manifest_path = os.path.join(dest, "runtime-manifest.json")
        if not os.path.isfile(manifest_path):
            sys.exit("packages/player-runtime/dist/runtime is missing; run: npm run build --workspace @tilecast/player-runtime")
        manifest = json.load(open(manifest_path))
        seen = set()
        for entry in manifest["files"]:
            p = entry["path"]
            segs = p.split("/")
            if (not p or p.startswith("/") or "\\" in p or "\x00" in p
                    or any(s in ("", ".", "..") for s in segs)
                    or len(segs) > 2 or (len(segs) == 2 and segs[0] != "fonts")):
                sys.exit("refusing manifest path: " + p)
            if p in seen:
                sys.exit("duplicate manifest path: " + p)
            seen.add(p)
            full = os.path.join(dest, *segs)
            if not os.path.isfile(full):
                sys.exit("missing runtime file: " + p)
            data = open(full, "rb").read()
            if len(data) != entry["bytes"]:
                sys.exit("size mismatch: " + p)
            if hashlib.sha256(data).hexdigest() != entry["sha256"].lower():
                sys.exit("hash mismatch: " + p)
        found = set()
        for root, _, files in os.walk(dest):
            for name in files:
                rel = os.path.relpath(os.path.join(root, name), dest)
                if rel == "runtime-manifest.json":
                    continue
                found.add(rel)
        extra = found - seen
        if extra:
            sys.exit("unexpected runtime file: " + sorted(extra)[0])
        print("verifySharedRuntime: %d runtime files verified" % len(seen))
        """.trimIndent(),
        sharedRuntimeAssets.asFile.absolutePath,
    )
}

tasks.named("preBuild") { dependsOn("verifySharedRuntime", "buildNativeCore") }

// The Kotlin verifier component must match the native
// rustls-platform-verifier-android crate exactly; a SemVer mismatch crashes
// at handshake time. This reads the locked version from the root Cargo.lock
// through a ValueSource so Gradle's configuration cache stays valid. After a
// version change, regenerate gradle/verification-metadata.xml with:
// ./gradlew --write-verification-metadata sha256 :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
abstract class RustlsVersion : ValueSource<String, RustlsVersion.Params> {
    interface Params : ValueSourceParameters {
        val lockFile: RegularFileProperty
    }

    companion object {
        const val CRATE_NAME = "rustls-platform-verifier-android"
    }

    override fun obtain(): String {
        val lines = parameters.lockFile.get().asFile.readLines()
        val nameIndex = lines.indexOfFirst { it.trim() == "name = \"$CRATE_NAME\"" }
        val version = if (nameIndex < 0) {
            null
        } else {
            lines.drop(nameIndex + 1)
                .firstOrNull { it.trimStart().startsWith("version = ") }
                ?.substringAfter('"', "")
                ?.substringBefore('"', "")
                ?.takeIf { it.isNotEmpty() }
        }
        return version ?: error("$CRATE_NAME not found in Cargo.lock")
    }
}

val rustlsPlatformVerifierVersion = providers.of(RustlsVersion::class.java) {
    parameters.lockFile.set(layout.projectDirectory.file("../../../Cargo.lock"))
}

configurations.configureEach {
    resolutionStrategy.eachDependency {
        if (requested.group == "org.rustls" && requested.name == "rustls-platform-verifier") {
            useVersion(rustlsPlatformVerifierVersion.get())
            because("native component version must be identical to version of ${RustlsVersion.CRATE_NAME}")
        }
    }
}

// Native Player Core: cargo-ndk builds the Android host crate for every
// shipped ABI into (gitignored) build output, which jniLibs then packages.
// minSdk stays 23: cargo platform 23 matches the manifest minSdk, and the
// single org.tilecast.player application keeps one APK for all ABIs.
val repoRoot = layout.projectDirectory.dir("../../..")
val nativeJniLibs = layout.buildDirectory.dir("generated/jniLibs")
// Read at configuration time so the task action stays configuration-cache safe.
val localPropertiesSdkDir: String? = layout.projectDirectory.file("local.properties").asFile
    .takeIf { it.isFile }
    ?.let { props ->
        val loaded = Properties()
        props.inputStream().use { loaded.load(it) }
        loaded.getProperty("sdk.dir")
    }

android {
    sourceSets {
        getByName("main") {
            jniLibs.directories.add(nativeJniLibs.get().asFile.absolutePath)
        }
    }
}

tasks.register<Exec>("buildNativeCore") {
    group = "tilecast"
    description = "Builds the Player Core native library for all Android ABIs."
    workingDir = repoRoot.asFile
    val outputDir = nativeJniLibs.get().asFile
    commandLine(
        "cargo", "ndk",
        "-t", "arm64-v8a", "-t", "armeabi-v7a", "-t", "x86_64",
        "-P", "23",
        "-o", outputDir.absolutePath,
        "build", "--release",
        "-p", "tilecast-player-android-native",
    )
    inputs.dir(repoRoot.dir("apps/player-android/native"))
    inputs.dir(repoRoot.dir("crates"))
    inputs.files(repoRoot.file("Cargo.toml"), repoRoot.file("Cargo.lock"), repoRoot.file(".cargo/config.toml"))
    // Plain task inputs: the action below must not capture Gradle script
    // object references, which the configuration cache cannot serialize.
    inputs.property("pinnedNdkVersion", tilecastNdkVersion)
    if (localPropertiesSdkDir != null) {
        inputs.property("localPropertiesSdkDir", localPropertiesSdkDir)
    }
    outputs.dir(outputDir)
    doFirst {
        val pinnedNdkVersion = inputs.properties["pinnedNdkVersion"] as String
        val propsSdkDir = inputs.properties["localPropertiesSdkDir"] as String?
        val pathDirs = (System.getenv("PATH") ?: "").split(File.pathSeparator)
        val cargo = pathDirs.map { File(it, "cargo") }.firstOrNull { it.isFile && it.canExecute() }
        checkNotNull(cargo) {
            "cargo not found on PATH; install the Rust toolchain from rust-toolchain.toml plus cargo-ndk 4.x to build the native Player Core (see apps/player-android/README.md)"
        }
        val cargoNdk = pathDirs.map { File(it, "cargo-ndk") }.firstOrNull { it.isFile && it.canExecute() }
        checkNotNull(cargoNdk) {
            "cargo-ndk not found on PATH; install it with: cargo install cargo-ndk --version 4.1.2 --locked"
        }
        // AGP 9 exposes no resolved NDK directory, so resolve the pinned
        // side-by-side NDK explicitly. CI installs it with sdkmanager; local
        // builds pick up ANDROID_NDK_HOME, local.properties, ANDROID_HOME, or
        // the conventional SDK locations, in that order.
        val explicitNdk = listOf("ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME")
            .mapNotNull { System.getenv(it)?.takeIf { dir -> dir.isNotEmpty() }?.let(::File) }
            .firstOrNull { it.isDirectory }
        val sdkRoots = sequenceOf(
            propsSdkDir?.let(::File),
            System.getenv("ANDROID_HOME")?.let(::File),
            System.getenv("ANDROID_SDK_ROOT")?.let(::File),
            File(System.getProperty("user.home"), "Library/Android/sdk"),
            File(System.getProperty("user.home"), "Android/Sdk"),
        ).filterNotNull().filter { it.isDirectory }
        // The pinned side-by-side NDK wins. An explicit NDK directory is
        // accepted only when its source.properties revision matches the
        // pin, so a stale environment variable cannot silently switch the
        // toolchain out from under the build.
        val pinnedNdkDir =
            sdkRoots.map { File(it, "ndk/$pinnedNdkVersion") }.firstOrNull { it.isDirectory }
        // Inline: task actions must not capture script-level function
        // references, which the configuration cache cannot serialize.
        val explicitRevision = explicitNdk?.resolve("source.properties")
            ?.takeIf { it.isFile }
            ?.readLines()
            ?.firstOrNull { it.trimStart().startsWith("Pkg.Revision") }
            ?.substringAfter("=")
            ?.trim()
        val ndkDir = pinnedNdkDir
            ?: explicitNdk?.takeIf { explicitRevision == pinnedNdkVersion }
        checkNotNull(ndkDir) {
            "pinned NDK $pinnedNdkVersion not found; install it with: sdkmanager \"ndk;$pinnedNdkVersion\""
        }
        environment("ANDROID_NDK_HOME", ndkDir.absolutePath)
    }
}
