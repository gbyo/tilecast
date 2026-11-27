cmake_minimum_required(VERSION 3.22)
project(tilecast-renderer-wpe VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -Werror=implicit-function-declaration -Wformat=2 -Wno-unused-parameter)

# Release builds always keep WebKit's bubblewrap sandbox: they clear
# WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS at startup. Only development and CI
# containers that cannot create user namespaces turn this on.
option(TILECAST_ALLOW_UNSANDBOXED_WEBKIT "Honor WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS (development and CI only)" OFF)
if(TILECAST_ALLOW_UNSANDBOXED_WEBKIT)
  add_compile_definitions(TILECAST_ALLOW_UNSANDBOXED_WEBKIT=1)
endif()

# A diagnostic overlay build (diagnostics/build-runtime-overlay.sh) names the
# Tilecast commit it was built from; the visual trace header repeats it. A
# release build leaves it "unknown".
set(TILECAST_BUILD_COMMIT "unknown" CACHE STRING "Tilecast git commit of this build (diagnostics only)")
# CMake regular expressions have no {n} repetition, so the length is a separate check.
set(_tc_commit_valid FALSE)
if(TILECAST_BUILD_COMMIT STREQUAL "unknown")
  set(_tc_commit_valid TRUE)
elseif(TILECAST_BUILD_COMMIT MATCHES "^([0-9a-f]+)(-dirty)?$")
  string(LENGTH "${CMAKE_MATCH_1}" _tc_commit_length)
  if(_tc_commit_length EQUAL 40)
    set(_tc_commit_valid TRUE)
  endif()
endif()
if(NOT _tc_commit_valid)
  message(FATAL_ERROR "TILECAST_BUILD_COMMIT must be 'unknown', a 40-digit commit, or a commit with '-dirty'")
endif()
add_compile_definitions(TC_BUILD_COMMIT="${TILECAST_BUILD_COMMIT}")

find_package(PkgConfig REQUIRED)
# WPEPlatform only: no libwpe, no WPEBackend-fdo, no Cog (docs/tilecast-edge.md §10.1).
pkg_check_modules(WPE REQUIRED IMPORTED_TARGET
  wpe-webkit-2.0>=2.54
  wpe-platform-2.0>=2.54
  wpe-platform-drm-2.0>=2.54
  wpe-platform-wayland-2.0>=2.54
  wpe-platform-headless-2.0>=2.54)
pkg_check_modules(JSONGLIB REQUIRED IMPORTED_TARGET json-glib-1.0)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0)
pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0 gstreamer-base-1.0 gstreamer-app-1.0 gstreamer-video-1.0)
pkg_check_modules(DRM REQUIRED IMPORTED_TARGET libdrm>=2.4.112)

add_library(tilecast-validate STATIC src/validate.c)
target_link_libraries(tilecast-validate PUBLIC PkgConfig::GIO PkgConfig::JSONGLIB)
target_include_directories(tilecast-validate PUBLIC src)

add_library(tilecast-media-client STATIC src/media-client.c)
target_link_libraries(tilecast-media-client PUBLIC tilecast-validate PkgConfig::GIO PkgConfig::JSONGLIB)
target_include_directories(tilecast-media-client PUBLIC src)
set_target_properties(tilecast-media-client PROPERTIES POSITION_INDEPENDENT_CODE ON)

# The remote web protocol v1, shared with tilecast-web-renderer-wpe.
set(TC_WEB_HELPER_SRC ${CMAKE_SOURCE_DIR}/../web-renderer-wpe/src)
add_library(tilecast-rw-protocol STATIC ${TC_WEB_HELPER_SRC}/rw-protocol.c)
target_link_libraries(tilecast-rw-protocol PUBLIC PkgConfig::GIO PkgConfig::JSONGLIB)
target_include_directories(tilecast-rw-protocol PUBLIC ${TC_WEB_HELPER_SRC})

# Pixel validation and the one deep copy of a presented WPE buffer (GLib only,
# so tests/test_preview_pixels.c runs without a WPE graphics stack).
add_library(tilecast-preview-pixels STATIC src/preview-pixels.c)
target_link_libraries(tilecast-preview-pixels PUBLIC PkgConfig::GIO PkgConfig::DRM)
target_include_directories(tilecast-preview-pixels PUBLIC src)

# Watch Live H.264 qualification tiers (GLib only, so the probe ladder is
# unit tested without VA-API).
add_library(tilecast-live-profiles STATIC src/live-profiles.c)
target_link_libraries(tilecast-live-profiles PUBLIC PkgConfig::GIO)
target_include_directories(tilecast-live-profiles PUBLIC src)

# Opt-in visual trace and compositor lab helpers (GLib and json-glib only, so
# tests/test_visual_trace_format.c runs without a WPE graphics stack).
add_library(tilecast-visual-trace-format STATIC src/visual-trace-format.c)
target_link_libraries(tilecast-visual-trace-format PUBLIC tilecast-validate PkgConfig::JSONGLIB PkgConfig::GIO m)
target_include_directories(tilecast-visual-trace-format PUBLIC src)

add_executable(tilecast-renderer-wpe
  src/main.c
  src/buffer-timeline.c
  src/visual-trace.c
  src/drm-probe.c
  src/preview.c
  src/live-encoder.c
  src/ipc.c
  src/protocol.c
  src/schemes.c
  src/remote-web.c
  src/frame-navigation.c
  src/present-relay.c
  src/view.c)
target_link_libraries(tilecast-renderer-wpe PRIVATE tilecast-visual-trace-format tilecast-live-profiles tilecast-preview-pixels tilecast-media-client tilecast-rw-protocol tilecast-rw-channel PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO PkgConfig::GST PkgConfig::DRM m)

# GStreamer source for tcmedia:// loaded into the web process (see
# src/gst-tcmedia.c). Installed to lib/gstreamer-1.0 of the Edge release.
add_library(gsttcmedia MODULE src/gst-tcmedia.c)
target_link_libraries(gsttcmedia PRIVATE tilecast-media-client PkgConfig::GST)
set_target_properties(gsttcmedia PROPERTIES LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/gstreamer-1.0 C_VISIBILITY_PRESET default)
set_target_properties(tilecast-validate PROPERTIES POSITION_INDEPENDENT_CODE ON)
install(TARGETS gsttcmedia LIBRARY DESTINATION lib/gstreamer-1.0)

enable_testing()
add_executable(test-validate tests/test_validate.c)
target_compile_definitions(test-validate PRIVATE TC_IPC_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/ipc")
target_link_libraries(test-validate PRIVATE tilecast-validate)
add_test(NAME validate COMMAND test-validate)

add_executable(test-preview-pixels tests/test_preview_pixels.c)
target_link_libraries(test-preview-pixels PRIVATE tilecast-preview-pixels)
add_test(NAME preview-pixels COMMAND test-preview-pixels)

add_executable(test-live-profiles tests/test_live_profiles.c)
target_link_libraries(test-live-profiles PRIVATE tilecast-live-profiles)
add_test(NAME live-profiles COMMAND test-live-profiles)

add_executable(test-motion-setting tests/test_motion_setting.c)
target_include_directories(test-motion-setting PRIVATE src)
target_link_libraries(test-motion-setting PRIVATE PkgConfig::GIO)
add_test(NAME motion-setting COMMAND test-motion-setting)

add_executable(test-media-client tests/test_media_client.c)
target_link_libraries(test-media-client PRIVATE tilecast-media-client)
target_compile_definitions(test-media-client PRIVATE TC_MEDIA_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/media")
add_test(NAME media-client COMMAND test-media-client)

# Bounded async helper channel (remote-web.c write side): GLib/GIO only, no
# WebKit, so the backpressure and flood-budget regression tests run anywhere.
add_library(tilecast-rw-channel STATIC src/rw-channel.c)
target_link_libraries(tilecast-rw-channel PUBLIC PkgConfig::GIO)
target_include_directories(tilecast-rw-channel PUBLIC src)

# The AirPlay relay against a fake media socket and real loopback UDP, with
# unixfdsrc on the far side as the web process uses it.
add_executable(test-present-relay tests/test_present_relay.c src/present-relay.c)
target_include_directories(test-present-relay PRIVATE src)
target_link_libraries(test-present-relay PRIVATE tilecast-media-client PkgConfig::GST)
target_compile_definitions(test-present-relay PRIVATE TC_MEDIA_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/media")
add_test(NAME present-relay COMMAND test-present-relay)

add_executable(test-visual-trace-format tests/test_visual_trace_format.c)
target_link_libraries(test-visual-trace-format PRIVATE tilecast-visual-trace-format)
add_test(NAME visual-trace-format COMMAND test-visual-trace-format)

add_executable(test-rw-channel tests/test_rw_channel.c)
target_link_libraries(test-rw-channel PRIVATE tilecast-rw-channel)
add_test(NAME rw-channel COMMAND test-rw-channel)

install(TARGETS tilecast-renderer-wpe RUNTIME DESTINATION bin)

# Player Runtime conformance runner (test-only, never installed): runs the
# shared conformance fixtures under WPE WebKit headless.
add_executable(tilecast-runtime-conformance tests/conformance.c)
target_link_libraries(tilecast-runtime-conformance PRIVATE tilecast-validate PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO)

# WPE compositor lab (development and test only, never installed in a
# release): deterministic synthetic scenes, presented-buffer inspection and
# anomaly detection, without Tilecast code (docs/tilecast-edge-wpe-compositor-lab.md).
add_library(tilecast-lab-detector STATIC lab/lab-detector.c)
target_link_libraries(tilecast-lab-detector PUBLIC PkgConfig::GIO m)
target_include_directories(tilecast-lab-detector PUBLIC lab)

add_executable(tilecast-wpe-compositor-lab lab/compositor-lab.c src/buffer-timeline.c)
target_compile_definitions(tilecast-wpe-compositor-lab PRIVATE TC_LAB_SCENES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/lab/scenes")
target_link_libraries(tilecast-wpe-compositor-lab PRIVATE tilecast-lab-detector tilecast-visual-trace-format tilecast-preview-pixels PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO m)

add_executable(test-lab-detector tests/test_lab_detector.c)
target_link_libraries(test-lab-detector PRIVATE tilecast-lab-detector)
add_test(NAME lab-detector COMMAND test-lab-detector)

# Real-engine navigation qualification; never installed in a release.
add_executable(test-frame-navigation tests/test_frame_navigation.c src/frame-navigation.c)
target_include_directories(test-frame-navigation PRIVATE src)
target_link_libraries(test-frame-navigation PRIVATE PkgConfig::WPE PkgConfig::GIO)
