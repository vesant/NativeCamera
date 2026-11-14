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

### Pillar D: Cinema Video Record Mode (`Record` Tab)
Implemented natively via `CameraDevice.TEMPLATE_RECORD` + `MediaRecorder` in [`CameraEngineView.kt`](android/app/src/main/java/com/vesant/nativecamera/CameraEngineView.kt) and [`src/app/video.tsx`](src/app/video.tsx):
- **Hardware-Validated Cinema Profiles:** Queries `CamcorderProfile`, `SCALER_STREAM_CONFIGURATION_MAP.getOutputMinFrameDuration`, and `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES` per physical camera ID, configuring a guaranteed 2-surface (`[SurfaceTexture, MediaRecorder]`) Camera2 session with automatic hardware fallback.
- **Configurable Cinema Profiles:** Record H.264/AAC `.mp4` streams in `4K UHD` (`3840x2160`), `1080p FHD` (`1920x1080`), or `720p HD` (`1280x720`) at **`24 fps`**, **`30 fps`**, or **`60 fps`** with selectable bitrates (**`24 Mbps`**, **`50 Mbps`**, **`80 Mbps`**).
- **180° Shutter Angle Cinema Lock:** One-tap lock that sets sensor integration time to $\frac{1}{2 \times \text{fps}}$ (`1/48s` at 24p, `1/60s` at 30p, `1/120s` at 60p) for natural motion cadence.
- **Live Manual Rack Focus (A/B Focus Pulls) & Exposure While Recording:** Adjust shutter speed, ISO sensitivity, Kelvin white balance, and manual focus in diopters—including programmable **Focus Point A / B** presets—live during an active video recording.
- **Cinema Viewfinder Aids:** Anamorphic `2.39:1` and `16:9` letterbox guides, live YUV luminance histogram, digital roll readout, Pause/Resume recording, and direct export to `DCIM/NativeCamera` via `MediaStore.Video`.

---

### Pillar E: Multi-Frame C++17 Computational Lab Modes (`Lab Modes` Tab)
Implemented natively in [`astro_stacker_jni.cpp`](android/app/src/main/cpp/astro_stacker_jni.cpp) and [`src/app/modes.tsx`](src/app/modes.tsx):
1. **HDR+ Exposure Bracketing (Mertens Exposure Fusion):** Automatically sweeps Camera2 exposure time across `[-2 EV .. +2 EV]` around the base exposure and fuses all brackets in C++17 using per-pixel Laplacian contrast, RGB saturation, and Gaussian well-exposedness weights ($\exp(-\frac{(I - 0.5)^2}{2\sigma^2})$).
2. **Light Trails & Star Trails (Temporal Max-Blend):** Captures continuous long-exposure sequences and blends moving highlights (traffic trails, light painting, star arcs) via temporal maximum (`lighten`) while averaging static dark sky/background regions to suppress read noise.
3. **Handheld Night Super-Resolution & Multi-Frame Denoise:** Aligns handheld bursts via C++17 RANSAC keypoint registration, crushes high-ISO chroma noise with alpha-trimmed mean stacking, and restores fine edge micro-contrast with a Laplacian unsharp mask.
4. **Macro Focus Bracketing (Depth-of-Field Fusion):** Automatically steps the lens voice-coil motor in diopters from closest macro focus (`LENS_INFO_MINIMUM_FOCUS_DISTANCE`) to optical infinity (`0.0f` D) and fuses the sharpest focus plane at every pixel using a $3\times 3$ Laplacian energy map.

---

### In-App Camera Roll Thumbnail Well & Photo/Video Lightbox
Implemented in [`MediaPreviewModal.tsx`](src/components/MediaPreviewModal.tsx) and [`VideoPlayerViewManager.kt`](android/app/src/main/java/com/vesant/nativecamera/VideoPlayerViewManager.kt):
- **Live Bottom-Corner Thumbnail Well:** Every capture tab (`Pro RAW`, `Record`, `Lab Modes`, `Astro`) includes a live thumbnail button next to the shutter release that updates immediately after capturing a photo, RAW DNG, computational stack, or `.mp4` video (extracting a frame thumbnail via `MediaMetadataRetriever`).
- **Full-Screen Photo & Native Video Player Modal:** Tapping the thumbnail well opens an in-app media viewer with full-resolution photo inspection, native looping `.mp4` video playback with audio and tap-to-pause/play (`NativeVideoPlayerView`), a horizontal session filmstrip, capture metadata badges, delete support, and a one-tap **Open in Gallery** action.

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
