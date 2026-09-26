cmake_minimum_required(VERSION 3.22)
project(tilecast-renderer-wpe VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -Werror=implicit-function-declaration -Wformat=2 -Wno-unused-parameter)

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
pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0 gstreamer-base-1.0)

add_library(tilecast-validate STATIC src/validate.c)
target_link_libraries(tilecast-validate PUBLIC PkgConfig::GIO)
target_include_directories(tilecast-validate PUBLIC src)

add_library(tilecast-media-client STATIC src/media-client.c)
target_link_libraries(tilecast-media-client PUBLIC tilecast-validate PkgConfig::GIO PkgConfig::JSONGLIB)
target_include_directories(tilecast-media-client PUBLIC src)
set_target_properties(tilecast-media-client PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_executable(tilecast-renderer-wpe
  src/main.c
  src/ipc.c
  src/protocol.c
  src/schemes.c
  src/view.c)
target_link_libraries(tilecast-renderer-wpe PRIVATE tilecast-media-client PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO)

# GStreamer source for tcmedia:// loaded into the web process (see
# src/gst-tcmedia.c). Installed to lib/gstreamer-1.0 of the Edge release.
add_library(gsttcmedia MODULE src/gst-tcmedia.c)
target_link_libraries(gsttcmedia PRIVATE tilecast-media-client PkgConfig::GST)
set_target_properties(gsttcmedia PROPERTIES LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/gstreamer-1.0 C_VISIBILITY_PRESET default)
set_target_properties(tilecast-validate PROPERTIES POSITION_INDEPENDENT_CODE ON)
install(TARGETS gsttcmedia LIBRARY DESTINATION lib/gstreamer-1.0)

enable_testing()
add_executable(test-validate tests/test_validate.c)
target_link_libraries(test-validate PRIVATE tilecast-validate)
add_test(NAME validate COMMAND test-validate)

add_executable(test-media-client tests/test_media_client.c)
target_link_libraries(test-media-client PRIVATE tilecast-media-client)
target_compile_definitions(test-media-client PRIVATE TC_MEDIA_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/media")
add_test(NAME media-client COMMAND test-media-client)

install(TARGETS tilecast-renderer-wpe RUNTIME DESTINATION bin)

# Player Runtime conformance runner (test-only, never installed): runs the
# shared conformance fixtures under WPE WebKit headless.
add_executable(tilecast-runtime-conformance tests/conformance.c)
target_link_libraries(tilecast-runtime-conformance PRIVATE tilecast-validate PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO)
