cmake_minimum_required(VERSION 3.22)
project(tilecast-renderer-wpe VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
add_compile_options(-Wall -Wextra -Werror=implicit-function-declaration -Wformat=2 -Wno-unused-parameter)

find_package(PkgConfig REQUIRED)
# WPEPlatform only: no libwpe, no WPEBackend-fdo, no Cog (RFC §28.1).
pkg_check_modules(WPE REQUIRED IMPORTED_TARGET
  wpe-webkit-2.0>=2.54
  wpe-platform-2.0>=2.54
  wpe-platform-drm-2.0>=2.54
  wpe-platform-wayland-2.0>=2.54
  wpe-platform-headless-2.0>=2.54)
pkg_check_modules(JSONGLIB REQUIRED IMPORTED_TARGET json-glib-1.0)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0)

add_library(tilecast-validate STATIC src/validate.c)
target_link_libraries(tilecast-validate PUBLIC PkgConfig::GIO)
target_include_directories(tilecast-validate PUBLIC src)

add_executable(tilecast-renderer-wpe
  src/main.c
  src/ipc.c
  src/protocol.c
  src/schemes.c
  src/view.c)
target_link_libraries(tilecast-renderer-wpe PRIVATE tilecast-validate PkgConfig::WPE PkgConfig::JSONGLIB PkgConfig::GIO)

enable_testing()
add_executable(test-validate tests/test_validate.c)
target_link_libraries(test-validate PRIVATE tilecast-validate)
add_test(NAME validate COMMAND test-validate)

install(TARGETS tilecast-renderer-wpe RUNTIME DESTINATION bin)
