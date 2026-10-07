cmake_minimum_required(VERSION 3.22)
project(tilecast-web-renderer-wpe VERSION 0.1.0 LANGUAGES C)

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

find_package(PkgConfig REQUIRED)
# WPEPlatform headless only; the helper never opens a display of its own
# (docs/tilecast-edge-remote-web-threat-review.md).
pkg_check_modules(WPE REQUIRED IMPORTED_TARGET
  wpe-webkit-2.0>=2.54
  wpe-platform-2.0>=2.54
  wpe-platform-headless-2.0>=2.54)
pkg_check_modules(JSONGLIB REQUIRED IMPORTED_TARGET json-glib-1.0)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0)
pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-allocators-1.0)
pkg_check_modules(EGL REQUIRED IMPORTED_TARGET egl)

# The remote web protocol and the navigation policy: pure code, also built
# into tilecast-renderer-wpe (the protocol) and the unit tests.
add_library(tilecast-rw-protocol STATIC src/rw-protocol.c src/policy.c)
target_link_libraries(tilecast-rw-protocol PUBLIC PkgConfig::GIO PkgConfig::JSONGLIB)
target_include_directories(tilecast-rw-protocol PUBLIC src)
set_target_properties(tilecast-rw-protocol PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(tilecast-web-frames STATIC src/frames.c)
target_link_libraries(tilecast-web-frames PUBLIC PkgConfig::WPE PkgConfig::GST PkgConfig::EGL)
target_include_directories(tilecast-web-frames PUBLIC src)

add_executable(tilecast-web-renderer-wpe
  src/main.c
  src/control.c
  src/surface.c
  src/profiles.c
  src/youtube.c)
target_link_libraries(tilecast-web-renderer-wpe PRIVATE tilecast-rw-protocol tilecast-web-frames PkgConfig::WPE
  PkgConfig::JSONGLIB PkgConfig::GIO PkgConfig::GST)
install(TARGETS tilecast-web-renderer-wpe RUNTIME DESTINATION bin)

enable_testing()
set(TC_RW_FIXTURES "${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/remote-web")

add_executable(test-rw-policy tests/test_policy.c)
target_link_libraries(test-rw-policy PRIVATE tilecast-rw-protocol)
add_test(NAME rw-policy COMMAND test-rw-policy)

add_executable(test-rw-protocol tests/test_protocol.c)
target_link_libraries(test-rw-protocol PRIVATE tilecast-rw-protocol)
target_compile_definitions(test-rw-protocol PRIVATE TC_RW_FIXTURE_DIR="${TC_RW_FIXTURES}")
add_test(NAME rw-protocol COMMAND test-rw-protocol)

# The GPU copy on llvmpipe with udmabuf-backed buffers; skips (exit 77) where
# the EGL extensions or /dev/udmabuf are missing.
add_executable(test-rw-frames tests/test_frames.c)
target_link_libraries(test-rw-frames PRIVATE tilecast-web-frames)
add_test(NAME rw-frames COMMAND test-rw-frames)
set_tests_properties(rw-frames PROPERTIES SKIP_RETURN_CODE 77)
