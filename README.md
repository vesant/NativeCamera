# NativeCamera — Android Computational Photography & CMOS Sensor Inspector

**NativeCamera** is a low-level Android Camera2, C++17 JNI, and React Native (Expo Prebuild) computational photography and hardware inspection suite engineered for physical Android devices.

Unlike standard camera wrappers that hide sensor internals behind automatic pipelines, **NativeCamera** talks directly to `android.hardware.camera2`, `DngCreator`, `SensorManager`, and a custom **C++17 NDK Star Registration & Sigma-Clipped Stacking Engine** (`libnativecamera_astro.so`).

---

## Core Architecture & Three Pillars

### Pillar A: Deep Camera Hardware & CMOS Sensor Inspector (`Sensor Info` Tab)
Implemented natively in [`CameraInspectorModule.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraInspectorModule.kt):
- **Logical & Hidden Physical Sensor Discovery:** Queries `CameraManager.getCameraIdList()`, inspects `CameraCharacteristics.getPhysicalCameraIds()` on logical multi-camera arrays (Android 9+), and probes sequential HAL IDs (`0..15`) to surface auxiliary ultrawide, telephoto, or macro modules.
- **Hardware Support Level Analysis:** Decodes `INFO_SUPPORTED_HARDWARE_LEVEL` (`LEVEL_3`, `FULL`, `LIMITED`, `LEGACY`, `EXTERNAL`) alongside `REQUEST_AVAILABLE_CAPABILITIES_RAW` and `MANUAL_SENSOR`.
- **CMOS Geometry & Physics:**
  - Exact physical die size in millimeters (`SENSOR_INFO_PHYSICAL_SIZE`) and diagonal.
  - Native pixel array (`SENSOR_INFO_PIXEL_ARRAY_SIZE`) and active photosite array (`SENSOR_INFO_ACTIVE_ARRAY_SIZE`).
  - Computed **pixel pitch in micrometers ($\mu m$)** and **35mm full-frame equivalent crop factor** ($\frac{43.27\text{ mm}}{\text{diag}_{\text{sensor}}}$).
  - Color Filter Array (CFA) Bayer arrangement (`RGGB`, `BGGR`, `GRBG`, `GBRG`, `MONO`).
- **Optics & Exposure Bounds:** Available apertures (`f/`), physical & 35mm-equivalent focal lengths, minimum focus distance in **diopters ($\text{m}^{-1}$) and centimeters**, optical image stabilization (`OIS`), distortion correction modes, exact ISO sensitivity bounds (`SENSOR_INFO_SENSITIVITY_RANGE`), and nanosecond exposure bounds (`SENSOR_INFO_EXPOSURE_TIME_RANGE`).
- **Stream Format Matrix & Export:** Verifies hardware stream support and maximum resolution for `RAW_SENSOR` (16-bit uncompressed Adobe DNG), `RAW10`, `RAW12`, `YUV_420_888`, and `JPEG`, with one-tap **Copy / Export Full JSON Report**.

---

### Pillar B: Pro Manual Camera & 16-Bit RAW DNG Capture (`Pro Mode` Tab)
Implemented natively in [`CameraEngineView.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraEngineView.kt), [`CameraEngineViewManager.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraEngineViewManager.kt), and [`CameraEngineModule.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraEngineModule.kt):
- **Zero-Lag Camera2 Viewfinder:** Custom `TextureView` surface with aspect-ratio-preserving matrix transformation and per-frame `CaptureRequest` updates.
- **Physical Lens Switcher:** Instant switching across all discovered rear and front camera IDs.
- **Per-Parameter Auto / Manual Controls:**
  - **Shutter Speed:** Logarithmic dial across the sensor's exact nanosecond `SENSOR_INFO_EXPOSURE_TIME_RANGE` (`1/10000s` up to multi-second exposures).
  - **ISO Sensitivity:** Logarithmic gain dial across `SENSOR_INFO_SENSITIVITY_RANGE`.
  - **Manual Diopter Focus:** Continuous diopter control from macro (`LENS_INFO_MINIMUM_FOCUS_DISTANCE`) down to **true optical infinity (`0.0f` D)**, plus a dedicated **Lock $\infty$** button for night-sky focus.
  - **Manual Kelvin White Balance:** Custom correlated color temperature (`2000K – 10000K`) and green/magenta tint converted directly into Bayer `RggbChannelVector` gains with `CONTROL_AWB_MODE_OFF`.
- **Real-Time Viewfinder Aids:**
  - **Live YUV_420_888 Luminance & RGB Histogram:** Sub-millisecond 32-bin R, G, B, and Y histogram with highlight clipping percentage.
  - **Digital Spirit Level:** Real-time roll and pitch horizon indicator driven by `TYPE_ACCELEROMETER`.
  - **Framing Grids:** Rule-of-Thirds and Golden Ratio (`Phi`) overlays.
- **Dual JPEG + 16-Bit Uncompressed Adobe DNG Output:** Writes high-bitrate `JPEG` and raw sensor Bayer `DNG` (`android.hardware.camera2.DngCreator`) directly to `DCIM/NativeCamera` via `MediaStore`.

---

### Pillar C: Computational Astrophotography Engine (`Astro Mode` Tab)
Implemented natively in C++17 ([`astro_stacker_jni.cpp`](android/app/src/main/cpp/astro_stacker_jni.cpp)) and Kotlin ([`CameraEngineView.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraEngineView.kt)):

1. **Inertial Tripod & Stillness Guard (`SensorManager`):**
   - Samples `TYPE_GYROSCOPE` and `TYPE_ACCELEROMETER` at `SENSOR_DELAY_GAME`.
   - Tracks angular velocity magnitude ($\omega < 0.042\text{ rad/s}$) and linear vibration ($\Delta a < 0.24\text{ m/s}^2$).
   - Requires **2.5 seconds** of continuous stillness before signaling `"Phone is steady • Ready for Astrophotography"`.
   - If the phone is picked up mid-capture while Tripod Motion Guard is active, the burst gracefully halts and immediately stacks all steady frames captured so far.
2. **Automated Long-Exposure Burst Pipeline:**
   - Locks lens focus to optical infinity (`0.0f` D), disables AE/AWB drift, neutralizes night-sky color balance (`4600K`), and captures **12, 20, or 30 sub-exposures** at configurable per-frame exposure windows (`4s – 10s`, clamped to hardware limits).
   - Streams a **live progressive stacked preview** after every aligned frame.
3. **C++17 Star Registration (RANSAC + Procrustes) & Sigma-Clipped Stacking:**
   - **Sub-Pixel Star Centroid Extraction:** Divides each frame into an $8 \times 6$ spatial sky grid, isolates non-saturated stellar peaks above local sky background $+ 3.2\sigma$, rejects single-pixel hot thermal defects, and computes intensity-weighted sub-pixel centroids $(x_c, y_c)$.
   - **2D Rigid Transformation via RANSAC:** Matches stellar constellation baselines against Reference Frame 1 using 180 RANSAC iterations followed by closed-form 2D orthogonal Procrustes least-squares refinement to solve rotation $\theta$ and translation $(t_x, t_y)$ caused by Earth's sidereal rotation.
   - **Bilinear Frame Warping & $1.8\sigma$-Clipped Mean Stacking:** Warps each frame into Reference Frame 1's coordinate space in native C++ heap memory and rejects temporal outliers ($|v_i - \mu| > 1.8\sigma$) to eliminate thermal read noise, hot pixels, and satellite/airplane streaks while boosting signal-to-noise ratio by $\sqrt{N}$.
   - **Astronomical Tone Curve & Chroma Denoising:** Calibrates 18th-percentile sky-background black point per RGB channel, applies a hyperbolic $\text{asinh}$ stretch curve with S-curve contrast, and runs a $3\times 3$ luminance-preserving $YC_bC_r$ chromatic noise reduction filter.
   - Includes an interactive **Before (Single Frame 1) vs. After (Stacked Result)** comparison viewer.

---

## Building from Fedora Linux / Bazzite

### 1. Prerequisites
Ensure OpenJDK 17, Node.js (v20/v22 LTS), CMake, Ninja, and Android SDK/NDK are installed:

```bash
# On standard Fedora Workstation:
sudo dnf install -y git curl unzip wget cmake ninja-build java-17-openjdk-devel android-tools nodejs

# Or on Fedora Atomic / Bazzite via Homebrew:
brew install openjdk@17 node@22 cmake ninja
```

Ensure `ANDROID_HOME` (`~/Android/Sdk`) has the required SDK & NDK packages installed via `sdkmanager`:

```bash
sdkmanager "platform-tools" "platforms;android-34" "platforms;android-36" "build-tools;34.0.0" "build-tools;36.0.0" "ndk;26.1.10909125" "cmake;3.22.1"
```

### 2. Enable USB Debugging on Your Android Phone
1. Open **Settings → About Phone** and tap **Build Number** 7 times to unlock Developer Options.
2. Open **Settings → System → Developer Options** and enable **USB Debugging**.
3. Connect the phone via USB, select **Allow** on the RSA fingerprint prompt, and verify connection:
   ```bash
   adb devices -l
   ```

### 3. Compile & Install the Standalone Debug APK
```bash
npm install
npx tsc --noEmit
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
