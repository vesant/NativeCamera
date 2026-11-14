package com.vesant.nativecamera

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureFailure
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.DngCreator
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.ColorSpaceTransform
import android.hardware.camera2.params.RggbChannelVector
import android.media.Image
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import android.util.Log
import android.util.Range
import android.util.Rational
import android.util.Size
import android.view.Surface
import android.view.TextureView
import android.view.ViewGroup
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Native Camera2 viewfinder and capture surface used by both Pro Mode and Astro Mode.
 *
 * Why a custom TextureView instead of a high-level wrapper?
 * High-level camera libraries abstract away per-frame CaptureRequest controls. Here we talk
 * directly to CameraDevice and CameraCaptureSession so we can lock exposure in nanoseconds,
 * set exact ISO analog/digital gain, drive the lens voice-coil motor in raw diopters (0.0f = ∞),
 * compute custom RGGB white-balance channel gains, stream real-time YUV_420_888 histograms,
 * and write uncompressed 16-bit Bayer DNG files via Android's DngCreator.
 */
class CameraEngineView(context: Context) : FrameLayout(context), TextureView.SurfaceTextureListener {

    companion object {
        private const val TAG = "CameraEngineView"

        // Only one CameraDevice can hold a physical sensor at a time. When switching tabs
        // between Pro Mode and Astro Mode, this lock ensures the outgoing tab's session closes
        // before the incoming tab opens the camera.
        private val cameraOpenCloseLock = Semaphore(1)

        @Volatile
        var activeInstance: CameraEngineView? = null
    }

    private val textureView: TextureView = TextureView(context)
    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var activeCharacteristics: CameraCharacteristics? = null
    private var previewSize: Size = Size(1920, 1080)

    private var yuvReader: ImageReader? = null
    private var jpegReader: ImageReader? = null
    private var rawReader: ImageReader? = null
    private var rawSurfaceConfigured: Boolean = false

    // Viewfinder and manual exposure parameters controlled from React Native
    var cameraIdProp: String = "0"
        set(value) {
            if (field != value) {
                field = value
                if (isViewActive) {
                    restartCameraSession()
                }
            }
        }

    var isViewActive: Boolean = true
        set(value) {
            if (field != value) {
                field = value
                if (value) {
                    startCameraWhenReady()
                } else {
                    closeCameraInternal()
                }
            }
        }

    var manualExposure: Boolean = false
    var exposureTimeNs: Long = 16_666_666L // Default ~1/60s
    var manualIso: Boolean = false
    var isoValue: Int = 200
    var manualFocus: Boolean = false
    var focusDistanceDiopters: Float = 0.0f // 0.0f = Optical infinity
    var manualWhiteBalance: Boolean = false
    var wbKelvin: Int = 5500
    var wbTint: Int = 0
    var enableRawDng: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                if (isViewActive && isAttachedToWindow) {
                    restartCameraSession()
                }
            }
        }
    var zoomRatio: Float = 1.0f

    // Latest metered AE values from the sensor so switching from Auto -> Manual
    // or locking one axis (e.g. Manual Shutter + Auto ISO) starts from a well-exposed baseline.
    @Volatile
    private var lastMeteredExposureNs: Long = 20_000_000L

    @Volatile
    private var lastMeteredIso: Int = 200

    @Volatile
    private var lastMeteredFocusDiopters: Float = 0.0f

    @Volatile
    private var lastHistogramTimestampMs: Long = 0L

    @Volatile
    private var lastTelemetryTimestampMs: Long = 0L

    // Pending still capture state (JPEG + optional 16-bit DNG pair)
    private var pendingCaptureCharacteristics: CameraCharacteristics? = null
    private var pendingTotalCaptureResult: TotalCaptureResult? = null
    private var pendingRawImage: Image? = null
    private var isCapturingStill: Boolean = false

    // Astro & Computational multi-frame burst cancellation flag
    @Volatile
    var isAstroBurstRunning: Boolean = false

    @Volatile
    var cancelAstroBurstRequested: Boolean = false

    // Pro Cinema Video Recording state (`MediaRecorder` + dedicated Camera2 record session)
    private var mediaRecorder: MediaRecorder? = null
    private var currentVideoTempFile: File? = null
    private var videoRecordStartMs: Long = 0L
    private var videoResolutionLabel: String = "1920x1080"
    private var videoTargetFps: Int = 30
    private var videoBitrateMbps: Int = 50
    private var videoStabilizationEnabled: Boolean = true

    @Volatile
    var isRecordingVideo: Boolean = false

    @Volatile
    var isVideoPaused: Boolean = false

    init {
        setBackgroundColor(0xFF05070A.toInt())
        textureView.layoutParams = LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        textureView.surfaceTextureListener = this
        addView(textureView)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        activeInstance = this
        startBackgroundThread()
        if (isViewActive && textureView.isAvailable) {
            openCameraInternal(textureView.width, textureView.height)
        }
    }

    override fun onDetachedFromWindow() {
        closeCameraInternal()
        stopBackgroundThread()
        if (activeInstance === this) {
            activeInstance = null
        }
        super.onDetachedFromWindow()
    }

    // React Native's UIManager measures views asynchronously; overriding requestLayout
    // ensures the inner TextureView resizes immediately when surface dimensions change.
    override fun requestLayout() {
        super.requestLayout()
        post {
            measure(
                MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
            )
            layout(left, top, right, bottom)
        }
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (isViewActive) {
            openCameraInternal(width, height)
        }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        configureTextureTransform(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        closeCameraInternal()
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit

    private fun startBackgroundThread() {
        if (cameraThread != null) return
        val thread = HandlerThread("NativeCamera2Engine").also { it.start() }
        cameraThread = thread
        cameraHandler = Handler(thread.looper)
    }

    private fun stopBackgroundThread() {
        cameraThread?.quitSafely()
        try {
            cameraThread?.join(800)
        } catch (_: InterruptedException) {
        }
        cameraThread = null
        cameraHandler = null
    }

    fun startCameraWhenReady() {
        activeInstance = this
        startBackgroundThread()
        if (textureView.isAvailable) {
            openCameraInternal(textureView.width, textureView.height)
        }
    }

    fun restartCameraSession() {
        val handler = cameraHandler ?: return
        handler.post {
            closeCameraOnCurrentThread()
            if (isViewActive && textureView.isAvailable) {
                openCameraOnCurrentThread(textureView.width, textureView.height)
            }
        }
    }

    fun applyManualParametersUpdate() {
        val handler = cameraHandler ?: return
        handler.post {
            updateRepeatingPreviewRequest()
        }
    }

    private fun openCameraInternal(viewWidth: Int, viewHeight: Int) {
        startBackgroundThread()
        val handler = cameraHandler ?: return
        handler.post {
            openCameraOnCurrentThread(viewWidth, viewHeight)
        }
    }

    @SuppressLint("MissingPermission")
    private fun openCameraOnCurrentThread(viewWidth: Int, viewHeight: Int) {
        if (!isViewActive || cameraDevice != null) return
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

        try {
            if (!cameraOpenCloseLock.tryAcquire(2500, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "Timed out waiting for camera lock; forcing recovery.")
                cameraOpenCloseLock.release()
                cameraOpenCloseLock.tryAcquire(1000, TimeUnit.MILLISECONDS)
            }

            // Verify requested cameraId exists; fallback to first available ID if needed
            val targetId = try {
                manager.getCameraCharacteristics(cameraIdProp)
                cameraIdProp
            } catch (_: Throwable) {
                manager.cameraIdList.firstOrNull() ?: "0"
            }

            val chars = manager.getCameraCharacteristics(targetId)
            activeCharacteristics = chars

            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val previewCandidates = map?.getOutputSizes(SurfaceTexture::class.java) ?: emptyArray()
            previewSize = chooseOptimalPreviewSize(previewCandidates, 1920, 1440)

            post {
                configureTextureTransform(viewWidth, viewHeight)
            }

            // 1. Live YUV_420_888 stream for low-overhead real-time RGB/Luma histogram analysis
            val yuvSizes = map?.getOutputSizes(ImageFormat.YUV_420_888) ?: emptyArray()
            val histSize = yuvSizes
                .filter { it.width <= 640 && it.height <= 480 }
                .maxByOrNull { it.width * it.height }
                ?: yuvSizes.minByOrNull { it.width * it.height }
                ?: Size(320, 240)

            yuvReader?.close()
            yuvReader = ImageReader.newInstance(histSize.width, histSize.height, ImageFormat.YUV_420_888, 2).apply {
                setOnImageAvailableListener({ reader ->
                    val image = try {
                        reader.acquireLatestImage()
                    } catch (_: Throwable) {
                        null
                    } ?: return@setOnImageAvailableListener

                    try {
                        val now = System.currentTimeMillis()
                        if (now - lastHistogramTimestampMs >= 180L && !isAstroBurstRunning) {
                            lastHistogramTimestampMs = now
                            computeAndEmitHistogram(image)
                        }
                    } finally {
                        image.close()
                    }
                }, cameraHandler)
            }

            // 2. Full-resolution JPEG ImageReader for Pro Mode & Astro burst frames
            val jpegSizes = map?.getOutputSizes(ImageFormat.JPEG) ?: emptyArray()
            val maxJpegSize = jpegSizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
                ?: Size(1920, 1080)

            jpegReader?.close()
            jpegReader = ImageReader.newInstance(maxJpegSize.width, maxJpegSize.height, ImageFormat.JPEG, 3)

            // 3. Optional 16-bit Bayer RAW_SENSOR ImageReader for Adobe DNG creation
            rawReader?.close()
            rawReader = null
            rawSurfaceConfigured = false
            val supportsRawStream = map?.outputFormats?.contains(ImageFormat.RAW_SENSOR) == true
            if (enableRawDng && supportsRawStream) {
                val rawSizes = map?.getOutputSizes(ImageFormat.RAW_SENSOR) ?: emptyArray()
                val maxRawSize = rawSizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
                if (maxRawSize != null) {
                    rawReader = ImageReader.newInstance(
                        maxRawSize.width,
                        maxRawSize.height,
                        ImageFormat.RAW_SENSOR,
                        2
                    )
                }
            }

            manager.openCamera(targetId, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    cameraOpenCloseLock.release()
                    cameraDevice = device
                    createPreviewSession(allowRawSurface = true)
                }

                override fun onDisconnected(device: CameraDevice) {
                    cameraOpenCloseLock.release()
                    device.close()
                    cameraDevice = null
                }

                override fun onError(device: CameraDevice, error: Int) {
                    cameraOpenCloseLock.release()
                    device.close()
                    cameraDevice = null
                    emitStatusEvent("error", "Camera2 device error ($error) on ID $targetId")
                }
            }, cameraHandler)

        } catch (e: Throwable) {
            cameraOpenCloseLock.release()
            Log.e(TAG, "Failed to open camera $cameraIdProp", e)
            emitStatusEvent("error", "Failed to open camera $cameraIdProp: ${e.message}")
        }
    }

    private fun createPreviewSession(allowRawSurface: Boolean) {
        val device = cameraDevice ?: return
        val texture = textureView.surfaceTexture ?: return

        try {
            texture.setDefaultBufferSize(previewSize.width, previewSize.height)
            val previewSurface = Surface(texture)

            val surfaces = mutableListOf<Surface>(previewSurface)
            yuvReader?.surface?.let { surfaces.add(it) }
            jpegReader?.surface?.let { surfaces.add(it) }
            if (allowRawSurface && rawReader?.surface != null) {
                surfaces.add(rawReader!!.surface)
                rawSurfaceConfigured = true
            } else {
                rawSurfaceConfigured = false
            }

            device.createCaptureSession(
                surfaces,
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (cameraDevice == null) return
                        captureSession = session
                        updateRepeatingPreviewRequest()
                        emitStatusEvent(
                            "ready",
                            "Camera ID $cameraIdProp active (${previewSize.width}x${previewSize.height})" +
                                if (rawSurfaceConfigured) " • 16-bit DNG Ready" else ""
                        )
                    }

                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        // Some HALs reject 4 simultaneous streams (Preview + YUV + JPEG + RAW).
                        // If RAW caused a stream-combination limit failure, retry without RAW
                        // so the viewfinder still works reliably.
                        if (allowRawSurface && rawReader != null) {
                            Log.w(TAG, "4-stream RAW session rejected by HAL; retrying without RAW.")
                            createPreviewSession(allowRawSurface = false)
                        } else {
                            emitStatusEvent("error", "Camera2 session configuration failed.")
                        }
                    }
                },
                cameraHandler
            )
        } catch (e: Throwable) {
            Log.e(TAG, "Error creating capture session", e)
        }
    }

    private fun updateRepeatingPreviewRequest() {
        val device = cameraDevice ?: return
        val session = captureSession ?: return
        val texture = textureView.surfaceTexture ?: return

        try {
            val template = if (isRecordingVideo && mediaRecorder != null) {
                CameraDevice.TEMPLATE_RECORD
            } else {
                CameraDevice.TEMPLATE_PREVIEW
            }
            val builder = device.createCaptureRequest(template)
            val previewSurface = Surface(texture)
            builder.addTarget(previewSurface)
            yuvReader?.surface?.let { builder.addTarget(it) }

            if (isRecordingVideo && mediaRecorder != null) {
                try {
                    builder.addTarget(mediaRecorder!!.surface)
                    builder.set(
                        CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
                        Range(videoTargetFps, videoTargetFps)
                    )
                    if (videoStabilizationEnabled) {
                        builder.set(
                            CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                            CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON
                        )
                    }
                } catch (_: Throwable) {
                }
            }

            applyManualControlsToBuilder(builder, isStillCapture = false)

            session.setRepeatingRequest(
                builder.build(),
                object : CameraCaptureSession.CaptureCallback() {
                    override fun onCaptureCompleted(
                        session: CameraCaptureSession,
                        request: CaptureRequest,
                        result: TotalCaptureResult
                    ) {
                        result.get(CaptureResult.SENSOR_EXPOSURE_TIME)?.let {
                            if (!manualExposure) lastMeteredExposureNs = it
                        }
                        result.get(CaptureResult.SENSOR_SENSITIVITY)?.let {
                            if (!manualIso) lastMeteredIso = it
                        }
                        result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let {
                            if (!manualFocus) lastMeteredFocusDiopters = it
                        }

                        val now = System.currentTimeMillis()
                        if (now - lastTelemetryTimestampMs >= 260L) {
                            lastTelemetryTimestampMs = now
                            emitLiveTelemetry(result)
                        }
                    }
                },
                cameraHandler
            )
        } catch (e: Throwable) {
            Log.w(TAG, "Could not update repeating request: ${e.message}")
        }
    }

    /**
     * Applies our Pro Mode / Astro Mode manual overrides onto a Camera2 CaptureRequest.Builder.
     */
    private fun applyManualControlsToBuilder(
        builder: CaptureRequest.Builder,
        isStillCapture: Boolean
    ) {
        val chars = activeCharacteristics

        // 1. Exposure Time (Shutter Speed) & ISO Sensitivity
        // Camera2 requires CONTROL_AE_MODE_OFF whenever either exposure time or ISO is manual.
        if (manualExposure || manualIso) {
            builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)

            val expRange = chars?.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
            val targetExpNs = if (manualExposure) exposureTimeNs else lastMeteredExposureNs
            val clampedExpNs = if (expRange != null) {
                targetExpNs.coerceIn(expRange.lower, expRange.upper)
            } else {
                targetExpNs
            }
            builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, clampedExpNs)

            val isoRange = chars?.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val targetIso = if (manualIso) isoValue else lastMeteredIso
            val clampedIso = if (isoRange != null) {
                targetIso.coerceIn(isoRange.lower, isoRange.upper)
            } else {
                targetIso
            }
            builder.set(CaptureRequest.SENSOR_SENSITIVITY, clampedIso)
        } else {
            builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
        }

        // 2. Focus Distance (Diopters: 0.0f = true infinity ∞)
        val minFocusDiopters = chars?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0.0f
        if (manualFocus && minFocusDiopters > 0.0f) {
            builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            val clampedFocus = focusDistanceDiopters.coerceIn(0.0f, minFocusDiopters)
            builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, clampedFocus)
        } else {
            val afModes = chars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
            val desiredAf = if (isStillCapture) {
                CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
            } else {
                CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
            }
            if (afModes.contains(desiredAf)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, desiredAf)
            }
        }

        // 3. White Balance (Kelvin + Tint -> RGGB channel gains)
        if (manualWhiteBalance) {
            val awbModes = chars?.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: IntArray(0)
            if (awbModes.contains(CameraMetadata.CONTROL_AWB_MODE_OFF)) {
                builder.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_OFF)
                builder.set(
                    CaptureRequest.COLOR_CORRECTION_MODE,
                    CameraMetadata.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX
                )
                builder.set(
                    CaptureRequest.COLOR_CORRECTION_GAINS,
                    kelvinAndTintToRggbGains(wbKelvin, wbTint)
                )
            }
        } else {
            builder.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
        }

        // 4. Optical Image Stabilization & Noise Reduction quality
        val oisModes = chars?.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION) ?: IntArray(0)
        if (oisModes.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON)) {
            builder.set(
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON
            )
        }

        if (isStillCapture) {
            builder.set(CaptureRequest.JPEG_QUALITY, 98.toByte())
            val sensorOrientation = chars?.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
            builder.set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation)
        }

        // 5. Zoom ratio (Android 11+ CONTROL_ZOOM_RATIO or crop region)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && zoomRatio > 1.0f) {
            val zoomRange = chars?.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            if (zoomRange != null) {
                builder.set(
                    CaptureRequest.CONTROL_ZOOM_RATIO,
                    zoomRatio.coerceIn(zoomRange.lower, zoomRange.upper)
                )
            }
        }
    }

    /**
     * Captures a high-resolution Pro Mode photo (JPEG + optional uncompressed 16-bit Adobe DNG)
     * and writes both directly into Android's public `DCIM/NativeCamera` MediaStore album.
     */
    fun captureProStill(promise: Promise) {
        val handler = cameraHandler
        if (handler == null) {
            promise.reject("CAMERA_NOT_READY", "Camera background thread is not active.")
            return
        }

        handler.post {
            val device = cameraDevice
            val session = captureSession
            val chars = activeCharacteristics
            val jReader = jpegReader

            if (device == null || session == null || chars == null || jReader == null) {
                promise.reject("CAMERA_NOT_READY", "Camera2 session is not initialized yet.")
                return@post
            }

            if (isCapturingStill) {
                promise.reject("CAPTURE_BUSY", "A still capture is already in progress.")
                return@post
            }
            isCapturingStill = true

            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val wantRaw = enableRawDng && rawSurfaceConfigured && rawReader != null

            var savedJpegUri: String? = null
            var savedDngUri: String? = null
            var capturedResult: TotalCaptureResult? = null
            var capturedRawImage: Image? = null
            var jpegDone = false
            var rawDone = !wantRaw

            fun checkAndFinishCapture() {
                if (!jpegDone) return
                if (wantRaw && (capturedRawImage == null || capturedResult == null) && !rawDone) {
                    return
                }

                // If we have both the RAW_SENSOR buffer and the TotalCaptureResult metadata,
                // use Android's DngCreator to write a true 16-bit uncompressed Adobe DNG file.
                if (wantRaw && capturedRawImage != null && capturedResult != null && savedDngUri == null) {
                    try {
                        savedDngUri = saveDngToMediaStore(
                            chars = chars,
                            result = capturedResult!!,
                            rawImage = capturedRawImage!!,
                            displayName = "IMG_${timestamp}_PRO.dng"
                        )
                    } catch (e: Throwable) {
                        Log.e(TAG, "Failed writing DNG file", e)
                    } finally {
                        capturedRawImage?.close()
                        capturedRawImage = null
                        rawDone = true
                    }
                }

                if (jpegDone && rawDone) {
                    isCapturingStill = false
                    updateRepeatingPreviewRequest()

                    val map = Arguments.createMap().apply {
                        putString("jpegUri", savedJpegUri ?: "")
                        putString("dngUri", savedDngUri)
                        putBoolean("savedDng", savedDngUri != null)
                        putString("albumPath", "DCIM/NativeCamera")
                        putString("timestamp", timestamp)
                        val expNs = capturedResult?.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: exposureTimeNs
                        val iso = capturedResult?.get(CaptureResult.SENSOR_SENSITIVITY) ?: isoValue
                        putString("shutterFormatted", formatShutterSpeedNs(expNs))
                        putInt("iso", iso)
                    }
                    promise.resolve(map)
                }
            }

            jReader.setOnImageAvailableListener({ reader ->
                val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    val buffer = image.planes[0].buffer
                    val bytes = ByteArray(buffer.remaining())
                    buffer.get(bytes)
                    savedJpegUri = saveBytesToMediaStore(
                        bytes = bytes,
                        displayName = "IMG_${timestamp}_PRO.jpg",
                        mimeType = "image/jpeg"
                    )
                } catch (e: Throwable) {
                    Log.e(TAG, "Failed saving JPEG to MediaStore", e)
                } finally {
                    image.close()
                    jpegDone = true
                    checkAndFinishCapture()
                }
            }, cameraHandler)

            if (wantRaw && rawReader != null) {
                rawReader!!.setOnImageAvailableListener({ reader ->
                    val rawImg = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    capturedRawImage = rawImg
                    checkAndFinishCapture()
                }, cameraHandler)
            }

            try {
                val captureBuilder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                captureBuilder.addTarget(jReader.surface)
                if (wantRaw && rawReader != null) {
                    captureBuilder.addTarget(rawReader!!.surface)
                }
                textureView.surfaceTexture?.let { captureBuilder.addTarget(Surface(it)) }

                applyManualControlsToBuilder(captureBuilder, isStillCapture = true)

                session.capture(
                    captureBuilder.build(),
                    object : CameraCaptureSession.CaptureCallback() {
                        override fun onCaptureCompleted(
                            session: CameraCaptureSession,
                            request: CaptureRequest,
                            result: TotalCaptureResult
                        ) {
                            capturedResult = result
                            checkAndFinishCapture()
                        }

                        override fun onCaptureFailed(
                            session: CameraCaptureSession,
                            request: CaptureRequest,
                            failure: CaptureFailure
                        ) {
                            capturedRawImage?.close()
                            capturedRawImage = null
                            isCapturingStill = false
                            updateRepeatingPreviewRequest()
                            promise.reject(
                                "CAPTURE_FAILED",
                                "Camera2 still capture failed (reason=${failure.reason})"
                            )
                        }
                    },
                    cameraHandler
                )
            } catch (e: Throwable) {
                isCapturingStill = false
                promise.reject("CAPTURE_EXCEPTION", "Still capture error: ${e.message}", e)
            }
        }
    }

    /**
     * Executes an automated multi-frame long-exposure burst sequence for Pillar C (Astro Mode),
     * locking focus at optical infinity (0.0f diopters), fixing ISO and per-frame shutter time,
     * and feeding each captured frame directly into our native C++ star alignment & sigma-clipped
     * stacking engine (`AstroStackerNative`).
     */
    fun runAstroBurstCapture(
        frameCount: Int,
        frameExposureSec: Double,
        targetIso: Int,
        abortIfMoved: Boolean,
        isDeviceSteadyProvider: () -> Boolean,
        promise: Promise
    ) {
        val handler = cameraHandler
        if (handler == null) {
            promise.reject("ASTRO_NOT_READY", "Camera background thread is not active.")
            return
        }

        handler.post {
            val device = cameraDevice
            val session = captureSession
            val chars = activeCharacteristics
            val jReader = jpegReader

            if (device == null || session == null || chars == null || jReader == null) {
                promise.reject("ASTRO_NOT_READY", "Camera2 session is not ready for Astro Mode.")
                return@post
            }
            if (isAstroBurstRunning) {
                promise.reject("ASTRO_BUSY", "An Astrophotography capture is already running.")
                return@post
            }

            isAstroBurstRunning = true
            cancelAstroBurstRequested = false

            val expRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
            val requestedExpNs = (frameExposureSec * 1_000_000_000.0).roundToLong()
            val clampedExpNs = if (expRange != null) {
                requestedExpNs.coerceIn(expRange.lower, expRange.upper)
            } else {
                requestedExpNs
            }
            val actualPerFrameSec = clampedExpNs.toDouble() / 1_000_000_000.0

            val isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val clampedIso = if (isoRange != null) {
                targetIso.coerceIn(isoRange.lower, isoRange.upper)
            } else {
                targetIso
            }

            val totalFrames = frameCount.coerceIn(3, 30)
            // Standardize stacking dimensions (1600x1200 or 1920x1440 max) so JNI star-registration
            // and 30-frame sigma-clipped buffers run fast without exhausting Android heap memory.
            val stackWidth = 1600
            val stackHeight = 1200

            AstroStackerNative.beginSession(stackWidth, stackHeight, totalFrames)

            val tempDir = File(context.cacheDir, "astro_preview").apply { mkdirs() }
            var firstFrameFile: File? = null
            var progressiveFile: File? = null
            var capturedFrames = 0
            var abortedByMotion = false

            fun finalizeAstroStack() {
                try {
                    if (capturedFrames <= 0) {
                        AstroStackerNative.resetSession()
                        isAstroBurstRunning = false
                        updateRepeatingPreviewRequest()
                        promise.reject("ASTRO_NO_FRAMES", "Astrophotography capture was cancelled before Frame 1 completed.")
                        return
                    }

                    emitAstroProgress(
                        currentFrame = capturedFrames,
                        totalFrames = totalFrames,
                        stage = "STACKING",
                        message = "Applying sigma-clipped star stacking & astronomical tone curve ($capturedFrames frames)...",
                        previewUri = progressiveFile?.let { "file://${it.absolutePath}" },
                        abortedByMotion = abortedByMotion
                    )

                    val finalPixels = IntArray(stackWidth * stackHeight)
                    val stackStatsJson = AstroStackerNative.finalizeStack(finalPixels)
                    val finalBitmap = Bitmap.createBitmap(stackWidth, stackHeight, Bitmap.Config.ARGB_8888)
                    finalBitmap.setPixels(finalPixels, 0, stackWidth, 0, 0, stackWidth, stackHeight)

                    val outStream = ByteArrayOutputStream()
                    finalBitmap.compress(Bitmap.CompressFormat.JPEG, 98, outStream)
                    val finalBytes = outStream.toByteArray()

                    val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                    val savedMediaUri = saveBytesToMediaStore(
                        bytes = finalBytes,
                        displayName = "ASTRO_${timestamp}_${capturedFrames}F.jpg",
                        mimeType = "image/jpeg"
                    )

                    val finalCacheFile = File(tempDir, "astro_final_${timestamp}.jpg")
                    FileOutputStream(finalCacheFile).use { it.write(finalBytes) }

                    AstroStackerNative.resetSession()
                    isAstroBurstRunning = false
                    updateRepeatingPreviewRequest()

                    val response = Arguments.createMap().apply {
                        putString("stackedUri", "file://${finalCacheFile.absolutePath}")
                        putString("mediaStoreUri", savedMediaUri ?: "")
                        putString("singleFrameUri", firstFrameFile?.let { "file://${it.absolutePath}" } ?: "")
                        putInt("framesStacked", capturedFrames)
                        putInt("totalRequestedFrames", totalFrames)
                        putDouble("perFrameExposureSec", (actualPerFrameSec * 100.0).roundToInt() / 100.0)
                        putDouble("totalIntegrationSec", ((actualPerFrameSec * capturedFrames) * 10.0).roundToInt() / 10.0)
                        putInt("iso", clampedIso)
                        putBoolean("abortedEarlyByMotion", abortedByMotion)
                        putString("alignmentReportJson", stackStatsJson)
                        putString("albumPath", "DCIM/NativeCamera")
                    }
                    promise.resolve(response)
                } catch (e: Throwable) {
                    AstroStackerNative.resetSession()
                    isAstroBurstRunning = false
                    updateRepeatingPreviewRequest()
                    promise.reject("ASTRO_STACK_ERROR", "Failed finalizing astro stack: ${e.message}", e)
                }
            }

            fun captureNextAstroFrame(frameIndex: Int) {
                if (cancelAstroBurstRequested) {
                    finalizeAstroStack()
                    return
                }
                if (abortIfMoved && frameIndex > 0 && !isDeviceSteadyProvider()) {
                    abortedByMotion = true
                    finalizeAstroStack()
                    return
                }
                if (frameIndex >= totalFrames) {
                    finalizeAstroStack()
                    return
                }

                emitAstroProgress(
                    currentFrame = frameIndex + 1,
                    totalFrames = totalFrames,
                    stage = "CAPTURING",
                    message = "Exposing Frame ${frameIndex + 1}/$totalFrames (${formatShutterSpeedNs(clampedExpNs)} @ ISO $clampedIso • Focus ∞)",
                    previewUri = progressiveFile?.let { "file://${it.absolutePath}" },
                    abortedByMotion = false
                )

                jReader.setOnImageAvailableListener({ reader ->
                    val img = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    try {
                        val buffer = img.planes[0].buffer
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)

                        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (decoded != null) {
                            val scaled = Bitmap.createScaledBitmap(decoded, stackWidth, stackHeight, true)
                            if (scaled !== decoded) decoded.recycle()

                            // Save Frame 1 as the noisy single-exposure reference for the Before/After viewer
                            if (frameIndex == 0) {
                                val f1 = File(tempDir, "astro_ref_frame1_${System.currentTimeMillis()}.jpg")
                                FileOutputStream(f1).use { out ->
                                    scaled.compress(Bitmap.CompressFormat.JPEG, 92, out)
                                }
                                firstFrameFile = f1
                            }

                            val frameArgb = IntArray(stackWidth * stackHeight)
                            scaled.getPixels(frameArgb, 0, stackWidth, 0, 0, stackWidth, stackHeight)

                            // Register stars against Frame 1 and accumulate into our native buffer
                            val previewArgb = IntArray(stackWidth * stackHeight)
                            val alignInfo = AstroStackerNative.addFrameAndGetPreview(
                                frameArgb,
                                frameIndex,
                                previewArgb
                            )
                            capturedFrames = frameIndex + 1

                            // Write progressive preview frame so the user sees noise drop & stars brighten live
                            val progBitmap = Bitmap.createBitmap(stackWidth, stackHeight, Bitmap.Config.ARGB_8888)
                            progBitmap.setPixels(previewArgb, 0, stackWidth, 0, 0, stackWidth, stackHeight)
                            val pFile = File(tempDir, "astro_prog_${frameIndex + 1}.jpg")
                            FileOutputStream(pFile).use { out ->
                                progBitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
                            }
                            progBitmap.recycle()
                            scaled.recycle()
                            progressiveFile = pFile

                            emitAstroProgress(
                                currentFrame = capturedFrames,
                                totalFrames = totalFrames,
                                stage = "ALIGNED",
                                message = "Aligned Frame $capturedFrames/$totalFrames • $alignInfo",
                                previewUri = "file://${pFile.absolutePath}",
                                abortedByMotion = false
                            )
                        }
                    } catch (e: Throwable) {
                        Log.e(TAG, "Error processing astro burst frame $frameIndex", e)
                    } finally {
                        img.close()
                        captureNextAstroFrame(frameIndex + 1)
                    }
                }, cameraHandler)

                try {
                    val astroBuilder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                    astroBuilder.addTarget(jReader.surface)
                    textureView.surfaceTexture?.let { astroBuilder.addTarget(Surface(it)) }

                    // Lock Focus to Optical Infinity (0.0f diopters), disable AE & AWB drift
                    astroBuilder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
                    astroBuilder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, clampedExpNs)
                    astroBuilder.set(CaptureRequest.SENSOR_SENSITIVITY, clampedIso)

                    val minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0.0f
                    if (minFocus > 0.0f) {
                        astroBuilder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                        astroBuilder.set(CaptureRequest.LENS_FOCUS_DISTANCE, 0.0f)
                    }

                    val awbModes = chars.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: IntArray(0)
                    if (awbModes.contains(CameraMetadata.CONTROL_AWB_MODE_OFF)) {
                        astroBuilder.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_OFF)
                        astroBuilder.set(
                            CaptureRequest.COLOR_CORRECTION_MODE,
                            CameraMetadata.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX
                        )
                        // Neutral night-sky white balance (~4600K) to avoid orange sodium skyglow cast
                        astroBuilder.set(
                            CaptureRequest.COLOR_CORRECTION_GAINS,
                            kelvinAndTintToRggbGains(4600, 0)
                        )
                    }

                    val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
                    astroBuilder.set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation)
                    astroBuilder.set(CaptureRequest.JPEG_QUALITY, 96.toByte())

                    session.capture(astroBuilder.build(), null, cameraHandler)
                } catch (e: Throwable) {
                    Log.e(TAG, "Failed submitting astro burst request", e)
                    finalizeAstroStack()
                }
            }

            captureNextAstroFrame(0)
        }
    }

    /**
     * Computes a 32-bin Luminance + RGB histogram directly from the YUV_420_888 preview planes.
     * Sampling every 6th pixel keeps CPU usage under 1ms per frame while giving an accurate
     * real-time exposure distribution and shadow/highlight clipping alerts.
     */
    private fun computeAndEmitHistogram(image: Image) {
        try {
            val width = image.width
            val height = image.height
            val yPlane = image.planes[0]
            val uPlane = image.planes[1]
            val vPlane = image.planes[2]

            val yBuffer = yPlane.buffer
            val uBuffer = uPlane.buffer
            val vBuffer = vPlane.buffer

            val yRowStride = yPlane.rowStride
            val uvRowStride = uPlane.rowStride
            val uvPixelStride = uPlane.pixelStride

            val lumaBins = IntArray(32)
            val rBins = IntArray(32)
            val gBins = IntArray(32)
            val bBins = IntArray(32)

            var totalSamples = 0
            var clippedHighlights = 0
            var crushedShadows = 0
            var lumaSum = 0L

            val step = 6
            var row = 0
            while (row < height) {
                var col = 0
                val yRowOffset = row * yRowStride
                val uvRowOffset = (row / 2) * uvRowStride
                while (col < width) {
                    val yIndex = yRowOffset + col
                    val uvIndex = uvRowOffset + (col / 2) * uvPixelStride

                    if (yIndex < yBuffer.limit() && uvIndex < uBuffer.limit() && uvIndex < vBuffer.limit()) {
                        val yVal = yBuffer.get(yIndex).toInt() and 0xFF
                        val uVal = (uBuffer.get(uvIndex).toInt() and 0xFF) - 128
                        val vVal = (vBuffer.get(uvIndex).toInt() and 0xFF) - 128

                        // ITU-R BT.601 integer approximation from YUV to RGB
                        val r = (yVal + ((359 * vVal) shr 8)).coerceIn(0, 255)
                        val g = (yVal - ((88 * uVal + 183 * vVal) shr 8)).coerceIn(0, 255)
                        val b = (yVal + ((454 * uVal) shr 8)).coerceIn(0, 255)

                        lumaBins[yVal shr 3]++
                        rBins[r shr 3]++
                        gBins[g shr 3]++
                        bBins[b shr 3]++

                        if (yVal >= 250) clippedHighlights++
                        if (yVal <= 5) crushedShadows++
                        lumaSum += yVal
                        totalSamples++
                    }
                    col += step
                }
                row += step
            }

            if (totalSamples == 0) return

            val maxBin = max(
                1,
                max(
                    lumaBins.maxOrNull() ?: 1,
                    max(rBins.maxOrNull() ?: 1, max(gBins.maxOrNull() ?: 1, bBins.maxOrNull() ?: 1))
                )
            )

            fun normalizeBins(bins: IntArray) = Arguments.createArray().apply {
                for (count in bins) {
                    pushDouble(((count.toDouble() / maxBin.toDouble()) * 100.0).roundToInt() / 100.0)
                }
            }

            val payload = Arguments.createMap().apply {
                putArray("luma", normalizeBins(lumaBins))
                putArray("red", normalizeBins(rBins))
                putArray("green", normalizeBins(gBins))
                putArray("blue", normalizeBins(bBins))
                putDouble("meanLuminance", ((lumaSum.toDouble() / totalSamples) * 10.0).roundToInt() / 10.0)
                putDouble("highlightClipPct", ((clippedHighlights * 1000.0 / totalSamples).roundToInt() / 10.0))
                putDouble("shadowClipPct", ((crushedShadows * 1000.0 / totalSamples).roundToInt() / 10.0))
            }

            val reactContext = context as? ReactContext ?: return
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onCameraHistogram", payload)
        } catch (_: Throwable) {
        }
    }

    private fun emitLiveTelemetry(result: TotalCaptureResult) {
        val reactContext = context as? ReactContext ?: return
        val expNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: exposureTimeNs
        val iso = result.get(CaptureResult.SENSOR_SENSITIVITY) ?: isoValue
        val focusD = result.get(CaptureResult.LENS_FOCUS_DISTANCE) ?: focusDistanceDiopters
        val aperture = result.get(CaptureResult.LENS_APERTURE) ?: 1.8f

        val map = Arguments.createMap().apply {
            putDouble("exposureTimeNs", expNs.toDouble())
            putString("shutterFormatted", formatShutterSpeedNs(expNs))
            putInt("iso", iso)
            putDouble("focusDiopters", ((focusD * 100.0f).roundToInt() / 100.0))
            putDouble("aperture", ((aperture * 100.0f).roundToInt() / 100.0))
            putBoolean("rawReady", rawSurfaceConfigured)
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onCameraTelemetry", map)
    }

    private fun emitStatusEvent(status: String, message: String) {
        val reactContext = context as? ReactContext ?: return
        val map = Arguments.createMap().apply {
            putString("status", status)
            putString("message", message)
            putString("cameraId", cameraIdProp)
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onCameraStatus", map)
    }

    private fun emitAstroProgress(
        currentFrame: Int,
        totalFrames: Int,
        stage: String,
        message: String,
        previewUri: String?,
        abortedByMotion: Boolean
    ) {
        val reactContext = context as? ReactContext ?: return
        val map = Arguments.createMap().apply {
            putInt("currentFrame", currentFrame)
            putInt("totalFrames", totalFrames)
            putString("stage", stage)
            putString("message", message)
            putString("previewUri", previewUri)
            putBoolean("abortedByMotion", abortedByMotion)
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onAstroProgress", map)
    }

    private fun saveBytesToMediaStore(bytes: ByteArray, displayName: String, mimeType: String): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DCIM}/NativeCamera")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }

        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        resolver.openOutputStream(uri)?.use { out ->
            out.write(bytes)
            out.flush()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val doneValues = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            resolver.update(uri, doneValues, null, null)
        }
        return uri.toString()
    }

    private fun saveDngToMediaStore(
        chars: CameraCharacteristics,
        result: TotalCaptureResult,
        rawImage: Image,
        displayName: String
    ): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, "image/x-adobe-dng")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DCIM}/NativeCamera")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }

        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        resolver.openOutputStream(uri)?.use { out ->
            DngCreator(chars, result).use { dngCreator ->
                dngCreator.writeImage(out, rawImage)
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val doneValues = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            resolver.update(uri, doneValues, null, null)
        }
        return uri.toString()
    }

    /**
     * Converts a correlated color temperature in Kelvin (2000K..10000K) and green/magenta tint
     * (-50..+50) into an RGGB Bayer channel gain vector for manual white balance.
     */
    private fun kelvinAndTintToRggbGains(kelvin: Int, tint: Int): RggbChannelVector {
        val temp = (kelvin.coerceIn(2000, 10000) / 100.0)
        val r: Double
        val g: Double
        val b: Double

        if (temp <= 66.0) {
            r = 255.0
            g = (99.4708025861 * ln(temp) - 161.1195681661).coerceIn(1.0, 255.0)
            b = if (temp <= 19.0) {
                0.0
            } else {
                (138.5177312231 * ln(temp - 10.0) - 305.0447927307).coerceIn(1.0, 255.0)
            }
        } else {
            r = (329.698727446 * Math.pow(temp - 60.0, -0.1332047592)).coerceIn(1.0, 255.0)
            g = (288.1221695283 * Math.pow(temp - 60.0, -0.0755148492)).coerceIn(1.0, 255.0)
            b = 255.0
        }

        // Inverse of the illuminant RGB gives the channel multipliers needed to neutralize it
        val baseR = (255.0 / r).toFloat()
        val baseG = (255.0 / g).toFloat()
        val baseB = (255.0 / b).toFloat()

        val tintFactor = 1.0f + (tint.coerceIn(-50, 50) / 200.0f)
        val rGain = (baseR / baseG).coerceIn(0.8f, 3.8f)
        val bGain = (baseB / baseG).coerceIn(0.8f, 3.8f)
        val gGain = (1.0f * tintFactor).coerceIn(0.8f, 2.5f)

        return RggbChannelVector(rGain, gGain, gGain, bGain)
    }

    private fun chooseOptimalPreviewSize(choices: Array<Size>, maxW: Int, maxH: Int): Size {
        if (choices.isEmpty()) return Size(1920, 1080)
        val fourThree = choices.filter {
            it.width <= maxW && it.height <= maxH && abs(it.width.toDouble() / it.height - 4.0 / 3.0) < 0.08
        }.maxByOrNull { it.width * it.height }
        if (fourThree != null) return fourThree

        return choices.filter { it.width <= maxW && it.height <= maxH }
            .maxByOrNull { it.width * it.height }
            ?: choices.first()
    }

    private fun configureTextureTransform(viewWidth: Int, viewHeight: Int) {
        if (viewWidth <= 0 || viewHeight <= 0) return
        val matrix = Matrix()
        val viewRect = RectF(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
        val bufferRect = RectF(0f, 0f, previewSize.height.toFloat(), previewSize.width.toFloat())
        val centerX = viewRect.centerX()
        val centerY = viewRect.centerY()

        // Scale center-crop so the preview fills the viewfinder without stretching stars or circles
        bufferRect.offset(centerX - bufferRect.centerX(), centerY - bufferRect.centerY())
        matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL)
        val scale = max(
            viewHeight.toFloat() / previewSize.width.toFloat(),
            viewWidth.toFloat() / previewSize.height.toFloat()
        )
        matrix.postScale(scale, scale, centerX, centerY)
        textureView.setTransform(matrix)
    }

    /**
     * Starts a high-bitrate Camera2 `TEMPLATE_RECORD` + `MediaRecorder` cinema video session
     * while preserving real-time manual control over shutter speed (180-degree shutter rule),
     * ISO gain, manual rack-focus in diopters, and Kelvin white balance.
     */
    fun startVideoRecording(
        resolutionPreset: String,
        fps: Int,
        bitrateMbps: Int,
        enableAudio: Boolean,
        enableStabilization: Boolean,
        promise: Promise
    ) {
        val handler = cameraHandler
        if (handler == null) {
            promise.reject("VIDEO_NOT_READY", "Camera thread is not running.")
            return
        }

        handler.post {
            val device = cameraDevice
            val chars = activeCharacteristics
            val texture = textureView.surfaceTexture
            if (device == null || chars == null || texture == null) {
                promise.reject("VIDEO_NOT_READY", "Camera2 device is not open.")
                return@post
            }
            if (isRecordingVideo) {
                promise.reject("VIDEO_BUSY", "Video recording is already active.")
                return@post
            }

            try {
                try {
                    captureSession?.stopRepeating()
                    captureSession?.close()
                } catch (_: Throwable) {
                }
                captureSession = null

                val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val videoSizes = map?.getOutputSizes(MediaRecorder::class.java) ?: emptyArray()
                val desiredWidth = when (resolutionPreset.uppercase(Locale.US)) {
                    "4K", "UHD", "2160P" -> 3840
                    "720P", "HD" -> 1280
                    else -> 1920
                }
                val desiredHeight = when (resolutionPreset.uppercase(Locale.US)) {
                    "4K", "UHD", "2160P" -> 2160
                    "720P", "HD" -> 720
                    else -> 1080
                }

                val chosenVideoSize = videoSizes.firstOrNull {
                    it.width == desiredWidth && it.height == desiredHeight
                } ?: videoSizes.filter { it.width <= desiredWidth && it.height <= desiredHeight }
                    .maxByOrNull { it.width.toLong() * it.height.toLong() }
                    ?: videoSizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
                    ?: Size(1920, 1080)

                videoResolutionLabel = "${chosenVideoSize.width}x${chosenVideoSize.height}"
                videoTargetFps = fps.coerceIn(24, 60)
                videoBitrateMbps = bitrateMbps.coerceIn(8, 120)
                videoStabilizationEnabled = enableStabilization

                val outDir = File(context.cacheDir, "cinema_recordings").apply { mkdirs() }
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                val tempVideoFile = File(outDir, "VID_${timestamp}.mp4")
                currentVideoTempFile = tempVideoFile

                val hasAudioPerm = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                val recordWithAudio = enableAudio && hasAudioPerm

                @Suppress("DEPRECATION")
                val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaRecorder(context)
                } else {
                    MediaRecorder()
                }

                if (recordWithAudio) {
                    recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
                }
                recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                recorder.setOutputFile(tempVideoFile.absolutePath)
                recorder.setVideoEncodingBitRate(videoBitrateMbps * 1_000_000)
                recorder.setVideoFrameRate(videoTargetFps)
                recorder.setVideoSize(chosenVideoSize.width, chosenVideoSize.height)
                recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                if (recordWithAudio) {
                    recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    recorder.setAudioEncodingBitRate(192_000)
                    recorder.setAudioSamplingRate(48_000)
                }

                val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
                recorder.setOrientationHint(sensorOrientation)
                recorder.prepare()

                mediaRecorder = recorder
                val recorderSurface = recorder.surface

                texture.setDefaultBufferSize(previewSize.width, previewSize.height)
                val previewSurface = Surface(texture)

                val surfaces = mutableListOf<Surface>(previewSurface, recorderSurface)
                yuvReader?.surface?.let { surfaces.add(it) }

                device.createCaptureSession(
                    surfaces,
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            captureSession = session
                            isRecordingVideo = true
                            isVideoPaused = false
                            updateRepeatingPreviewRequest()
                            try {
                                recorder.start()
                                videoRecordStartMs = System.currentTimeMillis()
                                val resMap = Arguments.createMap().apply {
                                    putString("resolution", videoResolutionLabel)
                                    putInt("fps", videoTargetFps)
                                    putInt("bitrateMbps", videoBitrateMbps)
                                    putBoolean("audioEnabled", recordWithAudio)
                                }
                                promise.resolve(resMap)
                            } catch (startErr: Throwable) {
                                isRecordingVideo = false
                                releaseMediaRecorder()
                                createPreviewSession(allowRawSurface = true)
                                promise.reject(
                                    "VIDEO_START_ERROR",
                                    "Failed starting MediaRecorder: ${startErr.message}",
                                    startErr
                                )
                            }
                        }

                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            isRecordingVideo = false
                            releaseMediaRecorder()
                            createPreviewSession(allowRawSurface = true)
                            promise.reject(
                                "VIDEO_SESSION_FAILED",
                                "Camera2 rejected video recording stream configuration ($videoResolutionLabel @ ${videoTargetFps}fps)."
                            )
                        }
                    },
                    cameraHandler
                )
            } catch (e: Throwable) {
                isRecordingVideo = false
                releaseMediaRecorder()
                createPreviewSession(allowRawSurface = true)
                promise.reject("VIDEO_SETUP_ERROR", "Could not initialize video recorder: ${e.message}", e)
            }
        }
    }

    fun pauseVideoRecording(promise: Promise) {
        val handler = cameraHandler ?: run {
            promise.resolve(false)
            return
        }
        handler.post {
            try {
                if (isRecordingVideo && !isVideoPaused && mediaRecorder != null) {
                    mediaRecorder?.pause()
                    isVideoPaused = true
                    promise.resolve(true)
                } else {
                    promise.resolve(false)
                }
            } catch (e: Throwable) {
                promise.reject("VIDEO_PAUSE_ERROR", "Could not pause recording: ${e.message}", e)
            }
        }
    }

    fun resumeVideoRecording(promise: Promise) {
        val handler = cameraHandler ?: run {
            promise.resolve(false)
            return
        }
        handler.post {
            try {
                if (isRecordingVideo && isVideoPaused && mediaRecorder != null) {
                    mediaRecorder?.resume()
                    isVideoPaused = false
                    promise.resolve(true)
                } else {
                    promise.resolve(false)
                }
            } catch (e: Throwable) {
                promise.reject("VIDEO_RESUME_ERROR", "Could not resume recording: ${e.message}", e)
            }
        }
    }

    fun stopVideoRecording(promise: Promise) {
        val handler = cameraHandler
        if (handler == null) {
            promise.reject("VIDEO_NOT_READY", "Camera thread is not active.")
            return
        }

        handler.post {
            if (!isRecordingVideo || mediaRecorder == null) {
                promise.reject("VIDEO_NOT_RECORDING", "No active video recording to stop.")
                return@post
            }

            val durationSec = ((System.currentTimeMillis() - videoRecordStartMs).coerceAtLeast(100L) / 100.0).roundToInt() / 10.0
            val tempFile = currentVideoTempFile

            try {
                try {
                    captureSession?.stopRepeating()
                    captureSession?.abortCaptures()
                } catch (_: Throwable) {
                }
                mediaRecorder?.stop()
            } catch (stopErr: Throwable) {
                Log.w(TAG, "MediaRecorder stop warning: ${stopErr.message}")
            } finally {
                isRecordingVideo = false
                isVideoPaused = false
                releaseMediaRecorder()
            }

            var savedUri: String? = null
            var fileSizeMb = 0.0
            if (tempFile != null && tempFile.exists() && tempFile.length() > 0L) {
                fileSizeMb = ((tempFile.length().toDouble() / (1024.0 * 1024.0)) * 100.0).roundToInt() / 100.0
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                savedUri = saveVideoFileToMediaStore(
                    sourceFile = tempFile,
                    displayName = "CINEMA_${timestamp}_${videoResolutionLabel}.mp4"
                )
            }

            // Re-establish standard still/preview session
            createPreviewSession(allowRawSurface = true)

            val result = Arguments.createMap().apply {
                putString("videoUri", savedUri ?: (tempFile?.let { "file://${it.absolutePath}" } ?: ""))
                putString("resolution", videoResolutionLabel)
                putInt("fps", videoTargetFps)
                putInt("bitrateMbps", videoBitrateMbps)
                putDouble("durationSec", durationSec)
                putDouble("fileSizeMb", fileSizeMb)
                putString("albumPath", "DCIM/NativeCamera")
            }
            promise.resolve(result)
        }
    }

    private fun releaseMediaRecorder() {
        try {
            mediaRecorder?.reset()
        } catch (_: Throwable) {
        }
        try {
            mediaRecorder?.release()
        } catch (_: Throwable) {
        }
        mediaRecorder = null
    }

    private fun saveVideoFileToMediaStore(sourceFile: File, displayName: String): String? {
        return try {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
                put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DCIM}/NativeCamera")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }

            val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            resolver.openOutputStream(uri)?.use { out ->
                FileInputStream(sourceFile).use { input ->
                    input.copyTo(out, bufferSize = 64 * 1024)
                }
                out.flush()
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val doneValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(uri, doneValues, null, null)
            }
            uri.toString()
        } catch (e: Throwable) {
            Log.e(TAG, "Failed saving MP4 video to MediaStore", e)
            null
        }
    }

    /**
     * Executes multi-frame computational photography bursts:
     * - modeCode = 1 (HDR+ Exposure Bracketing): Sweeps exposure time across [-2 EV .. +2 EV]
     *   around the metered/selected base shutter speed and fuses via Mertens Exposure Fusion.
     * - modeCode = 2 (Light Trails / Star Trails): Captures continuous long-exposure frames and
     *   fuses moving highlights with background noise suppression.
     * - modeCode = 3 (Night Super-Res / Multi-Frame Denoise): Captures handheld burst, aligns
     *   via C++17 RANSAC keypoints, and applies trimmed-mean + unsharp mask.
     * - modeCode = 4 (Macro Focus Bracketing): Sweeps lens voice-coil motor in diopters from
     *   closest macro focus toward infinity and fuses the sharpest focus planes.
     */
    fun runComputationalBurstCapture(
        modeCode: Int,
        frameCount: Int,
        baseExposureSec: Double,
        targetIso: Int,
        evStep: Double,
        promise: Promise
    ) {
        val handler = cameraHandler
        if (handler == null) {
            promise.reject("MODE_NOT_READY", "Camera background thread is not active.")
            return
        }

        handler.post {
            val device = cameraDevice
            val session = captureSession
            val chars = activeCharacteristics
            val jReader = jpegReader

            if (device == null || session == null || chars == null || jReader == null) {
                promise.reject("MODE_NOT_READY", "Camera2 session is not ready.")
                return@post
            }
            if (isAstroBurstRunning || isRecordingVideo) {
                promise.reject("MODE_BUSY", "Camera is already busy with another capture.")
                return@post
            }

            isAstroBurstRunning = true
            cancelAstroBurstRequested = false

            val totalFrames = frameCount.coerceIn(3, 25)
            val stackWidth = 1600
            val stackHeight = 1200

            AstroStackerNative.beginSession(stackWidth, stackHeight, totalFrames)

            val expRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
            val baseExpNs = if (baseExposureSec > 0.0) {
                (baseExposureSec * 1_000_000_000.0).roundToLong()
            } else {
                lastMeteredExposureNs
            }
            val isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val baseIso = if (targetIso > 0) targetIso else lastMeteredIso
            val clampedIso = if (isoRange != null) {
                baseIso.coerceIn(isoRange.lower, isoRange.upper)
            } else {
                baseIso
            }

            val minFocusDiopters = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 10.0f

            val tempDir = File(context.cacheDir, "comp_modes").apply { mkdirs() }
            var firstFrameFile: File? = null
            var progressiveFile: File? = null
            var capturedFrames = 0
            var totalIntegrationNs = 0L

            val modePrefix = when (modeCode) {
                1 -> "HDR_FUSION"
                2 -> "LIGHT_TRAILS"
                3 -> "SUPER_RES"
                4 -> "FOCUS_STACK"
                else -> "COMP_STACK"
            }

            fun finalizeModeOutput() {
                try {
                    if (capturedFrames <= 0) {
                        AstroStackerNative.resetSession()
                        isAstroBurstRunning = false
                        updateRepeatingPreviewRequest()
                        promise.reject("MODE_CANCELLED", "Capture cancelled before Frame 1 finished.")
                        return
                    }

                    emitAstroProgress(
                        currentFrame = capturedFrames,
                        totalFrames = totalFrames,
                        stage = "STACKING",
                        message = "Running C++17 $modePrefix fusion across $capturedFrames frames...",
                        previewUri = progressiveFile?.let { "file://${it.absolutePath}" },
                        abortedByMotion = false
                    )

                    val finalPixels = IntArray(stackWidth * stackHeight)
                    val statsJson = AstroStackerNative.finalizeComputationalMode(modeCode, finalPixels)
                    val finalBitmap = Bitmap.createBitmap(stackWidth, stackHeight, Bitmap.Config.ARGB_8888)
                    finalBitmap.setPixels(finalPixels, 0, stackWidth, 0, 0, stackWidth, stackHeight)

                    val outStream = ByteArrayOutputStream()
                    finalBitmap.compress(Bitmap.CompressFormat.JPEG, 98, outStream)
                    val finalBytes = outStream.toByteArray()

                    val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                    val savedMediaUri = saveBytesToMediaStore(
                        bytes = finalBytes,
                        displayName = "${modePrefix}_${timestamp}_${capturedFrames}F.jpg",
                        mimeType = "image/jpeg"
                    )

                    val finalCacheFile = File(tempDir, "${modePrefix.lowercase(Locale.US)}_${timestamp}.jpg")
                    FileOutputStream(finalCacheFile).use { it.write(finalBytes) }

                    AstroStackerNative.resetSession()
                    isAstroBurstRunning = false
                    updateRepeatingPreviewRequest()

                    val totalSec = ((totalIntegrationNs.toDouble() / 1_000_000_000.0) * 100.0).roundToInt() / 100.0
                    val response = Arguments.createMap().apply {
                        putString("stackedUri", "file://${finalCacheFile.absolutePath}")
                        putString("mediaStoreUri", savedMediaUri ?: "")
                        putString("singleFrameUri", firstFrameFile?.let { "file://${it.absolutePath}" } ?: "")
                        putInt("framesStacked", capturedFrames)
                        putInt("totalRequestedFrames", totalFrames)
                        putDouble("perFrameExposureSec", (baseExpNs.toDouble() / 1_000_000_000.0 * 100.0).roundToInt() / 100.0)
                        putDouble("totalIntegrationSec", totalSec)
                        putInt("iso", clampedIso)
                        putBoolean("abortedEarlyByMotion", false)
                        putString("alignmentReportJson", statsJson)
                        putString("albumPath", "DCIM/NativeCamera")
                    }
                    promise.resolve(response)
                } catch (e: Throwable) {
                    AstroStackerNative.resetSession()
                    isAstroBurstRunning = false
                    updateRepeatingPreviewRequest()
                    promise.reject("MODE_STACK_ERROR", "Computational mode failed: ${e.message}", e)
                }
            }

            fun captureNextModeFrame(frameIndex: Int) {
                if (cancelAstroBurstRequested || frameIndex >= totalFrames) {
                    finalizeModeOutput()
                    return
                }

                // Compute per-frame exposure or focus bracket target
                val midIdx = (totalFrames - 1) / 2.0
                val evOffset = if (modeCode == 1) {
                    (frameIndex - midIdx) * evStep.coerceIn(0.5, 2.0)
                } else {
                    0.0
                }
                val frameExpRawNs = (baseExpNs.toDouble() * 2.0.pow(evOffset)).roundToLong()
                val frameExpNs = if (expRange != null) {
                    frameExpRawNs.coerceIn(expRange.lower, expRange.upper)
                } else {
                    frameExpRawNs.coerceAtLeast(100_000L)
                }

                val frameFocusDiopters = if (modeCode == 4 && minFocusDiopters > 0.1f) {
                    // Sweep from close macro (85% of minFocusDistance) down to 0.0f (infinity)
                    val ratio = 1.0f - (frameIndex.toFloat() / max(1, totalFrames - 1).toFloat())
                    (minFocusDiopters * 0.85f * ratio).coerceIn(0.0f, minFocusDiopters)
                } else {
                    focusDistanceDiopters
                }

                val frameDesc = when (modeCode) {
                    1 -> "EV ${if (evOffset >= 0) "+" else ""}${(evOffset * 10.0).roundToInt() / 10.0} (${formatShutterSpeedNs(frameExpNs)})"
                    4 -> "Focus ${(frameFocusDiopters * 10.0f).roundToInt() / 10.0} D"
                    else -> "${formatShutterSpeedNs(frameExpNs)} @ ISO $clampedIso"
                }

                emitAstroProgress(
                    currentFrame = frameIndex + 1,
                    totalFrames = totalFrames,
                    stage = "CAPTURING",
                    message = "$modePrefix Frame ${frameIndex + 1}/$totalFrames • $frameDesc",
                    previewUri = progressiveFile?.let { "file://${it.absolutePath}" },
                    abortedByMotion = false
                )

                jReader.setOnImageAvailableListener({ reader ->
                    val img = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    try {
                        val buffer = img.planes[0].buffer
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)

                        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (decoded != null) {
                            val scaled = Bitmap.createScaledBitmap(decoded, stackWidth, stackHeight, true)
                            if (scaled !== decoded) decoded.recycle()

                            if (frameIndex == 0) {
                                val f1 = File(tempDir, "comp_ref_${System.currentTimeMillis()}.jpg")
                                FileOutputStream(f1).use { out ->
                                    scaled.compress(Bitmap.CompressFormat.JPEG, 92, out)
                                }
                                firstFrameFile = f1
                            }

                            val frameArgb = IntArray(stackWidth * stackHeight)
                            scaled.getPixels(frameArgb, 0, stackWidth, 0, 0, stackWidth, stackHeight)

                            val previewArgb = IntArray(stackWidth * stackHeight)
                            val infoText = if (modeCode == 3) {
                                AstroStackerNative.addFrameAndGetPreview(frameArgb, frameIndex, previewArgb)
                            } else {
                                AstroStackerNative.addUnalignedFrameAndGetPreview(
                                    frameArgb,
                                    frameIndex,
                                    modeCode,
                                    previewArgb
                                )
                            }

                            capturedFrames = frameIndex + 1
                            totalIntegrationNs += frameExpNs

                            val progBitmap = Bitmap.createBitmap(stackWidth, stackHeight, Bitmap.Config.ARGB_8888)
                            progBitmap.setPixels(previewArgb, 0, stackWidth, 0, 0, stackWidth, stackHeight)
                            val pFile = File(tempDir, "comp_prog_${frameIndex + 1}.jpg")
                            FileOutputStream(pFile).use { out ->
                                progBitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
                            }
                            progBitmap.recycle()
                            scaled.recycle()
                            progressiveFile = pFile

                            emitAstroProgress(
                                currentFrame = capturedFrames,
                                totalFrames = totalFrames,
                                stage = "ALIGNED",
                                message = "$infoText • $frameDesc",
                                previewUri = "file://${pFile.absolutePath}",
                                abortedByMotion = false
                            )
                        }
                    } catch (e: Throwable) {
                        Log.e(TAG, "Error processing computational frame $frameIndex", e)
                    } finally {
                        img.close()
                        captureNextModeFrame(frameIndex + 1)
                    }
                }, cameraHandler)

                try {
                    val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                    builder.addTarget(jReader.surface)
                    textureView.surfaceTexture?.let { builder.addTarget(Surface(it)) }

                    builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
                    builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, frameExpNs)
                    builder.set(CaptureRequest.SENSOR_SENSITIVITY, clampedIso)

                    if (modeCode == 4 && minFocusDiopters > 0.0f) {
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                        builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, frameFocusDiopters)
                    } else if (manualFocus && minFocusDiopters > 0.0f) {
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                        builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, focusDistanceDiopters)
                    }

                    val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
                    builder.set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation)
                    builder.set(CaptureRequest.JPEG_QUALITY, 96.toByte())

                    session.capture(builder.build(), null, cameraHandler)
                } catch (e: Throwable) {
                    Log.e(TAG, "Error submitting computational frame request", e)
                    finalizeModeOutput()
                }
            }

            captureNextModeFrame(0)
        }
    }

    private fun closeCameraInternal() {
        val handler = cameraHandler
        if (handler != null) {
            handler.post {
                closeCameraOnCurrentThread()
            }
        } else {
            closeCameraOnCurrentThread()
        }
    }

    private fun closeCameraOnCurrentThread() {
        try {
            cameraOpenCloseLock.tryAcquire(1500, TimeUnit.MILLISECONDS)
            try {
                captureSession?.stopRepeating()
            } catch (_: Throwable) {
            }
            try {
                captureSession?.close()
            } catch (_: Throwable) {
            }
            captureSession = null

            try {
                cameraDevice?.close()
            } catch (_: Throwable) {
            }
            cameraDevice = null

            yuvReader?.close()
            yuvReader = null
            jpegReader?.close()
            jpegReader = null
            rawReader?.close()
            rawReader = null
            rawSurfaceConfigured = false
        } finally {
            if (cameraOpenCloseLock.availablePermits() == 0) {
                cameraOpenCloseLock.release()
            }
        }
    }

    private fun formatShutterSpeedNs(exposureNs: Long): String {
        if (exposureNs <= 0L) return "0s"
        val seconds = exposureNs.toDouble() / 1_000_000_000.0
        return if (seconds >= 0.4) {
            val rounded = (seconds * 10.0).roundToInt() / 10.0
            "${rounded}s"
        } else {
            val denominator = (1.0 / seconds).roundToLong().coerceAtLeast(1L)
            "1/${denominator}s"
        }
    }
}
