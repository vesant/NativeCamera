import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import {
  CameraSensorCharacteristics,
  inspectDeviceCameras,
} from '@/native/CameraInspector';
import {
  CameraHistogramPayload,
  CameraLiveTelemetry,
  formatExposureNs,
  MotionTelemetry,
  NativeCameraEngineView,
  pauseVideoRecording,
  resumeVideoRecording,
  startMotionSensors,
  startVideoRecording,
  stopMotionSensors,
  stopVideoRecording,
  subscribeCameraStatus,
  subscribeHistogram,
  subscribeMotionTelemetry,
  subscribeTelemetry,
  VideoStopResult,
} from '@/native/CameraEngine';
import { PrecisionSlider } from '@/components/PrecisionSlider';
import { CameraRollPreviewButton } from '@/components/MediaPreviewModal';

type ControlTab = 'CODEC' | 'SHUTTER' | 'ISO' | 'FOCUS' | 'WB';
type AspectGuide = 'NONE' | '16:9' | '2.39:1';

const WB_PRESETS = [
  { label: 'Tungsten', kelvin: 3200 },
  { label: 'Fluorescent', kelvin: 4300 },
  { label: 'Daylight', kelvin: 5600 },
  { label: 'Shade', kelvin: 7000 },
];

function formatTimecode(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

export default function CinemaVideoScreen() {
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [hasAudioPermission, setHasAudioPermission] = useState<boolean>(false);
  const [checkingPermission, setCheckingPermission] = useState<boolean>(true);

  const [sensors, setSensors] = useState<CameraSensorCharacteristics[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('0');

  // Cinema Recording Parameters
  const [resolutionPreset, setResolutionPreset] = useState<'4K' | '1080P' | '720P'>('1080P');
  const [fps, setFps] = useState<24 | 30 | 60>(24);
  const [bitrateMbps, setBitrateMbps] = useState<number>(50);
  const [enableAudio, setEnableAudio] = useState<boolean>(true);
  const [enableStabilization, setEnableStabilization] = useState<boolean>(true);
  const [shutterAngle180Lock, setShutterAngle180Lock] = useState<boolean>(true);

  // Manual Camera2 Overrides (adjustable live before AND during recording)
  const [manualExposure, setManualExposure] = useState<boolean>(true);
  const [exposureTimeNs, setExposureTimeNs] = useState<number>(20_833_333); // 1/48s for 24fps 180-deg shutter
  const [manualIso, setManualIso] = useState<boolean>(false);
  const [isoValue, setIsoValue] = useState<number>(400);
  const [manualFocus, setManualFocus] = useState<boolean>(false);
  const [focusDiopters, setFocusDiopters] = useState<number>(0.0);
  // Rack Focus A/B stored diopter targets
  const [focusPointA, setFocusPointA] = useState<number>(0.0);
  const [focusPointB, setFocusPointB] = useState<number>(2.5);
  const [manualWb, setManualWb] = useState<boolean>(false);
  const [wbKelvin, setWbKelvin] = useState<number>(5600);
  const [wbTint] = useState<number>(0);

  // Viewfinder Overlays
  const [activeTab, setActiveTab] = useState<ControlTab>('CODEC');
  const [aspectGuide, setAspectGuide] = useState<AspectGuide>('2.39:1');
  const [showHistogram, setShowHistogram] = useState<boolean>(true);

  // Recording State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [activeStreamSpec, setActiveStreamSpec] = useState<string>('');
  const [lastSavedVideo, setLastSavedVideo] = useState<VideoStopResult | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Live Telemetry
  const [telemetry, setTelemetry] = useState<CameraLiveTelemetry | null>(null);
  const [histogram, setHistogram] = useState<CameraHistogramPayload | null>(null);
  const [motion, setMotion] = useState<MotionTelemetry | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => {
        setIsFocused(false);
      };
    }, [])
  );

  useEffect(() => {
    async function initPermissionsAndSensors() {
      setCheckingPermission(true);
      try {
        if (Platform.OS === 'android') {
          const camGranted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.CAMERA,
            {
              title: 'Camera Hardware Permission',
              message:
                'NativeCamera requires direct Camera2 access for Cinema Video recording.',
              buttonPositive: 'Grant',
            }
          );
          const micGranted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: 'Microphone Permission',
              message:
                'NativeCamera uses the microphone to record 48kHz AAC audio in Cinema Record Mode.',
              buttonPositive: 'Grant',
            }
          );
          setHasPermission(camGranted === PermissionsAndroid.RESULTS.GRANTED);
          setHasAudioPermission(micGranted === PermissionsAndroid.RESULTS.GRANTED);
        } else {
          setHasPermission(true);
          setHasAudioPermission(true);
        }

        const report = await inspectDeviceCameras();
        setSensors(report.sensors);
        const primaryBack =
          report.sensors.find(
            (c: CameraSensorCharacteristics) => c.facing === 'Back'
          ) ?? report.sensors[0];
        if (primaryBack) {
          setSelectedCameraId(primaryBack.cameraId);
          if (primaryBack.minFocusDistanceDiopters > 0) {
            setFocusPointB(
              Math.min(3.5, Number((primaryBack.minFocusDistanceDiopters * 0.4).toFixed(2)))
            );
          }
        }
      } catch (e: any) {
        setCameraError(e?.message ?? 'Failed initializing cinema video engine.');
      } finally {
        setCheckingPermission(false);
      }
    }
    initPermissionsAndSensors();
  }, []);

  useEffect(() => {
    if (!isFocused) return;

    startMotionSensors().catch(() => {});
    const histSub = subscribeHistogram((data) => setHistogram(data));
    const telSub = subscribeTelemetry((data) => setTelemetry(data));
    const motionSub = subscribeMotionTelemetry((data) => setMotion(data));
    const statusSub = subscribeCameraStatus((evt) => {
      if (evt.status === 'error') {
        setCameraError(evt.message);
      } else if (evt.status === 'ready') {
        setCameraError(null);
      }
    });

    return () => {
      histSub.remove();
      telSub.remove();
      motionSub.remove();
      statusSub.remove();
      stopMotionSensors().catch(() => {});
    };
  }, [isFocused]);

  // Recording timecode interval
  useEffect(() => {
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => {
        setElapsedSec((prev) => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRecording, isPaused]);

  const activeSensor: CameraSensorCharacteristics | undefined = useMemo(
    () => sensors.find((s) => s.cameraId === selectedCameraId) ?? sensors[0],
    [sensors, selectedCameraId]
  );

  // Enforce 180-degree shutter rule: ExposureTime = 1 / (2 * fps)
  const apply180DegreeShutterForFps = (targetFps: 24 | 30 | 60) => {
    const idealShutterNs = Math.round(1_000_000_000 / (targetFps * 2));
    setManualExposure(true);
    setExposureTimeNs(idealShutterNs);
  };

  const handleSelectFps = (nextFps: 24 | 30 | 60) => {
    setFps(nextFps);
    if (shutterAngle180Lock) {
      apply180DegreeShutterForFps(nextFps);
    }
  };

  const toggle180ShutterLock = () => {
    const nextLock = !shutterAngle180Lock;
    setShutterAngle180Lock(nextLock);
    if (nextLock) {
      apply180DegreeShutterForFps(fps);
    }
  };

  // Logarithmic mapping for video shutter speed (from minNs up to 1/fps frame period)
  const minExpNs = Math.max(activeSensor?.minExposureNs ?? 100_000, 50_000);
  const maxFramePeriodNs = Math.round(1_000_000_000 / fps);
  const logMin = Math.log(minExpNs);
  const logMax = Math.log(maxFramePeriodNs);

  const shutterNorm = useMemo(() => {
    const clamped = Math.min(Math.max(exposureTimeNs, minExpNs), maxFramePeriodNs);
    return (Math.log(clamped) - logMin) / Math.max(1e-6, logMax - logMin);
  }, [exposureTimeNs, minExpNs, maxFramePeriodNs, logMin, logMax]);

  const handleShutterSlider = (norm: number) => {
    const ns = Math.round(Math.exp(logMin + norm * (logMax - logMin)));
    setShutterAngle180Lock(false);
    setManualExposure(true);
    setExposureTimeNs(ns);
  };

  const minIso = activeSensor?.minIso ?? 50;
  const maxIso = Math.min(activeSensor?.maxIso ?? 6400, 6400);
  const maxFocusDiopters = Math.max(
    activeSensor?.minFocusDistanceDiopters ?? 10.0,
    0.1
  );

  const handleToggleRecord = async () => {
    if (!isRecording) {
      try {
        setLastSavedVideo(null);
        setElapsedSec(0);
        const startRes = await startVideoRecording({
          resolutionPreset,
          fps,
          bitrateMbps,
          enableAudio: enableAudio && hasAudioPermission,
          enableStabilization,
        });
        setIsRecording(true);
        setIsPaused(false);
        setActiveStreamSpec(
          `${startRes.resolution} @ ${startRes.fps}fps • ${startRes.bitrateMbps} Mbps`
        );
      } catch (e: any) {
        Alert.alert('Video Recording Error', e?.message ?? 'Could not start video recording.');
      }
    } else {
      try {
        const stopRes = await stopVideoRecording();
        setIsRecording(false);
        setIsPaused(false);
        setLastSavedVideo(stopRes);
      } catch (e: any) {
        setIsRecording(false);
        setIsPaused(false);
        Alert.alert('Stop Recording Error', e?.message ?? 'Failed finalizing MP4 video.');
      }
    }
  };

  const handleTogglePause = async () => {
    if (!isRecording) return;
    try {
      if (!isPaused) {
        const ok = await pauseVideoRecording();
        if (ok) setIsPaused(true);
      } else {
        const ok = await resumeVideoRecording();
        if (ok) setIsPaused(false);
      }
    } catch (e: any) {
      Alert.alert('Pause/Resume Error', e?.message ?? 'Operation not supported.');
    }
  };

  if (checkingPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#EF4444" />
        <Text style={styles.loadingText}>Initializing Cinema Record Engine...</Text>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <Ionicons name="videocam-off-outline" size={48} color="#EF4444" />
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionBody}>
          Cinema Record Mode needs hardware Camera2 access to stream H.264/AAC video.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Live Camera2 Viewfinder */}
      <View style={styles.viewfinderContainer}>
        {isFocused ? (
          <NativeCameraEngineView
            style={styles.cameraSurface}
            cameraId={selectedCameraId}
            active={isFocused}
            manualExposure={manualExposure}
            exposureTimeNs={exposureTimeNs}
            manualIso={manualIso}
            isoValue={isoValue}
            manualFocus={manualFocus}
            focusDistanceDiopters={focusDiopters}
            manualWhiteBalance={manualWb}
            wbKelvin={wbKelvin}
            wbTint={wbTint}
            enableRawDng={false}
            zoomRatio={1.0}
          />
        ) : (
          <View style={styles.cameraSurface} />
        )}

        {/* Cinema Aspect Ratio Letterbox Guides (2.39:1 Anamorphic or 16:9) */}
        {aspectGuide !== 'NONE' && (
          <View style={styles.overlayFill} pointerEvents="none">
            <View
              style={[
                styles.letterboxBarTop,
                aspectGuide === '2.39:1' ? { height: '16%' } : { height: '8%' },
              ]}
            />
            <View style={styles.aspectGuideLabelWrap}>
              <Text style={styles.aspectGuideLabel}>{aspectGuide} CINEMA GUIDE</Text>
            </View>
            <View
              style={[
                styles.letterboxBarBottom,
                aspectGuide === '2.39:1' ? { height: '16%' } : { height: '8%' },
              ]}
            />
          </View>
        )}

        {/* Top HUD: Recording Timecode + Live Exposure Readout + Overlays */}
        <View style={styles.topHud}>
          <View style={styles.hudReadoutPill}>
            <View
              style={[
                styles.recDot,
                isRecording
                  ? isPaused
                    ? { backgroundColor: '#F59E0B' }
                    : { backgroundColor: '#EF4444' }
                  : { backgroundColor: '#64748B' },
              ]}
            />
            <Text style={[styles.timecodeText, isRecording && { color: '#F87171' }]}>
              {isRecording ? (isPaused ? 'PAUSED ' : 'REC ') : 'STBY '}
              {formatTimecode(elapsedSec)}
            </Text>
            <Text style={styles.hudDivider}>•</Text>
            <Text style={styles.hudMetricText}>
              {manualExposure
                ? formatExposureNs(exposureTimeNs)
                : telemetry?.shutterFormatted ?? 'Auto'}
            </Text>
            <Text style={styles.hudDivider}>•</Text>
            <Text style={styles.hudMetricText}>
              ISO {manualIso ? isoValue : telemetry?.iso ?? '--'}
            </Text>
          </View>

          <View style={styles.hudQuickButtons}>
            <Pressable
              style={[
                styles.iconToggleBtn,
                aspectGuide !== 'NONE' && styles.iconToggleBtnActive,
              ]}
              onPress={() =>
                setAspectGuide((prev) =>
                  prev === '2.39:1' ? '16:9' : prev === '16:9' ? 'NONE' : '2.39:1'
                )
              }
            >
              <Ionicons name="film-outline" size={16} color="#F8FAFC" />
            </Pressable>
            <Pressable
              style={[styles.iconToggleBtn, showHistogram && styles.iconToggleBtnActive]}
              onPress={() => setShowHistogram((v) => !v)}
            >
              <Ionicons name="stats-chart" size={16} color="#F8FAFC" />
            </Pressable>
          </View>
        </View>

        {/* Live YUV Histogram + Spirit Level */}
        {showHistogram && histogram && (
          <View style={styles.histogramCard} pointerEvents="none">
            <View style={styles.histogramHeader}>
              <Text style={styles.histogramTitle}>CINEMA LUMA</Text>
              <Text style={styles.histogramSub}>
                {motion ? `${motion.rollDeg.toFixed(1)}°` : '0.0°'} • Hi {histogram.highlightClipPct}%
              </Text>
            </View>
            <View style={styles.histogramBarsRow}>
              {histogram.luma.map((val, idx) => (
                <View key={idx} style={styles.histBarSlot}>
                  <View
                    style={[
                      styles.histBarLuma,
                      { height: `${Math.max(4, Math.min(100, val * 100))}%` },
                    ]}
                  />
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Active Stream Banner while recording */}
        {isRecording && activeStreamSpec ? (
          <View style={styles.streamSpecPill}>
            <Text style={styles.streamSpecText}>{activeStreamSpec}</Text>
          </View>
        ) : null}

        {/* Saved Video Toast */}
        {lastSavedVideo && !isRecording && (
          <View style={styles.captureToast}>
            <Ionicons name="videocam" size={16} color="#10B981" />
            <Text style={styles.captureToastText} numberOfLines={1}>
              Saved {lastSavedVideo.resolution} ({lastSavedVideo.durationSec}s •{' '}
              {lastSavedVideo.fileSizeMb} MB) to {lastSavedVideo.albumPath}
            </Text>
          </View>
        )}

        {cameraError && (
          <View style={styles.errorBanner}>
            <Ionicons name="warning" size={16} color="#FCA5A5" />
            <Text style={styles.errorBannerText}>{cameraError}</Text>
          </View>
        )}
      </View>

      {/* Bottom Cinema Controls */}
      <View style={styles.controlDeck}>
        {/* Lens Switcher (disabled while actively recording a stream) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.lensRow}
        >
          {sensors.map((sensor) => {
            const selected = sensor.cameraId === selectedCameraId;
            return (
              <Pressable
                key={sensor.cameraId}
                disabled={isRecording}
                onPress={() => setSelectedCameraId(sensor.cameraId)}
                style={[
                  styles.lensPill,
                  selected && styles.lensPillSelected,
                  isRecording && !selected && { opacity: 0.4 },
                ]}
              >
                <Text
                  style={[styles.lensPillText, selected && styles.lensPillTextSelected]}
                >
                  ID {sensor.cameraId} • {sensor.facing}{' '}
                  {sensor.focalLengthsMm[0]
                    ? `${sensor.focalLengthsMm[0].toFixed(1)}mm`
                    : ''}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Parameter Tab Selector */}
        <View style={styles.paramTabsRow}>
          {(
            [
              { key: 'CODEC', label: 'CODEC', val: `${resolutionPreset} ${fps}p` },
              {
                key: 'SHUTTER',
                label: 'SHUTTER',
                val: shutterAngle180Lock
                  ? `180° (1/${fps * 2}s)`
                  : manualExposure
                    ? formatExposureNs(exposureTimeNs)
                    : 'AUTO',
              },
              {
                key: 'ISO',
                label: 'ISO',
                val: manualIso ? `${isoValue}` : 'AUTO',
              },
              {
                key: 'FOCUS',
                label: 'RACK FOCUS',
                val: manualFocus ? `${focusDiopters.toFixed(1)} D` : 'AF-C',
              },
              {
                key: 'WB',
                label: 'KELVIN',
                val: manualWb ? `${wbKelvin}K` : 'AWB',
              },
            ] as { key: ControlTab; label: string; val: string }[]
          ).map((tab) => {
            const active = activeTab === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={[styles.paramTabBtn, active && styles.paramTabBtnActive]}
              >
                <Text style={[styles.paramTabLabel, active && styles.paramTabLabelActive]}>
                  {tab.label}
                </Text>
                <Text style={[styles.paramTabValue, active && styles.paramTabValueActive]}>
                  {tab.val}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Active Parameter Panel */}
        <View style={styles.sliderPanel}>
          {activeTab === 'CODEC' && (
            <View style={styles.codecPanel}>
              <View style={styles.codecRow}>
                <Text style={styles.codecLabel}>RES</Text>
                <View style={styles.chipGroup}>
                  {(['4K', '1080P', '720P'] as const).map((res) => (
                    <Pressable
                      key={res}
                      disabled={isRecording}
                      onPress={() => setResolutionPreset(res)}
                      style={[
                        styles.OptionChip,
                        resolutionPreset === res && styles.OptionChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.OptionChipText,
                          resolutionPreset === res && styles.OptionChipTextActive,
                        ]}
                      >
                        {res}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.codecLabel}>FPS</Text>
                <View style={styles.chipGroup}>
                  {([24, 30, 60] as const).map((rate) => (
                    <Pressable
                      key={rate}
                      disabled={isRecording}
                      onPress={() => handleSelectFps(rate)}
                      style={[styles.OptionChip, fps === rate && styles.OptionChipActive]}
                    >
                      <Text
                        style={[
                          styles.OptionChipText,
                          fps === rate && styles.OptionChipTextActive,
                        ]}
                      >
                        {rate}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.codecRow}>
                <Text style={styles.codecLabel}>Mbps</Text>
                <View style={styles.chipGroup}>
                  {[24, 50, 80].map((rate) => (
                    <Pressable
                      key={rate}
                      disabled={isRecording}
                      onPress={() => setBitrateMbps(rate)}
                      style={[
                        styles.OptionChip,
                        bitrateMbps === rate && styles.OptionChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.OptionChipText,
                          bitrateMbps === rate && styles.OptionChipTextActive,
                        ]}
                      >
                        {rate}M
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Pressable
                  disabled={isRecording}
                  onPress={() => setEnableAudio((v) => !v)}
                  style={[
                    styles.OptionChip,
                    enableAudio && hasAudioPermission && styles.OptionChipActive,
                  ]}
                >
                  <Ionicons
                    name={enableAudio ? 'mic' : 'mic-off'}
                    size={13}
                    color={enableAudio ? '#EF4444' : '#94A3B8'}
                  />
                  <Text
                    style={[
                      styles.OptionChipText,
                      enableAudio && styles.OptionChipTextActive,
                    ]}
                  >
                    AAC
                  </Text>
                </Pressable>

                <Pressable
                  disabled={isRecording}
                  onPress={() => setEnableStabilization((v) => !v)}
                  style={[
                    styles.OptionChip,
                    enableStabilization && styles.OptionChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.OptionChipText,
                      enableStabilization && styles.OptionChipTextActive,
                    ]}
                  >
                    OIS/EIS
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {activeTab === 'SHUTTER' && (
            <View>
              <View style={styles.modeToggleRow}>
                <Pressable
                  onPress={() => {
                    setShutterAngle180Lock(false);
                    setManualExposure((m) => !m);
                  }}
                  style={[
                    styles.autoManualBtn,
                    manualExposure && styles.autoManualBtnManual,
                  ]}
                >
                  <Text style={styles.autoManualBtnText}>
                    {manualExposure ? 'MANUAL SHUTTER' : 'AUTO EXPOSURE'}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={toggle180ShutterLock}
                  style={[
                    styles.infinityQuickBtn,
                    shutterAngle180Lock && styles.infinityQuickBtnActive,
                  ]}
                >
                  <Text style={styles.infinityQuickBtnText}>
                    180° Cinema Lock (1/{fps * 2}s)
                  </Text>
                </Pressable>
              </View>
              <PrecisionSlider
                leftLabel="Shutter Speed"
                rightLabel={formatExposureNs(exposureTimeNs)}
                value={shutterNorm}
                disabled={!manualExposure}
                accentColor="#EF4444"
                onChange={handleShutterSlider}
              />
            </View>
          )}

          {activeTab === 'ISO' && (
            <View>
              <View style={styles.modeToggleRow}>
                <Pressable
                  onPress={() => setManualIso((m) => !m)}
                  style={[styles.autoManualBtn, manualIso && styles.autoManualBtnManual]}
                >
                  <Text style={styles.autoManualBtnText}>
                    {manualIso ? 'MANUAL ISO' : 'AUTO ISO'}
                  </Text>
                </Pressable>
                <View style={styles.quickIsoRow}>
                  {[100, 400, 800, 1600, 3200]
                    .filter((v) => v >= minIso && v <= maxIso)
                    .map((presetIso) => (
                      <Pressable
                        key={presetIso}
                        onPress={() => {
                          setManualIso(true);
                          setIsoValue(presetIso);
                        }}
                        style={[
                          styles.presetChip,
                          manualIso && isoValue === presetIso && styles.presetChipActive,
                        ]}
                      >
                        <Text style={styles.presetChipText}>{presetIso}</Text>
                      </Pressable>
                    ))}
                </View>
              </View>
              <PrecisionSlider
                leftLabel="Sensor Gain (ISO)"
                rightLabel={`ISO ${isoValue}`}
                value={
                  (isoValue - minIso) / Math.max(1, maxIso - minIso)
                }
                disabled={!manualIso}
                accentColor="#EF4444"
                onChange={(norm) => {
                  setManualIso(true);
                  setIsoValue(Math.round(minIso + norm * (maxIso - minIso)));
                }}
              />
            </View>
          )}

          {activeTab === 'FOCUS' && (
            <View>
              <View style={styles.modeToggleRow}>
                <Pressable
                  onPress={() => setManualFocus((m) => !m)}
                  style={[styles.autoManualBtn, manualFocus && styles.autoManualBtnManual]}
                >
                  <Text style={styles.autoManualBtnText}>
                    {manualFocus ? 'MANUAL RACK' : 'CONTINUOUS AF'}
                  </Text>
                </Pressable>

                <View style={styles.quickIsoRow}>
                  <Pressable
                    onPress={() => {
                      setManualFocus(true);
                      setFocusDiopters(focusPointA);
                    }}
                    onLongPress={() => setFocusPointA(Number(focusDiopters.toFixed(2)))}
                    style={[
                      styles.presetChip,
                      manualFocus &&
                        Math.abs(focusDiopters - focusPointA) < 0.08 &&
                        styles.presetChipActive,
                    ]}
                  >
                    <Text style={styles.presetChipText}>A ({focusPointA}D)</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      setManualFocus(true);
                      setFocusDiopters(focusPointB);
                    }}
                    onLongPress={() => setFocusPointB(Number(focusDiopters.toFixed(2)))}
                    style={[
                      styles.presetChip,
                      manualFocus &&
                        Math.abs(focusDiopters - focusPointB) < 0.08 &&
                        styles.presetChipActive,
                    ]}
                  >
                    <Text style={styles.presetChipText}>B ({focusPointB}D)</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      setManualFocus(true);
                      setFocusDiopters(0.0);
                    }}
                    style={[
                      styles.presetChip,
                      manualFocus && focusDiopters === 0.0 && styles.presetChipActive,
                    ]}
                  >
                    <Text style={styles.presetChipText}>∞</Text>
                  </Pressable>
                </View>
              </View>
              <PrecisionSlider
                leftLabel="Rack Focus (Hold A/B to save)"
                rightLabel={
                  focusDiopters <= 0.05
                    ? '0.00 D (Infinity ∞)'
                    : `${focusDiopters.toFixed(2)} D`
                }
                value={focusDiopters / maxFocusDiopters}
                disabled={!manualFocus}
                accentColor="#EF4444"
                onChange={(norm) => {
                  setManualFocus(true);
                  setFocusDiopters(Number((norm * maxFocusDiopters).toFixed(2)));
                }}
              />
            </View>
          )}

          {activeTab === 'WB' && (
            <View>
              <View style={styles.modeToggleRow}>
                <Pressable
                  onPress={() => setManualWb((m) => !m)}
                  style={[styles.autoManualBtn, manualWb && styles.autoManualBtnManual]}
                >
                  <Text style={styles.autoManualBtnText}>
                    {manualWb ? 'MANUAL KELVIN' : 'AUTO WB'}
                  </Text>
                </Pressable>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.quickIsoRow}>
                    {WB_PRESETS.map((p) => (
                      <Pressable
                        key={p.label}
                        onPress={() => {
                          setManualWb(true);
                          setWbKelvin(p.kelvin);
                        }}
                        style={[
                          styles.presetChip,
                          manualWb && wbKelvin === p.kelvin && styles.presetChipActive,
                        ]}
                      >
                        <Text style={styles.presetChipText}>{p.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </View>
              <PrecisionSlider
                leftLabel="Color Temperature"
                rightLabel={`${wbKelvin} K`}
                value={(wbKelvin - 2200) / (9000 - 2200)}
                disabled={!manualWb}
                accentColor="#EF4444"
                onChange={(norm) => {
                  setManualWb(true);
                  setWbKelvin(Math.round((2200 + norm * (9000 - 2200)) / 50) * 50);
                }}
              />
            </View>
          )}
        </View>

        {/* Bottom Record Bar */}
        <View style={styles.shutterBar}>
          <View style={styles.formatToggleWrap}>
            {isRecording ? (
              <Pressable onPress={handleTogglePause} style={styles.pauseBtn}>
                <Ionicons
                  name={isPaused ? 'play' : 'pause'}
                  size={18}
                  color="#F8FAFC"
                />
                <Text style={styles.pauseBtnText}>
                  {isPaused ? 'RESUME' : 'PAUSE'}
                </Text>
              </Pressable>
            ) : (
              <View style={styles.standbyBadge}>
                <Text style={styles.standbyBadgeTitle}>H.264 MP4</Text>
                <Text style={styles.standbyBadgeSub}>
                  {resolutionPreset} • {fps}fps • {bitrateMbps}Mbps
                </Text>
              </View>
            )}
          </View>

          <Pressable onPress={handleToggleRecord} style={styles.recordOuterRing}>
            <View
              style={[
                styles.recordInnerCore,
                isRecording && styles.recordInnerCoreStop,
              ]}
            />
          </Pressable>

          <View style={[styles.metaReadoutRight, { alignItems: 'flex-end' }]}>
            <CameraRollPreviewButton size={52} disabled={isRecording} />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#070A10',
  },
  centered: {
    flex: 1,
    backgroundColor: '#070A10',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 12,
    fontSize: 14,
  },
  permissionTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 14,
  },
  permissionBody: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  viewfinderContainer: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
    overflow: 'hidden',
  },
  cameraSurface: {
    flex: 1,
  },
  overlayFill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'space-between',
  },
  letterboxBarTop: {
    width: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239, 68, 68, 0.35)',
  },
  letterboxBarBottom: {
    width: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(239, 68, 68, 0.35)',
  },
  aspectGuideLabelWrap: {
    alignSelf: 'flex-end',
    marginRight: 12,
  },
  aspectGuideLabel: {
    color: 'rgba(248, 250, 252, 0.45)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  topHud: {
    position: 'absolute',
    top: 10,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  hudReadoutPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(9, 13, 22, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1E293B',
    gap: 6,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timecodeText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  hudMetricText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
  },
  hudDivider: {
    color: '#475569',
    fontSize: 11,
  },
  hudQuickButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  iconToggleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(9, 13, 22, 0.82)',
    borderWidth: 1,
    borderColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconToggleBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderColor: '#EF4444',
  },
  histogramCard: {
    position: 'absolute',
    top: 52,
    left: 12,
    width: 158,
    backgroundColor: 'rgba(9, 13, 22, 0.84)',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  histogramHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  histogramTitle: {
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '800',
  },
  histogramSub: {
    color: '#EF4444',
    fontSize: 9,
    fontWeight: '700',
  },
  histogramBarsRow: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1.5,
  },
  histBarSlot: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
  histBarLuma: {
    width: '100%',
    backgroundColor: '#F87171',
    borderRadius: 1,
  },
  streamSpecPill: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  streamSpecText: {
    color: '#FECACA',
    fontSize: 11,
    fontWeight: '800',
  },
  captureToast: {
    position: 'absolute',
    bottom: 10,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(9, 13, 22, 0.92)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#10B981',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  captureToastText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
  },
  errorBanner: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(127, 29, 29, 0.92)',
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  errorBannerText: {
    color: '#FECACA',
    fontSize: 11,
    flex: 1,
  },
  controlDeck: {
    backgroundColor: '#0B0F17',
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  lensRow: {
    gap: 8,
    paddingBottom: 8,
  },
  lensPill: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  lensPillSelected: {
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    borderColor: '#EF4444',
  },
  lensPillText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  lensPillTextSelected: {
    color: '#F87171',
  },
  paramTabsRow: {
    flexDirection: 'row',
    gap: 5,
    marginBottom: 8,
  },
  paramTabBtn: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 3,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  paramTabBtnActive: {
    borderColor: '#EF4444',
    backgroundColor: '#181115',
  },
  paramTabLabel: {
    color: '#64748B',
    fontSize: 8.5,
    fontWeight: '800',
  },
  paramTabLabelActive: {
    color: '#F87171',
  },
  paramTabValue: {
    color: '#E2E8F0',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  paramTabValueActive: {
    color: '#FFFFFF',
  },
  sliderPanel: {
    backgroundColor: '#0F1623',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 10,
  },
  codecPanel: {
    gap: 8,
    paddingVertical: 2,
  },
  codecRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  codecLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '800',
  },
  chipGroup: {
    flexDirection: 'row',
    gap: 4,
  },
  OptionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#1E293B',
  },
  OptionChipActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  OptionChipText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
  },
  OptionChipTextActive: {
    color: '#FECACA',
  },
  modeToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    gap: 8,
  },
  autoManualBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  autoManualBtnManual: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  autoManualBtnText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
  },
  infinityQuickBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  infinityQuickBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderColor: '#EF4444',
  },
  infinityQuickBtnText: {
    color: '#FCA5A5',
    fontSize: 10,
    fontWeight: '800',
  },
  quickIsoRow: {
    flexDirection: 'row',
    gap: 5,
  },
  presetChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  presetChipActive: {
    backgroundColor: '#EF4444',
  },
  presetChipText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '700',
  },
  shutterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  formatToggleWrap: {
    width: 112,
  },
  pauseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1E293B',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
  },
  pauseBtnText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '800',
  },
  standbyBadge: {
    backgroundColor: '#111827',
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  standbyBadgeTitle: {
    color: '#F87171',
    fontSize: 10,
    fontWeight: '800',
  },
  standbyBadgeSub: {
    color: '#94A3B8',
    fontSize: 9,
    marginTop: 1,
  },
  recordOuterRing: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 3,
    borderColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  recordInnerCore: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#EF4444',
  },
  recordInnerCoreStop: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: '#EF4444',
  },
  metaReadoutRight: {
    width: 112,
    alignItems: 'flex-end',
  },
  metaReadoutLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '800',
  },
  metaReadoutValue: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
});
