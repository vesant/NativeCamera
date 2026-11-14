cmake_minimum_required(VERSION 3.13)

project(appmodules)

# Include React Native's New Architecture autolinking CMake setup
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

find_library(log-lib log)

# Link Android log library to appmodules (which automatically includes all .cpp files in src/main/cpp)
target_link_libraries(
    ${CMAKE_PROJECT_NAME}
    ${log-lib}
)

# Also build standalone libnativecamera_astro.so for explicit JNI loading
add_library(
    nativecamera_astro
    SHARED
    astro_stacker_jni.cpp
)

target_compile_options(
    nativecamera_astro
    PRIVATE
    -O3
    -ffast-math
    -Wall
)

target_link_libraries(
    nativecamera_astro
    ${log-lib}
)
