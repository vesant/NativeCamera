package com.vesant.nativecamera

/**
 * Kotlin JNI bridge to `libnativecamera_astro.so` (implemented in `astro_stacker_jni.cpp`).
 * Handles sub-pixel star centroid detection, 2D RANSAC rigid registration, sigma-clipped
 * multi-frame astrophotography stacking, Mertens HDR+ exposure fusion, Light Trails
 * max-blending, Night Super-Resolution denoising, and Macro Focus Stacking in native C++ memory.
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
    external fun addUnalignedFrameAndGetPreview(
        frameArgb: IntArray,
        frameIndex: Int,
        previewMode: Int,
        previewArgbOut: IntArray
    ): String

    @JvmStatic
    external fun finalizeStack(finalArgbOut: IntArray): String

    @JvmStatic
    external fun finalizeComputationalMode(
        modeCode: Int,
        finalArgbOut: IntArray
    ): String

    @JvmStatic
    external fun resetSession()
}
