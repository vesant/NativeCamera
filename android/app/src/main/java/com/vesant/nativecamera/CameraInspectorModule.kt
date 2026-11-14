package com.vesant.nativecamera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Queries Android's low-level Camera2 CameraManager and CameraCharacteristics
 * to build a complete hardware report of every logical and physical image sensor
 * on the phone—including auxiliary ultrawide, telephoto, or macro cameras that
 * OEMs sometimes hide from the public cameraIdList.
 */
class CameraInspectorModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CameraInspectorModule"

    @ReactMethod
    fun inspectAllCameras(promise: Promise) {
        try {
            val cameraManager =
                reactContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager

            val standardIds = cameraManager.cameraIdList.toSet()
            val discoveredPhysicalIds = mutableSetOf<String>()
            val parentLogicalMap = mutableMapOf<String, MutableList<String>>()

            // First pass: walk the standard cameraIdList to discover any sub-sensors
            // grouped under a logical multi-camera wrapper (introduced in Android 9).
            for (logicalId in standardIds) {
                try {
                    val chars = cameraManager.getCameraCharacteristics(logicalId)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        val physIds = chars.physicalCameraIds
                        for (physId in physIds) {
                            discoveredPhysicalIds.add(physId)
                            parentLogicalMap.getOrPut(physId) { mutableListOf() }.add(logicalId)
                        }
                    }
                } catch (_: Exception) {
                    // Some OEM virtual cameras reject characteristics queries if locked; skip safely.
                }
            }

            // Second pass: probe sequential numeric IDs (0..15) so we can uncover hidden
            // physical sensors (like secondary ultrawide or macro modules) that the HAL
            // exposes in getCameraCharacteristics() even when omitted from cameraIdList.
            val allCandidateIds = linkedSetOf<String>()
            allCandidateIds.addAll(standardIds)
            allCandidateIds.addAll(discoveredPhysicalIds)
            for (probeId in 0..15) {
                allCandidateIds.add(probeId.toString())
            }

            val sensorsArray: WritableArray = Arguments.createArray()
            val rawJsonReportArray = JSONArray()

            for (cameraId in allCandidateIds) {
                val chars = try {
                    cameraManager.getCameraCharacteristics(cameraId)
                } catch (_: Throwable) {
                    // This numeric ID does not exist or is restricted by SELinux/HAL.
                    null
                } ?: continue

                val isInPublicList = standardIds.contains(cameraId)
                val parentLogicalIds = parentLogicalMap[cameraId] ?: emptyList()

                val sensorMap = buildCameraCharacteristicMap(
                    cameraId = cameraId,
                    chars = chars,
                    isInPublicList = isInPublicList,
                    parentLogicalIds = parentLogicalIds
                )
                sensorsArray.pushMap(sensorMap.first)
                rawJsonReportArray.put(sensorMap.second)
            }

            val fullReport = JSONObject().apply {
                put("deviceManufacturer", Build.MANUFACTURER)
                put("deviceBrand", Build.BRAND)
                put("deviceModel", Build.MODEL)
                put("deviceBoard", Build.BOARD)
                put("hardware", Build.HARDWARE)
                put("socModel", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.SOC_MODEL else "Unknown")
                put("androidVersion", Build.VERSION.RELEASE)
                put("sdkInt", Build.VERSION.SDK_INT)
                put("inspectedAtIso", java.time.Instant.now().toString())
                put("cameraCount", rawJsonReportArray.length())
                put("sensors", rawJsonReportArray)
            }

            val result = Arguments.createMap().apply {
                putString("deviceManufacturer", Build.MANUFACTURER)
                putString("deviceModel", Build.MODEL)
                putString("socModel", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.SOC_MODEL else Build.HARDWARE)
                putString("androidRelease", Build.VERSION.RELEASE)
                putInt("sdkInt", Build.VERSION.SDK_INT)
                putArray("sensors", sensorsArray)
                putString("jsonReport", fullReport.toString(2))
            }

            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("CAMERA_INSPECTOR_ERROR", "Failed to inspect camera hardware: ${e.message}", e)
        }
    }

    private fun buildCameraCharacteristicMap(
        cameraId: String,
        chars: CameraCharacteristics,
        isInPublicList: Boolean,
        parentLogicalIds: List<String>
    ): Pair<WritableMap, JSONObject> {
        val map = Arguments.createMap()
        val json = JSONObject()

        // 1. Facing & Logical vs Physical topology
        val lensFacingInt = chars.get(CameraCharacteristics.LENS_FACING)
        val facingLabel = when (lensFacingInt) {
            CameraCharacteristics.LENS_FACING_BACK -> "Back"
            CameraCharacteristics.LENS_FACING_FRONT -> "Front"
            CameraCharacteristics.LENS_FACING_EXTERNAL -> "External"
            else -> "Unknown"
        }

        val capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        val isLogicalMultiCamera = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            capabilities.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
        } else {
            false
        }
        val backedByPhysicalIds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            chars.physicalCameraIds.toList()
        } else {
            emptyList()
        }

        val sensorTypeLabel = when {
            isLogicalMultiCamera && backedByPhysicalIds.isNotEmpty() ->
                "Logical Multi-Camera (fuses IDs: ${backedByPhysicalIds.joinToString(", ")})"
            !isInPublicList ->
                "Hidden Auxiliary Physical Sensor"
            parentLogicalIds.isNotEmpty() ->
                "Physical Sub-Sensor (part of Logical ID ${parentLogicalIds.joinToString(", ")})"
            else ->
                "Standalone Physical Sensor"
        }

        // 2. Hardware Support Level
        // Android grades Camera2 implementations from LEGACY (Camera1 wrapper) up to LEVEL_3
        // (which guarantees YUV reprocessing and RAW capture capabilities).
        val hwLevelInt = chars.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)
        val (hwLevelCode, hwLevelSummary, supportsFullManual) = when (hwLevelInt) {
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> Triple(
                "LEVEL_3",
                "Highest tier: Full per-frame manual control, YUV reprocessing, and RAW output support.",
                true
            )
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> Triple(
                "FULL",
                "Pro tier: Full manual control over exposure, ISO, focus, and 30fps burst capture.",
                true
            )
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> Triple(
                "LIMITED",
                "Partial Camera2 feature set: Some manual controls may be restricted by the OEM HAL.",
                false
            )
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> Triple(
                "EXTERNAL",
                "External webcam/USB sensor with basic stream controls.",
                false
            )
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> Triple(
                "LEGACY",
                "Legacy Camera1 emulation mode: No per-frame manual exposure or RAW capture.",
                false
            )
            else -> Triple("UNKNOWN", "Unrecognized hardware level.", false)
        }

        val supportsRawCapability =
            capabilities.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW)
        val supportsManualSensorCapability =
            capabilities.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
        val supportsManualPostProc =
            capabilities.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING)

        // 3. Physical Sensor Metrics (Size in mm, Pixel Array, Active Array, Pixel Pitch um, Crop Factor)
        val physicalSize = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        val pixelArraySize = chars.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val activeArrayRect = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)

        val sensorWidthMm = physicalSize?.width?.toDouble() ?: 0.0
        val sensorHeightMm = physicalSize?.height?.toDouble() ?: 0.0
        val sensorDiagonalMm = hypot(sensorWidthMm, sensorHeightMm)

        // A standard 35mm full-frame sensor measures 36mm x 24mm (diagonal = 43.2666mm).
        // Dividing 43.2666mm by this sensor's physical diagonal gives the exact 35mm crop factor.
        val fullFrameDiagonalMm = hypot(36.0, 24.0)
        val cropFactor35mm = if (sensorDiagonalMm > 0.1) {
            ((fullFrameDiagonalMm / sensorDiagonalMm) * 100.0).roundToInt() / 100.0
        } else {
            0.0
        }

        val pixelWidth = pixelArraySize?.width ?: activeArrayRect?.width() ?: 0
        val pixelHeight = pixelArraySize?.height ?: activeArrayRect?.height() ?: 0
        val activeWidth = activeArrayRect?.width() ?: pixelWidth
        val activeHeight = activeArrayRect?.height() ?: pixelHeight
        val megapixels = ((pixelWidth.toDouble() * pixelHeight.toDouble()) / 1_000_000.0 * 10.0).roundToInt() / 10.0

        // Pixel pitch in micrometers (um): (sensorWidthMm * 1000 um/mm) / pixelWidth.
        // Larger pixel pitch (or 4-in-1 binned pitch) collects more photons per exposure in Astro Mode.
        val pixelPitchUm = if (pixelWidth > 0 && sensorWidthMm > 0.0) {
            (((sensorWidthMm * 1000.0) / pixelWidth.toDouble()) * 100.0).roundToInt() / 100.0
        } else {
            0.0
        }

        val cfaArrangementInt = chars.get(CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT)
        val cfaPattern = when (cfaArrangementInt) {
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_RGGB -> "RGGB Bayer"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_GRBG -> "GRBG Bayer"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_GBRG -> "GBRG Bayer"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_BGGR -> "BGGR Bayer"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_RGB -> "RGB"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_MONO -> "Monochrome"
            CameraCharacteristics.SENSOR_INFO_COLOR_FILTER_ARRANGEMENT_NIR -> "Near-Infrared"
            else -> "Standard / Quad-Bayer"
        }

        // 4. Optics & Lens (Apertures, Focal Lengths, 35mm Equivalent Focal Length, Min Focus Distance, OIS, Distortion)
        val apertures = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES) ?: FloatArray(0)
        val focalLengths = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS) ?: FloatArray(0)
        val primaryFocalLengthMm = focalLengths.firstOrNull()?.toDouble() ?: 0.0
        val equivFocalLength35mm = if (primaryFocalLengthMm > 0.0 && cropFactor35mm > 0.0) {
            (primaryFocalLengthMm * cropFactor35mm * 10.0).roundToInt() / 10.0
        } else {
            0.0
        }

        // Minimum focus distance is reported in diopters (1 / meters).
        // 0.0 diopters means the lens is fixed-focus at infinity.
        val minFocusDistanceDiopters = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0.0f
        val minFocusDistanceCm = if (minFocusDistanceDiopters > 0.001f) {
            ((100.0 / minFocusDistanceDiopters.toDouble()) * 10.0).roundToInt() / 10.0
        } else {
            0.0
        }
        val focusCalibrationInt = chars.get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION)
        val focusCalibrationLabel = when (focusCalibrationInt) {
            CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_CALIBRATED ->
                "Calibrated (True diopters; 0.0 = exact optical infinity)"
            CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_APPROXIMATE ->
                "Approximate (Nominal diopters)"
            else ->
                "Uncalibrated / Fixed Focus"
        }

        val oisModes = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION) ?: IntArray(0)
        val supportsOis = oisModes.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON)

        val distortionModes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            chars.get(CameraCharacteristics.DISTORTION_CORRECTION_AVAILABLE_MODES) ?: IntArray(0)
        } else {
            IntArray(0)
        }
        val distortionLabels = distortionModes.map { mode ->
            when (mode) {
                CameraMetadata.DISTORTION_CORRECTION_MODE_OFF -> "OFF"
                CameraMetadata.DISTORTION_CORRECTION_MODE_FAST -> "FAST"
                CameraMetadata.DISTORTION_CORRECTION_MODE_HIGH_QUALITY -> "HIGH_QUALITY"
                else -> "MODE_$mode"
            }
        }

        // 5. Exposure & Sensitivity Limits (ISO range & Exposure time in ns)
        val isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
        val minIso = isoRange?.lower ?: 100
        val maxIso = isoRange?.upper ?: 3200
        val maxAnalogIso = chars.get(CameraCharacteristics.SENSOR_MAX_ANALOG_SENSITIVITY) ?: maxIso

        val exposureRangeNs = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
        val minExposureNs = exposureRangeNs?.lower ?: 100_000L
        val maxExposureNs = exposureRangeNs?.upper ?: 1_000_000_000L
        val minExposureFormatted = formatShutterSpeedNs(minExposureNs)
        val maxExposureFormatted = formatShutterSpeedNs(maxExposureNs)

        // 6. Supported Stream Formats (RAW_SENSOR 16-bit DNG, RAW10, RAW12, YUV_420_888, JPEG)
        val streamConfigMap = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val outputFormats = streamConfigMap?.outputFormats ?: IntArray(0)

        fun formatResolutionSummary(format: Int): String? {
            if (!outputFormats.contains(format)) return null
            val sizes = streamConfigMap?.getOutputSizes(format) ?: return "Supported"
            val largest = sizes.maxByOrNull { it.width.toLong() * it.height.toLong() } ?: return "Supported"
            return "${largest.width}x${largest.height}"
        }

        val rawSensorMaxRes = formatResolutionSummary(ImageFormat.RAW_SENSOR)
        val raw10MaxRes = formatResolutionSummary(ImageFormat.RAW10)
        val raw12MaxRes = formatResolutionSummary(ImageFormat.RAW12)
        val yuvMaxRes = formatResolutionSummary(ImageFormat.YUV_420_888)
        val jpegMaxRes = formatResolutionSummary(ImageFormat.JPEG)

        val streamFormatsArray = Arguments.createArray()
        val streamFormatsJson = JSONArray()

        fun addStreamInfo(name: String, description: String, maxRes: String?) {
            val itemMap = Arguments.createMap().apply {
                putString("name", name)
                putString("description", description)
                putBoolean("supported", maxRes != null)
                putString("maxResolution", maxRes ?: "Not Supported")
            }
            streamFormatsArray.pushMap(itemMap)
            streamFormatsJson.put(JSONObject().apply {
                put("name", name)
                put("description", description)
                put("supported", maxRes != null)
                put("maxResolution", maxRes ?: "Not Supported")
            })
        }

        addStreamInfo("RAW_SENSOR", "16-bit Uncompressed Bayer DNG", rawSensorMaxRes)
        addStreamInfo("RAW10", "10-bit Packed MIPI RAW", raw10MaxRes)
        addStreamInfo("RAW12", "12-bit Packed MIPI RAW", raw12MaxRes)
        addStreamInfo("YUV_420_888", "Multi-plane 8-bit YUV (Preview & Astro Stacking)", yuvMaxRes)
        addStreamInfo("JPEG", "Hardware-Encoded JPEG Output", jpegMaxRes)

        val lensRoleGuess = inferLensRole(facingLabel, equivFocalLength35mm, minFocusDistanceDiopters, isLogicalMultiCamera)

        // Populate React Native bridge map
        map.putString("cameraId", cameraId)
        map.putString("facing", facingLabel)
        map.putString("lensRole", lensRoleGuess)
        map.putBoolean("isPublicCameraId", isInPublicList)
        map.putBoolean("isLogicalMultiCamera", isLogicalMultiCamera)
        map.putString("sensorTypeLabel", sensorTypeLabel)
        map.putArray("physicalSubIds", Arguments.fromList(backedByPhysicalIds))
        map.putString("hardwareLevel", hwLevelCode)
        map.putString("hardwareLevelSummary", hwLevelSummary)
        map.putBoolean("supportsFullManual", supportsFullManual || supportsManualSensorCapability)
        map.putBoolean("supportsRaw", supportsRawCapability || rawSensorMaxRes != null)
        map.putBoolean("supportsManualPostProcessing", supportsManualPostProc)

        map.putDouble("sensorWidthMm", (sensorWidthMm * 100.0).roundToInt() / 100.0)
        map.putDouble("sensorHeightMm", (sensorHeightMm * 100.0).roundToInt() / 100.0)
        map.putDouble("sensorDiagonalMm", (sensorDiagonalMm * 100.0).roundToInt() / 100.0)
        map.putInt("pixelArrayWidth", pixelWidth)
        map.putInt("pixelArrayHeight", pixelHeight)
        map.putInt("activeArrayWidth", activeWidth)
        map.putInt("activeArrayHeight", activeHeight)
        map.putDouble("megapixels", megapixels)
        map.putDouble("pixelPitchUm", pixelPitchUm)
        map.putDouble("cropFactor35mm", cropFactor35mm)
        map.putString("cfaPattern", cfaPattern)

        map.putArray("apertures", Arguments.fromArray(apertures.map { ((it * 100.0f).roundToInt() / 100.0) }.toDoubleArray()))
        map.putArray("focalLengthsMm", Arguments.fromArray(focalLengths.map { ((it * 100.0f).roundToInt() / 100.0) }.toDoubleArray()))
        map.putDouble("equivFocalLength35mm", equivFocalLength35mm)
        map.putDouble("minFocusDistanceDiopters", ((minFocusDistanceDiopters * 100.0f).roundToInt() / 100.0))
        map.putDouble("minFocusDistanceCm", minFocusDistanceCm)
        map.putString("focusCalibration", focusCalibrationLabel)
        map.putBoolean("supportsOis", supportsOis)
        map.putArray("distortionModes", Arguments.fromList(distortionLabels))

        map.putInt("minIso", minIso)
        map.putInt("maxIso", maxIso)
        map.putInt("maxAnalogIso", maxAnalogIso)
        map.putDouble("minExposureNs", minExposureNs.toDouble())
        map.putDouble("maxExposureNs", maxExposureNs.toDouble())
        map.putString("minExposureFormatted", minExposureFormatted)
        map.putString("maxExposureFormatted", maxExposureFormatted)
        map.putArray("streamFormats", streamFormatsArray)

        // Populate JSON report entry
        json.put("cameraId", cameraId)
        json.put("facing", facingLabel)
        json.put("lensRole", lensRoleGuess)
        json.put("isPublicCameraId", isInPublicList)
        json.put("isLogicalMultiCamera", isLogicalMultiCamera)
        json.put("sensorTypeLabel", sensorTypeLabel)
        json.put("physicalSubIds", JSONArray(backedByPhysicalIds))
        json.put("hardwareLevel", hwLevelCode)
        json.put("hardwareLevelSummary", hwLevelSummary)
        json.put("supportsFullManual", supportsFullManual || supportsManualSensorCapability)
        json.put("supportsRaw", supportsRawCapability || rawSensorMaxRes != null)
        json.put("physicalMetrics", JSONObject().apply {
            put("widthMm", (sensorWidthMm * 100.0).roundToInt() / 100.0)
            put("heightMm", (sensorHeightMm * 100.0).roundToInt() / 100.0)
            put("diagonalMm", (sensorDiagonalMm * 100.0).roundToInt() / 100.0)
            put("pixelArray", "${pixelWidth}x${pixelHeight}")
            put("activeArray", "${activeWidth}x${activeHeight}")
            put("megapixels", megapixels)
            put("pixelPitchUm", pixelPitchUm)
            put("cropFactor35mm", cropFactor35mm)
            put("cfaPattern", cfaPattern)
        })
        json.put("optics", JSONObject().apply {
            put("apertures", JSONArray(apertures.map { ((it * 100.0f).roundToInt() / 100.0) }))
            put("focalLengthsMm", JSONArray(focalLengths.map { ((it * 100.0f).roundToInt() / 100.0) }))
            put("equivFocalLength35mm", equivFocalLength35mm)
            put("minFocusDistanceDiopters", ((minFocusDistanceDiopters * 100.0f).roundToInt() / 100.0))
            put("minFocusDistanceCm", minFocusDistanceCm)
            put("focusCalibration", focusCalibrationLabel)
            put("supportsOis", supportsOis)
            put("distortionCorrectionModes", JSONArray(distortionLabels))
        })
        json.put("exposureAndSensitivity", JSONObject().apply {
            put("minIso", minIso)
            put("maxIso", maxIso)
            put("maxAnalogIso", maxAnalogIso)
            put("minExposureNs", minExposureNs)
            put("maxExposureNs", maxExposureNs)
            put("minExposureFormatted", minExposureFormatted)
            put("maxExposureFormatted", maxExposureFormatted)
        })
        json.put("streamFormats", streamFormatsJson)

        return Pair(map, json)
    }

    /**
     * Converts a raw Camera2 exposure duration in nanoseconds into a photographer-friendly
     * shutter speed string like "1/8000s", "1/60s", "0.5s", or "32.0s".
     */
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

    private fun inferLensRole(
        facing: String,
        equivFocal35mm: Double,
        minFocusDiopters: Float,
        isLogical: Boolean
    ): String {
        if (facing == "Front") return "Front Selfie Camera"
        if (facing == "External") return "External Camera"
        if (isLogical) return "Rear Logical Multi-Camera"
        return when {
            equivFocal35mm in 1.0..19.5 -> "Rear Ultrawide / Macro Camera"
            equivFocal35mm in 19.5..35.0 -> "Rear Primary Wide Camera"
            equivFocal35mm > 35.0 -> "Rear Telephoto Camera"
            minFocusDiopters >= 20.0f -> "Dedicated Macro Sensor"
            else -> "Rear Auxiliary Sensor"
        }
    }
}
