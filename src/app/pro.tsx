import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  CameraSensorCharacteristics,
  inspectDeviceCameras,
} from '@/native/CameraInspector';
import {
  CameraHistogramPayload,
  CameraLiveTelemetry,
  captureProPhoto,
  formatExposureNs,
  MotionTelemetry,
  NativeCameraEngineView,
  ProPhotoCaptureResult,
  startMotionSensors,
  stopMotionSensors,
  subscribeCameraStatus,
  subscribeHistogram,
  subscribeMotionTelemetry,
  subscribeTelemetry,
} from '@/native/CameraEngine';
import { PrecisionSlider } from '@/components/PrecisionSlider';

type ActiveControlTab = 'SHUTTER' | 'ISO' | 'FOCUS' | 'WB';
type GridOverlayMode = 'THIRDS' | 'GOLDEN' | 'OFF';

const WB_PRESETS = [
  { label: '3200K Tungsten', kelvin: 3200 },
  { label: '4600K Night Sky', kelvin: 4600 },
  { label: '5500K Daylight', kelvin: 5500 },
  { label: '6500K Overcast', kelvin: 6500 },
  { label: '7800K Shade', kelvin: 7800 },
];

export default function ProModeScreen() {
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isScreenFocused, setIsScreenFocused] = useState<boolean>(false);

  const [sensors, setSensors] = useState<CameraSensorCharacteristics[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('0');

  // Manual vs Auto states per parameter
  const [manualExposure, setManualExposure] = useState<boolean>(false);
  const [exposureTimeNs, setExposureTimeNs] = useState<number>(16_666_666); // 1/60s

  const [manualIso, setManualIso] = useState<boolean>(false);
  const [isoValue, setIsoValue] = useState<number>(200);

  const [manualFocus, setManualFocus] = useState<boolean>(false);
  const [focusDiopters, setFocusDiopters] = useState<number>(0.0);

  const [manualWb, setManualWb] = useState<boolean>(false);
  const [wbKelvin, setWbKelvin] = useState<number>(5500);
  const [wbTint, setWbTint] = useState<number>(0);

  const [enableRawDng, setEnableRawDng] = useState<boolean>(true);
  const [activeControlTab, setActiveControlTab] = useState<ActiveControlTab>('SHUTTER');

  // Viewfinder aids
  const [gridMode, setGridMode] = useState<GridOverlayMode>('THIRDS');
  const [showRgbHistogram, setShowRgbHistogram] = useState<boolean>(true);
  const [showSpiritLevel, setShowSpiritLevel] = useState<boolean>(true);

  // Real-time native telemetry
  const [histogram, setHistogram] = useState<CameraHistogramPayload | null>(null);
  const [liveTelemetry, setLiveTelemetry] = useState<CameraLiveTelemetry | null>(null);
  const [motion, setMotion] = useState<MotionTelemetry | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('Initializing Camera2...');

  // Capture feedback
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [lastCapture, setLastCapture] = useState<ProPhotoCaptureResult | null>(null);

  const requestCameraPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
        {
          title: 'Camera Hardware Access',
          message:
            'NativeCamera requires direct Camera2 access for manual exposure, RAW DNG capture, and astrophotography.',
          buttonPositive: 'Allow',
        }
      );
      setHasPermission(granted === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      setHasPermission(false);
    }
  }, []);

  useEffect(() => {
    requestCameraPermissions();
    inspectDeviceCameras()
      .then((rep) => {
        setSensors(rep.sensors);
        if (rep.sensors.length > 0) {
          setSelectedCameraId(rep.sensors[0].cameraId);
        }
      })
      .catch(() => {});
  }, [requestCameraPermissions]);

  useFocusEffect(
    useCallback(() => {
      setIsScreenFocused(true);
      startMotionSensors().catch(() => {});

      const histSub = subscribeHistogram((data) => setHistogram(data));
      const teleSub = subscribeTelemetry((data) => setLiveTelemetry(data));
      const statusSub = subscribeCameraStatus((data) => setStatusMessage(data.message));
      const motionSub = subscribeMotionTelemetry((data) => setMotion(data));

      return () => {
        setIsScreenFocused(false);
        histSub.remove();
        teleSub.remove();
        statusSub.remove();
        motionSub.remove();
        stopMotionSensors().catch(() => {});
      };
    }, [])
  );

  const activeSensor = useMemo(
    () => sensors.find((s) => s.cameraId === selectedCameraId) ?? sensors[0],
    [sensors, selectedCameraId]
  );

  const minExpNs = activeSensor?.minExposureNs ?? 100_000; // 1/10000s
  const maxExpNs = activeSensor?.maxExposureNs ?? 1_000_000_000; // 1s fallback
  const minIso = activeSensor?.minIso ?? 100;
  const maxIso = activeSensor?.maxIso ?? 3200;
  const maxFocusDiopters = Math.max(0.1, activeSensor?.minFocusDistanceDiopters ?? 10.0);

  // Logarithmic mapping for Shutter Speed slider:
  // Because exposure time spans 5+ orders of magnitude (e.g., 1/8000s to 32s),
  // a logarithmic curve gives smooth stop-by-stop control across the entire slider.
  const shutterSliderNormalized = useMemo(() => {
    const clamped = Math.max(minExpNs, Math.min(maxExpNs, exposureTimeNs));
    const logMin = Math.log(minExpNs);
    const logMax = Math.log(maxExpNs);
    if (logMax <= logMin) return 0.5;
    return (Math.log(clamped) - logMin) / (logMax - logMin);
  }, [exposureTimeNs, minExpNs, maxExpNs]);

  const handleShutterSliderChange = useCallback(
    (norm: number) => {
      const logMin = Math.log(minExpNs);
      const logMax = Math.log(maxExpNs);
      const ns = Math.round(Math.exp(logMin + norm * (logMax - logMin)));
      setManualExposure(true);
      setExposureTimeNs(ns);
    },
    [minExpNs, maxExpNs]
  );

  // Logarithmic mapping for ISO slider (ISO stops double: 100, 200, 400, 800, 1600, 3200...)
  const isoSliderNormalized = useMemo(() => {
    const clamped = Math.max(minIso, Math.min(maxIso, isoValue));
    const logMin = Math.log(Math.max(1, minIso));
    const logMax = Math.log(Math.max(2, maxIso));
    if (logMax <= logMin) return 0.5;
    return (Math.log(clamped) - logMin) / (logMax - logMin);
  }, [isoValue, minIso, maxIso]);

  const handleIsoSliderChange = useCallback(
    (norm: number) => {
      const logMin = Math.log(Math.max(1, minIso));
      const logMax = Math.log(Math.max(2, maxIso));
      const nextIso = Math.round(Math.exp(logMin + norm * (logMax - logMin)));
      setManualIso(true);
      setIsoValue(nextIso);
    },
    [minIso, maxIso]
  );

  const focusSliderNormalized = useMemo(() => {
    return Math.max(0, Math.min(1, focusDiopters / maxFocusDiopters));
  }, [focusDiopters, maxFocusDiopters]);

  const handleFocusSliderChange = useCallback(
    (norm: number) => {
      setManualFocus(true);
      setFocusDiopters(Number((norm * maxFocusDiopters).toFixed(2)));
    },
    [maxFocusDiopters]
  );

  const handleLockInfinity = useCallback(() => {
    setManualFocus(true);
    setFocusDiopters(0.0);
  }, []);

  const handleCapturePhoto = useCallback(async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    try {
      const res = await captureProPhoto();
      setLastCapture(res);
    } catch (err: any) {
      Alert.alert('Capture Error', err?.message ?? 'Failed to capture Pro photo.');
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing]);

  const cycleGridMode = useCallback(() => {
    setGridMode((prev) =>
      prev === 'THIRDS' ? 'GOLDEN' : prev === 'GOLDEN' ? 'OFF' : 'THIRDS'
    );
  }, []);

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={54} color="#F59E0B" />
        <Text style={styles.permTitle}>Camera2 Hardware Access Required</Text>
        <Text style={styles.permDesc}>
          Pro Mode requires direct access to your handset’s Camera2 pipeline to control shutter
          time in nanoseconds, ISO gain, diopter focus, and uncompressed 16-bit DNG output.
        </Text>
        <Pressable style={styles.permBtn} onPress={requestCameraPermissions}>
          <Text style={styles.permBtnText}>Grant Camera Permission</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Top Viewfinder HUD Bar */}
      <View style={styles.topHudBar}>
        <View style={styles.topTelemetryGroup}>
          <View style={styles.hudPill}>
            <Text style={styles.hudPillLabel}>SHUTTER</Text>
            <Text style={[styles.hudPillValue, manualExposure && styles.hudPillManual]}>
              {manualExposure
                ? formatExposureNs(exposureTimeNs)
                : liveTelemetry?.shutterFormatted ?? 'AUTO'}
            </Text>
          </View>
          <View style={styles.hudPill}>
            <Text style={styles.hudPillLabel}>ISO</Text>
            <Text style={[styles.hudPillValue, manualIso && styles.hudPillManual]}>
              {manualIso ? isoValue : liveTelemetry?.iso ?? 'AUTO'}
            </Text>
          </View>
          <View style={styles.hudPill}>
            <Text style={styles.hudPillLabel}>FOCUS</Text>
            <Text style={[styles.hudPillValue, manualFocus && styles.hudPillManual]}>
              {manualFocus
                ? focusDiopters === 0
                  ? '∞ (0.0D)'
                  : `${focusDiopters.toFixed(1)}D`
                : 'AF-C'}
            </Text>
          </View>
        </View>

        <View style={styles.topActionsGroup}>
          <Pressable
            style={[
              styles.hudIconBtn,
              enableRawDng && activeSensor?.supportsRaw && styles.hudIconBtnActive,
            ]}
            onPress={() => setEnableRawDng((v) => !v)}
          >
            <Text
              style={[
                styles.rawBadgeText,
                enableRawDng && activeSensor?.supportsRaw && styles.rawBadgeTextActive,
              ]}
            >
              {activeSensor?.supportsRaw
                ? enableRawDng
                  ? 'RAW+JPG'
                  : 'JPG ONLY'
                : 'JPG'}
            </Text>
          </Pressable>

          <Pressable style={styles.hudIconBtn} onPress={cycleGridMode}>
            <MaterialCommunityIcons
              name="grid"
              size={16}
              color={gridMode !== 'OFF' ? '#F59E0B' : '#64748B'}
            />
            <Text style={styles.hudMiniText}>{gridMode}</Text>
          </Pressable>

          <Pressable
            style={styles.hudIconBtn}
            onPress={() => setShowSpiritLevel((v) => !v)}
          >
            <MaterialCommunityIcons
              name="spirit-level"
              size={16}
              color={showSpiritLevel ? '#10B981' : '#64748B'}
            />
          </Pressable>
        </View>
      </View>

      {/* Live Native Camera2 Viewfinder Surface */}
      <View style={styles.viewfinderContainer}>
        <NativeCameraEngineView
          style={styles.cameraSurface}
          cameraId={selectedCameraId}
          active={isScreenFocused}
          manualExposure={manualExposure}
          exposureTimeNs={exposureTimeNs}
          manualIso={manualIso}
          isoValue={isoValue}
          manualFocus={manualFocus}
          focusDistanceDiopters={focusDiopters}
          manualWhiteBalance={manualWb}
          wbKelvin={wbKelvin}
          wbTint={wbTint}
          enableRawDng={enableRawDng}
          zoomRatio={1.0}
        />

        {/* Rule-of-Thirds or Golden Ratio Grid Overlay */}
        {gridMode !== 'OFF' && (
          <View style={styles.gridOverlay} pointerEvents="none">
            <View
              style={[
                styles.gridLineV,
                { left: gridMode === 'THIRDS' ? '33.33%' : '38.2%' },
              ]}
            />
            <View
              style={[
                styles.gridLineV,
                { left: gridMode === 'THIRDS' ? '66.66%' : '61.8%' },
              ]}
            />
            <View
              style={[
                styles.gridLineH,
                { top: gridMode === 'THIRDS' ? '33.33%' : '38.2%' },
              ]}
            />
            <View
              style={[
                styles.gridLineH,
                { top: gridMode === 'THIRDS' ? '66.66%' : '61.8%' },
              ]}
            />
          </View>
        )}

        {/* Digital Spirit Level Overlay */}
        {showSpiritLevel && motion && (
          <View style={styles.spiritLevelOverlay} pointerEvents="none">
            <View
              style={[
                styles.spiritHorizonBar,
                {
                  transform: [{ rotate: `${-motion.rollDeg}deg` }],
                  borderColor: motion.isLevel ? '#10B981' : 'rgba(248, 250, 252, 0.55)',
                },
              ]}
            />
            <View
              style={[
                styles.spiritReadoutPill,
                motion.isLevel && styles.spiritReadoutPillLevel,
              ]}
            >
              <Text
                style={[
                  styles.spiritReadoutText,
                  motion.isLevel && { color: '#10B981' },
                ]}
              >
                {motion.isLevel
                  ? `LEVEL 0.0°`
                  : `ROLL ${motion.rollDeg > 0 ? '+' : ''}${motion.rollDeg.toFixed(1)}° • PITCH ${motion.pitchDeg.toFixed(0)}°`}
              </Text>
            </View>
          </View>
        )}

        {/* Live YUV Luminance / RGB Histogram HUD */}
        {histogram && (
          <Pressable
            style={styles.histogramBox}
            onPress={() => setShowRgbHistogram((v) => !v)}
          >
            <View style={styles.histogramHeader}>
              <Text style={styles.histogramTitle}>
                {showRgbHistogram ? 'RGB + Y HISTOGRAM' : 'LUMA HISTOGRAM'}
              </Text>
              <Text style={styles.histogramClipText}>
                HI {histogram.highlightClipPct.toFixed(1)}%
              </Text>
            </View>

            <View style={styles.histogramBarsRow}>
              {histogram.luma.map((lumaVal, idx) => {
                const rVal = histogram.red[idx] ?? 0;
                const gVal = histogram.green[idx] ?? 0;
                const bVal = histogram.blue[idx] ?? 0;
                return (
                  <View key={idx} style={styles.histBarCol}>
                    {showRgbHistogram ? (
                      <>
                        <View
                          style={[
                            styles.histRgbSlice,
                            {
                              height: `${Math.min(100, rVal)}%`,
                              backgroundColor: 'rgba(239, 68, 68, 0.55)',
                            },
                          ]}
                        />
                        <View
                          style={[
                            styles.histRgbSlice,
                            {
                              height: `${Math.min(100, gVal)}%`,
                              backgroundColor: 'rgba(16, 185, 129, 0.55)',
                            },
                          ]}
                        />
                        <View
                          style={[
                            styles.histRgbSlice,
                            {
                              height: `${Math.min(100, bVal)}%`,
                              backgroundColor: 'rgba(56, 189, 248, 0.55)',
                            },
                          ]}
                        />
                      </>
                    ) : null}
                    <View
                      style={[
                        styles.histLumaBar,
                        { height: `${Math.max(4, Math.min(100, lumaVal))}%` },
                      ]}
                    />
                  </View>
                );
              })}
            </View>
          </Pressable>
        )}

        {/* Quick Infinity Focus Lock Badge on Viewfinder */}
        <Pressable
          style={[
            styles.infinityFloatingBtn,
            manualFocus && focusDiopters === 0 && styles.infinityFloatingBtnActive,
          ]}
          onPress={handleLockInfinity}
        >
          <Ionicons
            name="infinite"
            size={18}
            color={manualFocus && focusDiopters === 0 ? '#07090D' : '#F8FAFC'}
          />
          <Text
            style={[
              styles.infinityFloatingText,
              manualFocus && focusDiopters === 0 && styles.infinityFloatingTextActive,
            ]}
          >
            {manualFocus && focusDiopters === 0 ? '∞ Locked' : 'Lock ∞'}
          </Text>
        </Pressable>

        {/* Bottom-left Session Status & Last Capture Toast */}
        <View style={styles.viewfinderFooterStrip}>
          <Text style={styles.statusSmallText} numberOfLines={1}>
            {lastCapture
              ? `Saved to ${lastCapture.albumPath} (${lastCapture.shutterFormatted} • ISO ${lastCapture.iso}${
                  lastCapture.savedDng ? ' + 16-bit DNG' : ''
                })`
              : statusMessage}
          </Text>
        </View>
      </View>

      {/* Physical Lens Switcher Row */}
      <View style={styles.lensSwitcherBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.lensScrollContent}
        >
          {sensors.map((sensor) => {
            const selected = sensor.cameraId === selectedCameraId;
            return (
              <Pressable
                key={sensor.cameraId}
                onPress={() => setSelectedCameraId(sensor.cameraId)}
                style={[styles.lensBtn, selected && styles.lensBtnActive]}
              >
                <Text style={[styles.lensBtnText, selected && styles.lensBtnTextActive]}>
                  ID {sensor.cameraId} • {sensor.facing}{' '}
                  {sensor.equivFocalLength35mm > 0
                    ? `${Math.round(sensor.equivFocalLength35mm)}mm`
                    : `${sensor.megapixels}MP`}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Manual Control Deck */}
      <View style={styles.controlDeck}>
        {/* Parameter Selector Tabs */}
        <View style={styles.paramTabRow}>
          {(
            [
              { key: 'SHUTTER', label: 'SHUTTER', isManual: manualExposure },
              { key: 'ISO', label: 'ISO GAIN', isManual: manualIso },
              { key: 'FOCUS', label: 'FOCUS (D)', isManual: manualFocus },
              { key: 'WB', label: 'KELVIN WB', isManual: manualWb },
            ] as const
          ).map((tab) => {
            const active = activeControlTab === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveControlTab(tab.key)}
                style={[styles.paramTabBtn, active && styles.paramTabBtnActive]}
              >
                <Text
                  style={[styles.paramTabText, active && styles.paramTabTextActive]}
                >
                  {tab.label}
                </Text>
                <View
                  style={[
                    styles.modeIndicatorDot,
                    { backgroundColor: tab.isManual ? '#F59E0B' : '#38BDF8' },
                  ]}
                />
              </Pressable>
            );
          })}
        </View>

        {/* Active Parameter Dial & Auto/Manual Toggle */}
        <View style={styles.activeDialBox}>
          {activeControlTab === 'SHUTTER' && (
            <>
              <View style={styles.dialHeaderRow}>
                <Text style={styles.dialTitle}>
                  Shutter Speed:{' '}
                  <Text style={styles.dialValueAccent}>
                    {manualExposure
                      ? formatExposureNs(exposureTimeNs)
                      : `Auto (${liveTelemetry?.shutterFormatted ?? '1/60s'})`}
                  </Text>
                </Text>
                <Pressable
                  style={[
                    styles.autoManualToggle,
                    manualExposure && styles.autoManualToggleActive,
                  ]}
                  onPress={() => setManualExposure((v) => !v)}
                >
                  <Text
                    style={[
                      styles.autoManualText,
                      manualExposure && styles.autoManualTextActive,
                    ]}
                  >
                    {manualExposure ? 'MANUAL' : 'AUTO AE'}
                  </Text>
                </Pressable>
              </View>
              <PrecisionSlider
                value={shutterSliderNormalized}
                onChange={handleShutterSliderChange}
                leftLabel={activeSensor?.minExposureFormatted ?? 'Min'}
                rightLabel={activeSensor?.maxExposureFormatted ?? 'Max'}
              />
            </>
          )}

          {activeControlTab === 'ISO' && (
            <>
              <View style={styles.dialHeaderRow}>
                <Text style={styles.dialTitle}>
                  Sensor Sensitivity:{' '}
                  <Text style={styles.dialValueAccent}>
                    {manualIso
                      ? `ISO ${isoValue}`
                      : `Auto (ISO ${liveTelemetry?.iso ?? 200})`}
                  </Text>
                </Text>
                <Pressable
                  style={[
                    styles.autoManualToggle,
                    manualIso && styles.autoManualToggleActive,
                  ]}
                  onPress={() => setManualIso((v) => !v)}
                >
                  <Text
                    style={[
                      styles.autoManualText,
                      manualIso && styles.autoManualTextActive,
                    ]}
                  >
                    {manualIso ? 'MANUAL' : 'AUTO ISO'}
                  </Text>
                </Pressable>
              </View>
              <PrecisionSlider
                value={isoSliderNormalized}
                onChange={handleIsoSliderChange}
                leftLabel={`ISO ${minIso}`}
                rightLabel={`ISO ${maxIso}`}
              />
            </>
          )}

          {activeControlTab === 'FOCUS' && (
            <>
              <View style={styles.dialHeaderRow}>
                <Text style={styles.dialTitle}>
                  Optical Focus:{' '}
                  <Text style={styles.dialValueAccent}>
                    {manualFocus
                      ? focusDiopters === 0
                        ? '0.00 D (True Infinity ∞)'
                        : `${focusDiopters.toFixed(2)} D (${(100 / focusDiopters).toFixed(1)} cm)`
                      : 'Continuous AF'}
                  </Text>
                </Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Pressable
                    style={styles.infinityQuickBtn}
                    onPress={handleLockInfinity}
                  >
                    <Text style={styles.infinityQuickBtnText}>∞ Infinity</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.autoManualToggle,
                      manualFocus && styles.autoManualToggleActive,
                    ]}
                    onPress={() => setManualFocus((v) => !v)}
                  >
                    <Text
                      style={[
                        styles.autoManualText,
                        manualFocus && styles.autoManualTextActive,
                      ]}
                    >
                      {manualFocus ? 'MF' : 'AF-C'}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <PrecisionSlider
                value={focusSliderNormalized}
                onChange={handleFocusSliderChange}
                leftLabel="0.0 D (Infinity ∞)"
                rightLabel={`${maxFocusDiopters.toFixed(1)} D (Macro)`}
              />
            </>
          )}

          {activeControlTab === 'WB' && (
            <>
              <View style={styles.dialHeaderRow}>
                <Text style={styles.dialTitle}>
                  White Balance:{' '}
                  <Text style={styles.dialValueAccent}>
                    {manualWb ? `${wbKelvin}K (Tint ${wbTint >= 0 ? '+' : ''}${wbTint})` : 'Auto AWB'}
                  </Text>
                </Text>
                <Pressable
                  style={[
                    styles.autoManualToggle,
                    manualWb && styles.autoManualToggleActive,
                  ]}
                  onPress={() => setManualWb((v) => !v)}
                >
                  <Text
                    style={[
                      styles.autoManualText,
                      manualWb && styles.autoManualTextActive,
                    ]}
                  >
                    {manualWb ? 'MANUAL WB' : 'AUTO AWB'}
                  </Text>
                </Pressable>
              </View>
              <PrecisionSlider
                value={(wbKelvin - 2000) / 8000}
                onChange={(norm) => {
                  setManualWb(true);
                  setWbKelvin(Math.round(2000 + norm * 8000));
                }}
                leftLabel="2000K Warm"
                rightLabel="10000K Cool"
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.wbPresetsRow}
              >
                {WB_PRESETS.map((preset) => (
                  <Pressable
                    key={preset.kelvin}
                    style={[
                      styles.wbPresetChip,
                      manualWb && wbKelvin === preset.kelvin && styles.wbPresetChipActive,
                    ]}
                    onPress={() => {
                      setManualWb(true);
                      setWbKelvin(preset.kelvin);
                    }}
                  >
                    <Text style={styles.wbPresetText}>{preset.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
        </View>

        {/* Shutter Release Row */}
        <View style={styles.shutterRow}>
          <Pressable
            style={styles.resetAllBtn}
            onPress={() => {
              setManualExposure(false);
              setManualIso(false);
              setManualFocus(false);
              setManualWb(false);
            }}
          >
            <Ionicons name="refresh-outline" size={16} color="#94A3B8" />
            <Text style={styles.resetAllText}>Reset Auto</Text>
          </Pressable>

          <Pressable
            style={[styles.shutterOuterRing, isCapturing && { opacity: 0.6 }]}
            onPress={handleCapturePhoto}
            disabled={isCapturing}
          >
            <View style={styles.shutterInnerButton}>
              {isCapturing ? (
                <ActivityIndicator color="#07090D" size="small" />
              ) : (
                <Text style={styles.shutterButtonLabel}>
                  {enableRawDng && activeSensor?.supportsRaw ? 'RAW' : 'PRO'}
                </Text>
              )}
            </View>
          </Pressable>

          <View style={styles.formatReadoutBox}>
            <Text style={styles.formatReadoutTop}>OUTPUT</Text>
            <Text style={styles.formatReadoutBottom}>
              {enableRawDng && activeSensor?.supportsRaw ? 'DNG + JPG' : 'JPEG 98%'}
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#05070B',
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: '#07090D',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  permTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  permDesc: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 8,
  },
  permBtn: {
    marginTop: 20,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  permBtnText: {
    color: '#07090D',
    fontWeight: '800',
    fontSize: 14,
  },
  topHudBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0A0D14',
    borderBottomWidth: 1,
    borderBottomColor: '#172030',
  },
  topTelemetryGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  hudPill: {
    backgroundColor: '#111723',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  hudPillLabel: {
    color: '#64748B',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  hudPillValue: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 1,
  },
  hudPillManual: {
    color: '#F59E0B',
  },
  topActionsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hudIconBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#111723',
    borderWidth: 1,
    borderColor: '#1E293B',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  hudIconBtnActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#F59E0B',
  },
  rawBadgeText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
  },
  rawBadgeTextActive: {
    color: '#FBBF24',
  },
  hudMiniText: {
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '800',
  },
  viewfinderContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  cameraSurface: {
    flex: 1,
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(248, 250, 252, 0.24)',
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(248, 250, 252, 0.24)',
  },
  spiritLevelOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spiritHorizonBar: {
    width: 128,
    height: 0,
    borderTopWidth: 2,
  },
  spiritReadoutPill: {
    marginTop: 10,
    backgroundColor: 'rgba(7, 9, 13, 0.72)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.3)',
  },
  spiritReadoutPillLevel: {
    borderColor: '#10B981',
  },
  spiritReadoutText: {
    color: '#E2E8F0',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  histogramBox: {
    position: 'absolute',
    top: 10,
    left: 10,
    width: 146,
    backgroundColor: 'rgba(7, 9, 13, 0.78)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    padding: 7,
  },
  histogramHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  histogramTitle: {
    color: '#94A3B8',
    fontSize: 8,
    fontWeight: '800',
  },
  histogramClipText: {
    color: '#F59E0B',
    fontSize: 8,
    fontWeight: '800',
  },
  histogramBarsRow: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  histBarCol: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    position: 'relative',
  },
  histRgbSlice: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  histLumaBar: {
    width: '100%',
    backgroundColor: 'rgba(248, 250, 252, 0.75)',
    borderRadius: 1,
  },
  infinityFloatingBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(13, 18, 27, 0.85)',
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 20,
  },
  infinityFloatingBtnActive: {
    backgroundColor: '#F59E0B',
    borderColor: '#F59E0B',
  },
  infinityFloatingText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '800',
  },
  infinityFloatingTextActive: {
    color: '#07090D',
  },
  viewfinderFooterStrip: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(7, 9, 13, 0.72)',
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  statusSmallText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '600',
  },
  lensSwitcherBar: {
    backgroundColor: '#0A0D14',
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: '#161F2E',
  },
  lensScrollContent: {
    paddingHorizontal: 12,
    gap: 8,
  },
  lensBtn: {
    backgroundColor: '#111723',
    borderWidth: 1,
    borderColor: '#1F2A3C',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
  },
  lensBtnActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#F59E0B',
  },
  lensBtnText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  lensBtnTextActive: {
    color: '#FBBF24',
    fontWeight: '800',
  },
  controlDeck: {
    backgroundColor: '#0A0D12',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#192231',
  },
  paramTabRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  paramTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#111723',
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1D2636',
  },
  paramTabBtnActive: {
    backgroundColor: '#182132',
    borderColor: '#F59E0B',
  },
  paramTabText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
  },
  paramTabTextActive: {
    color: '#F8FAFC',
  },
  modeIndicatorDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  activeDialBox: {
    minHeight: 74,
    justifyContent: 'center',
  },
  dialHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  dialTitle: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '700',
  },
  dialValueAccent: {
    color: '#F59E0B',
    fontWeight: '800',
  },
  autoManualToggle: {
    backgroundColor: '#161F2E',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#293548',
  },
  autoManualToggleActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderColor: '#F59E0B',
  },
  autoManualText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
  },
  autoManualTextActive: {
    color: '#FBBF24',
  },
  infinityQuickBtn: {
    backgroundColor: '#17253B',
    borderWidth: 1,
    borderColor: '#38BDF8',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
  },
  infinityQuickBtnText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
  },
  wbPresetsRow: {
    gap: 6,
    marginTop: 6,
  },
  wbPresetChip: {
    backgroundColor: '#121824',
    borderWidth: 1,
    borderColor: '#222E42',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
  },
  wbPresetChipActive: {
    borderColor: '#F59E0B',
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
  },
  wbPresetText: {
    color: '#CBD5E1',
    fontSize: 10,
    fontWeight: '700',
  },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  resetAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#121824',
    borderWidth: 1,
    borderColor: '#1F2A3C',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    minWidth: 96,
  },
  resetAllText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  shutterOuterRing: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 3,
    borderColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  shutterInnerButton: {
    width: '100%',
    height: '100%',
    borderRadius: 30,
    backgroundColor: '#F59E0B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterButtonLabel: {
    color: '#07090D',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  formatReadoutBox: {
    minWidth: 96,
    alignItems: 'flex-end',
  },
  formatReadoutTop: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '800',
  },
  formatReadoutBottom: {
    color: '#10B981',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
});
