cmake_minimum_required(VERSION 3.22)
project(tilecast-session-bridge VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -Werror=implicit-function-declaration -Wformat=2 -Wno-unused-parameter)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0)
pkg_check_modules(JSONGLIB REQUIRED IMPORTED_TARGET json-glib-1.0)

# Frame building and parsing only; unit tested against the IPC fixtures.
add_library(tilecast-bridge-protocol STATIC src/protocol.c)
target_link_libraries(tilecast-bridge-protocol PUBLIC PkgConfig::JSONGLIB m)
target_include_directories(tilecast-bridge-protocol PUBLIC src)

enable_testing()
add_executable(test-bridge-protocol tests/test_protocol.c)
target_link_libraries(test-bridge-protocol PRIVATE tilecast-bridge-protocol)
target_compile_definitions(test-bridge-protocol PRIVATE
  TB_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/../../../packages/edge-protocol/fixtures/ipc")
add_test(NAME bridge-protocol COMMAND test-bridge-protocol)

# The bridge itself needs GStreamer and WirePlumber; a protocol-only build
# (-DTB_PROTOCOL_ONLY=ON) runs the unit tests without them.
option(TB_PROTOCOL_ONLY "Build only the protocol library and its tests" OFF)
if(NOT TB_PROTOCOL_ONLY)
  pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0)
  pkg_check_modules(WP REQUIRED IMPORTED_TARGET wireplumber-0.5)
  add_executable(tilecast-session-bridge src/main.c src/ipc.c src/capture.c src/inventory.c)
  target_link_libraries(tilecast-session-bridge PRIVATE tilecast-bridge-protocol PkgConfig::GIO PkgConfig::GST PkgConfig::WP)
  install(TARGETS tilecast-session-bridge RUNTIME DESTINATION bin)
endif()
