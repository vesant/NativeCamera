package com.vesant.nativecamera

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Coordinates still/RAW capture commands, multi-frame Astro burst sessions, and high-frequency
 * inertial motion telemetry (`TYPE_GYROSCOPE` + `TYPE_ACCELEROMETER` at `SENSOR_DELAY_GAME`)
 * for both the Pro Mode digital spirit level and the Astro Mode 2.5-second tripod stability detector.
 */
class CameraEngineModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), SensorEventListener, LifecycleEventListener {

    private val sensorManager: SensorManager? =
        reactContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val accelerometer: Sensor? =
        sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyroscope: Sensor? =
        sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

    private var sensorsListening: Boolean = false

    // Low-pass filtered gravity vector for smooth spirit-level roll/pitch readout
    private var gravX: Float = 0f
    private var gravY: Float = 9.81f
    private var gravZ: Float = 0f
    private var linearJitterMps2: Float = 0f
    private var gyroMagnitudeRadSec: Float = 0f

    // Tripod stability state machine: device must stay below stillness thresholds
    // continuously for 2,500 milliseconds before unlocking tripod astrophotography.
    private var steadySinceTimestampMs: Long = 0L

    @Volatile
    private var isTripodSteady: Boolean = false
    private var lastMotionEmitMs: Long = 0L

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = "CameraEngineModule"

    @ReactMethod
    fun startMotionSensors(promise: Promise) {
        try {
            if (!sensorsListening && sensorManager != null) {
                accelerometer?.let {
                    sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
                }
                gyroscope?.let {
                    sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
                }
                sensorsListening = true
                steadySinceTimestampMs = System.currentTimeMillis()
            }
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("SENSOR_ERROR", "Failed starting motion sensors: ${e.message}", e)
        }
    }

    @ReactMethod
    fun stopMotionSensors(promise: Promise) {
        try {
            if (sensorsListening && sensorManager != null) {
                sensorManager.unregisterListener(this)
                sensorsListening = false
            }
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("SENSOR_ERROR", "Failed stopping motion sensors: ${e.message}", e)
        }
    }

    @ReactMethod
    fun captureProPhoto(promise: Promise) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.reject("NO_ACTIVE_VIEW", "CameraEngineView is not mounted.")
            return
        }
        view.captureProStill(promise)
    }

    @ReactMethod
    fun startAstroCapture(
        frameCount: Int,
        frameExposureSec: Double,
        iso: Int,
        abortIfMoved: Boolean,
        promise: Promise
    ) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.reject("NO_ACTIVE_VIEW", "CameraEngineView is not mounted.")
            return
        }
        view.runAstroBurstCapture(
            frameCount = frameCount,
            frameExposureSec = frameExposureSec,
            targetIso = iso,
            abortIfMoved = abortIfMoved,
            isDeviceSteadyProvider = { isTripodSteady },
            promise = promise
        )
    }

    @ReactMethod
    fun cancelAstroCapture(promise: Promise) {
        val view = CameraEngineView.activeInstance
        if (view != null) {
            view.cancelAstroBurstRequested = true
            promise.resolve(true)
        } else {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun startVideoRecording(
        resolutionPreset: String,
        fps: Int,
        bitrateMbps: Int,
        enableAudio: Boolean,
        enableStabilization: Boolean,
        promise: Promise
    ) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.reject("NO_ACTIVE_VIEW", "CameraEngineView is not mounted.")
            return
        }
        view.startVideoRecording(
            resolutionPreset = resolutionPreset,
            fps = fps,
            bitrateMbps = bitrateMbps,
            enableAudio = enableAudio,
            enableStabilization = enableStabilization,
            promise = promise
        )
    }

    @ReactMethod
    fun pauseVideoRecording(promise: Promise) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.resolve(false)
            return
        }
        view.pauseVideoRecording(promise)
    }

    @ReactMethod
    fun resumeVideoRecording(promise: Promise) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.resolve(false)
            return
        }
        view.resumeVideoRecording(promise)
    }

    @ReactMethod
    fun stopVideoRecording(promise: Promise) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.reject("NO_ACTIVE_VIEW", "CameraEngineView is not mounted.")
            return
        }
        view.stopVideoRecording(promise)
    }

    @ReactMethod
    fun startComputationalCapture(
        modeCode: Int,
        frameCount: Int,
        baseExposureSec: Double,
        iso: Int,
        evStep: Double,
        promise: Promise
    ) {
        val view = CameraEngineView.activeInstance
        if (view == null) {
            promise.reject("NO_ACTIVE_VIEW", "CameraEngineView is not mounted.")
            return
        }
        view.runComputationalBurstCapture(
            modeCode = modeCode,
            frameCount = frameCount,
            baseExposureSec = baseExposureSec,
            targetIso = iso,
            evStep = evStep,
            promise = promise
        )
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native NativeEventEmitter compatibility
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native NativeEventEmitter compatibility
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null) return
        val now = System.currentTimeMillis()

        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val ax = event.values[0]
                val ay = event.values[1]
                val az = event.values[2]

                // Exponential moving average to isolate gravity from handheld micro-tremors
                val alpha = 0.85f
                gravX = alpha * gravX + (1f - alpha) * ax
                gravY = alpha * gravY + (1f - alpha) * ay
                gravZ = alpha * gravZ + (1f - alpha) * az

                val linX = ax - gravX
                val linY = ay - gravY
                val linZ = az - gravZ
                val instantJitter = sqrt(linX * linX + linY * linY + linZ * linZ)
                linearJitterMps2 = 0.7f * linearJitterMps2 + 0.3f * instantJitter
            }

            Sensor.TYPE_GYROSCOPE -> {
                val gx = event.values[0]
                val gy = event.values[1]
                val gz = event.values[2]
                val instantOmega = sqrt(gx * gx + gy * gy + gz * gz)
                gyroMagnitudeRadSec = 0.7f * gyroMagnitudeRadSec + 0.3f * instantOmega
            }
        }

        // Strict tripod / stillness thresholds:
        // Angular velocity < 0.042 rad/s (~2.4 deg/s) and linear vibration < 0.24 m/s^2
        val isCurrentlyStill = (gyroMagnitudeRadSec < 0.042f) && (linearJitterMps2 < 0.24f)
        if (!isCurrentlyStill) {
            steadySinceTimestampMs = now
            isTripodSteady = false
        } else {
            if (steadySinceTimestampMs == 0L) steadySinceTimestampMs = now
            val steadyDurationMs = now - steadySinceTimestampMs
            isTripodSteady = steadyDurationMs >= 2500L
        }

        if (now - lastMotionEmitMs >= 110L) {
            lastMotionEmitMs = now
            emitMotionTelemetry(now)
        }
    }

    private fun emitMotionTelemetry(now: Long) {
        // Compute horizon roll angle (-180..+180 deg) and pitch angle (-90..+90 deg)
        val rollDeg = Math.toDegrees(atan2(gravX.toDouble(), gravY.toDouble()))
        val pitchDeg = Math.toDegrees(
            atan2(gravZ.toDouble(), hypot(gravX.toDouble(), gravY.toDouble()))
        )

        val steadyElapsedSec = if (steadySinceTimestampMs > 0L) {
            ((now - steadySinceTimestampMs).coerceAtLeast(0L).toDouble() / 1000.0)
        } else {
            0.0
        }

        // Normalize stability score 0..100%
        val gyroScore = (1.0 - (gyroMagnitudeRadSec / 0.15)).coerceIn(0.0, 1.0)
        val accelScore = (1.0 - (linearJitterMps2 / 0.80)).coerceIn(0.0, 1.0)
        val stabilityPct = ((gyroScore * 0.65 + accelScore * 0.35) * 100.0).roundToInt()

        val payload = Arguments.createMap().apply {
            putDouble("rollDeg", (rollDeg * 10.0).roundToInt() / 10.0)
            putDouble("pitchDeg", (pitchDeg * 10.0).roundToInt() / 10.0)
            putBoolean("isLevel", abs(rollDeg) <= 1.2)
            putDouble("gyroRadSec", (gyroMagnitudeRadSec * 1000.0).roundToInt() / 1000.0)
            putDouble("accelJitterMps2", (linearJitterMps2 * 1000.0).roundToInt() / 1000.0)
            putBoolean("isTripodSteady", isTripodSteady)
            putDouble("steadyHoldSeconds", (steadyElapsedSec * 10.0).roundToInt() / 10.0)
            putInt("stabilityPct", stabilityPct)
            putString(
                "stabilityBanner",
                if (isTripodSteady) {
                    "Phone is steady • Ready for Astrophotography"
                } else {
                    "Hold steady or place on a tripod... (${steadyElapsedSec.coerceAtMost(2.5).let { ((it * 10.0).roundToInt() / 10.0) }}s / 2.5s)"
                }
            )
        }

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("onMotionTelemetry", payload)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun onHostResume() = Unit

    override fun onHostPause() = Unit

    override fun onHostDestroy() {
        if (sensorsListening && sensorManager != null) {
            sensorManager.unregisterListener(this)
            sensorsListening = false
        }
    }
}
