import org.gradle.api.tasks.Sync
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "org.tilecast.player"
    compileSdk = 37

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
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    // WorkManager 2.12 raises minSdk to 24; Tilecast still supports API 23.
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    // Trusted Player Runtime host (WebViewAssetLoader, WebMessageListener).
    // minSdk stays 23: webkit 1.15.x is the newest stable line supporting API
    // 23 (1.16.x requires API 24). Required APIs are feature-detected at
    // runtime; an unsupported WebView fails closed, never silently downgrades.
    implementation("androidx.webkit:webkit:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
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

tasks.named("preBuild") { dependsOn("verifySharedRuntime") }
