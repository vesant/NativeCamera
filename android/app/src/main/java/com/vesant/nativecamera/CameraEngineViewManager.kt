package com.vesant.nativecamera

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.roundToLong

/**
 * Exposes our low-level Camera2 `CameraEngineView` as a native React Native view component.
 * Batching manual parameter updates inside `onAfterUpdateTransaction` prevents flooding
 * the Camera2 capture session with redundant repeating requests during slider drags.
 */
class CameraEngineViewManager : SimpleViewManager<CameraEngineView>() {

    override fun getName(): String = "CameraEngineView"

    override fun createViewInstance(reactContext: ThemedReactContext): CameraEngineView {
        return CameraEngineView(reactContext)
    }

    @ReactProp(name = "cameraId")
    fun setCameraId(view: CameraEngineView, cameraId: String?) {
        if (!cameraId.isNullOrBlank()) {
            view.cameraIdProp = cameraId
        }
    }

    @ReactProp(name = "active", defaultBoolean = true)
    fun setActive(view: CameraEngineView, active: Boolean) {
        view.isViewActive = active
    }

    @ReactProp(name = "manualExposure", defaultBoolean = false)
    fun setManualExposure(view: CameraEngineView, manual: Boolean) {
        view.manualExposure = manual
    }

    @ReactProp(name = "exposureTimeNs", defaultDouble = 16666666.0)
    fun setExposureTimeNs(view: CameraEngineView, exposureNs: Double) {
        view.exposureTimeNs = exposureNs.roundToLong().coerceAtLeast(10_000L)
    }

    @ReactProp(name = "manualIso", defaultBoolean = false)
    fun setManualIso(view: CameraEngineView, manual: Boolean) {
        view.manualIso = manual
    }

    @ReactProp(name = "isoValue", defaultInt = 200)
    fun setIsoValue(view: CameraEngineView, iso: Int) {
        view.isoValue = iso.coerceAtLeast(25)
    }

    @ReactProp(name = "manualFocus", defaultBoolean = false)
    fun setManualFocus(view: CameraEngineView, manual: Boolean) {
        view.manualFocus = manual
    }

    @ReactProp(name = "focusDistanceDiopters", defaultFloat = 0.0f)
    fun setFocusDistanceDiopters(view: CameraEngineView, diopters: Float) {
        view.focusDistanceDiopters = diopters.coerceAtLeast(0.0f)
    }

    @ReactProp(name = "manualWhiteBalance", defaultBoolean = false)
    fun setManualWhiteBalance(view: CameraEngineView, manual: Boolean) {
        view.manualWhiteBalance = manual
    }

    @ReactProp(name = "wbKelvin", defaultInt = 5500)
    fun setWbKelvin(view: CameraEngineView, kelvin: Int) {
        view.wbKelvin = kelvin.coerceIn(2000, 10000)
    }

    @ReactProp(name = "wbTint", defaultInt = 0)
    fun setWbTint(view: CameraEngineView, tint: Int) {
        view.wbTint = tint.coerceIn(-50, 50)
    }

    @ReactProp(name = "enableRawDng", defaultBoolean = false)
    fun setEnableRawDng(view: CameraEngineView, enable: Boolean) {
        view.enableRawDng = enable
    }

    @ReactProp(name = "zoomRatio", defaultFloat = 1.0f)
    fun setZoomRatio(view: CameraEngineView, zoom: Float) {
        view.zoomRatio = zoom.coerceAtLeast(1.0f)
    }

    override fun onAfterUpdateTransaction(view: CameraEngineView) {
        super.onAfterUpdateTransaction(view)
        view.applyManualParametersUpdate()
    }

    override fun onDropViewInstance(view: CameraEngineView) {
        view.isViewActive = false
        super.onDropViewInstance(view)
    }
}
