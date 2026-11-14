package com.vesant.nativecamera

/**
 * Kotlin JNI bridge to `libnativecamera_astro.so` (implemented in `astro_stacker_jni.cpp`).
 * Handles sub-pixel star centroid detection, 2D RANSAC rigid registration, and sigma-clipped
 * multi-frame astrophotography stacking in native C++ memory.
 */
object AstroStackerNative {
    init {
        System.loadLibrary("nativecamera_astro")
    }

    @JvmStatic
    external fun beginSession(width: Int, height: Int, maxFrames: Int)

    @JvmStatic
    external fun addFrameAndGetPreview(
        frameArgb: IntArray,
        frameIndex: Int,
        previewArgbOut: IntArray
    ): String

    @JvmStatic
    external fun finalizeStack(finalArgbOut: IntArray): String

    @JvmStatic
    external fun resetSession()
}
