import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
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
  AstroCaptureResult,
  AstroProgressEvent,
  cancelAstroCapture,
  MotionTelemetry,
  NativeCameraEngineView,
  startAstroCapture,
  startMotionSensors,
  stopMotionSensors,
  subscribeAstroProgress,
  subscribeMotionTelemetry,
} from '@/native/CameraEngine';

const FRAME_COUNT_OPTIONS = [12, 20, 30] as const;
const EXPOSURE_SEC_OPTIONS = [4, 6, 8, 10] as const;
const ASTRO_ISO_OPTIONS = [800, 1600, 3200, 4800] as const;

interface AlignmentStats {
  framesStacked?: number;
  referenceStars?: number;
  matchedStarsLastFrame?: number;
  maxStarDriftPx?: number;
  snrImprovementFactor?: number;
  snrGainDb?: number;
}

export default function AstroModeScreen() {
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isScreenFocused, setIsScreenFocused] = useState<boolean>(false);

  const [sensors, setSensors] = useState<CameraSensorCharacteristics[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('0');

  // Astro burst configuration
  const [frameCount, setFrameCount] = useState<number>(12);
  const [perFrameSec, setPerFrameSec] = useState<number>(4);
  const [astroIso, setAstroIso] = useState<number>(1600);
  const [tripodGuardEnabled, setTripodGuardEnabled] = useState<boolean>(true);

  // Motion & Tripod stillness telemetry
  const [motion, setMotion] = useState<MotionTelemetry | null>(null);

  // Active Astro capture state
  const [isCapturingAstro, setIsCapturingAstro] = useState<boolean>(false);
  const [astroProgress, setAstroProgress] = useState<AstroProgressEvent | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Completed Astro result & Before/After viewer modal
  const [astroResult, setAstroResult] = useState<AstroCaptureResult | null>(null);
  const [comparisonModalVisible, setComparisonModalVisible] = useState<boolean>(false);
  const [compareMode, setCompareMode] = useState<'STACKED' | 'SINGLE' | 'SPLIT'>('STACKED');

  const requestCameraPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA
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

      const motionSub = subscribeMotionTelemetry((data) => setMotion(data));
      const astroSub = subscribeAstroProgress((data) => setAstroProgress(data));

      return () => {
        setIsScreenFocused(false);
        motionSub.remove();
        astroSub.remove();
        stopMotionSensors().catch(() => {});
        if (countdownTimerRef.current) {
          clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
      };
    }, [])
  );

  const activeSensor = useMemo(
    () => sensors.find((s) => s.cameraId === selectedCameraId) ?? sensors[0],
    [sensors, selectedCameraId]
  );

  // Compute the effective per-frame exposure time clamped by the hardware sensor's maxExposureNs
  const maxSensorExposureSec = useMemo(() => {
    if (!activeSensor) return 10.0;
    return Math.max(0.2, activeSensor.maxExposureNs / 1_000_000_000);
  }, [activeSensor]);

  const effectiveFrameExposureSec = useMemo(() => {
    return Math.min(perFrameSec, maxSensorExposureSec);
  }, [perFrameSec, maxSensorExposureSec]);

  const totalIntegrationSec = useMemo(() => {
    return Number((frameCount * effectiveFrameExposureSec).toFixed(1));
  }, [frameCount, effectiveFrameExposureSec]);

  const parsedAlignmentStats: AlignmentStats = useMemo(() => {
    if (!astroResult?.alignmentReportJson) return {};
    try {
      return JSON.parse(astroResult.alignmentReportJson);
    } catch {
      return {};
    }
  }, [astroResult]);

  const handleStartAstroCapture = useCallback(async () => {
    if (isCapturingAstro) {
      await cancelAstroCapture();
      return;
    }

    setIsCapturingAstro(true);
    setAstroProgress({
      currentFrame: 1,
      totalFrames: frameCount,
      stage: 'CAPTURING',
      message: 'Locking focus to optical infinity (0.0 D) & disabling AE/AWB drift...',
      previewUri: null,
      abortedByMotion: false,
    });

    const estimatedTotalSec = Math.ceil(frameCount * Math.max(1.0, effectiveFrameExposureSec));
    setRemainingSeconds(estimatedTotalSec);

    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = setInterval(() => {
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);

    try {
      const res = await startAstroCapture({
        frameCount,
        frameExposureSec: perFrameSec,
        iso: astroIso,
        abortIfMoved: tripodGuardEnabled,
      });
      setAstroResult(res);
      setCompareMode('STACKED');
      setComparisonModalVisible(true);
    } catch (err: any) {
      Alert.alert(
        'Astrophotography Notice',
        err?.message ?? 'Astrophotography sequence could not complete.'
      );
    } finally {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setIsCapturingAstro(false);
    }
  }, [
    isCapturingAstro,
    frameCount,
    effectiveFrameExposureSec,
    perFrameSec,
    astroIso,
    tripodGuardEnabled,
  ]);

  const progressRatio = useMemo(() => {
    if (!astroProgress || astroProgress.totalFrames <= 0) return 0;
    return Math.min(1, astroProgress.currentFrame / astroProgress.totalFrames);
  }, [astroProgress]);

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.permissionContainer}>
        <Ionicons name="sparkles-outline" size={52} color="#38BDF8" />
        <Text style={styles.permTitle}>Astrophotography Engine Requires Camera Access</Text>
        <Pressable style={styles.permBtn} onPress={requestCameraPermissions}>
          <Text style={styles.permBtnText}>Grant Camera Permission</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const isSteady = motion?.isTripodSteady ?? false;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Top Tripod / Gyroscope Stability Banner */}
      <View
        style={[
          styles.stabilityBanner,
          isSteady ? styles.stabilityBannerReady : styles.stabilityBannerWaiting,
        ]}
      >
        <View style={styles.stabilityRow}>
          <MaterialCommunityIcons
            name={isSteady ? 'shield-check' : 'vibrate'}
            size={18}
            color={isSteady ? '#10B981' : '#F59E0B'}
          />
          <Text
            style={[
              styles.stabilityTitle,
              { color: isSteady ? '#34D399' : '#FBBF24' },
            ]}
            numberOfLines={1}
          >
            {motion?.stabilityBanner ?? 'Hold steady or place on a tripod...'}
          </Text>
        </View>

        <View style={styles.gyroMetricsRow}>
          <Text style={styles.gyroMetricText}>
            Gyro ω: {motion ? `${motion.gyroRadSec.toFixed(3)} rad/s` : '0.000 rad/s'}
          </Text>
          <Text style={styles.gyroMetricText}>
            Accel Δ: {motion ? `${motion.accelJitterMps2.toFixed(2)} m/s²` : '0.00 m/s²'}
          </Text>
          <Text style={styles.gyroMetricText}>
            Stability: {motion?.stabilityPct ?? 100}%
          </Text>
        </View>
      </View>

      {/* Main Viewfinder + Progressive Stacking Overlay */}
      <View style={styles.viewfinderBox}>
        <NativeCameraEngineView
          style={styles.cameraSurface}
          cameraId={selectedCameraId}
          active={isScreenFocused}
          manualExposure={true}
          exposureTimeNs={Math.min(250_000_000, effectiveFrameExposureSec * 1_000_000_000)}
          manualIso={true}
          isoValue={astroIso}
          manualFocus={true}
          focusDistanceDiopters={0.0}
          manualWhiteBalance={true}
          wbKelvin={4600}
          wbTint={0}
          enableRawDng={false}
          zoomRatio={1.0}
        />

        {/* Live Progressive Stacked Preview during Multi-Frame Capture */}
        {isCapturingAstro && astroProgress?.previewUri && (
          <View style={styles.progressivePreviewOverlay} pointerEvents="none">
            <Image
              source={{ uri: `${astroProgress.previewUri}?t=${astroProgress.currentFrame}` }}
              style={styles.progressiveImage}
              resizeMode="cover"
            />
            <View style={styles.progressiveBadge}>
              <Ionicons name="sparkles" size={12} color="#38BDF8" />
              <Text style={styles.progressiveBadgeText}>
                LIVE PROGRESSIVE STACK • FRAME {astroProgress.currentFrame}/{astroProgress.totalFrames}
              </Text>
            </View>
          </View>
        )}

        {/* Active Astro Capture HUD Ring & Countdown */}
        {isCapturingAstro && astroProgress && (
          <View style={styles.captureHudOverlay} pointerEvents="none">
            <View style={styles.progressCircleCard}>
              <Text style={styles.progressFrameBig}>
                Frame {astroProgress.currentFrame}/{astroProgress.totalFrames}
              </Text>
              <Text style={styles.progressCountdown}>
                {Math.floor(remainingSeconds / 60)}:
                {String(remainingSeconds % 60).padStart(2, '0')} remaining
              </Text>

              <View style={styles.progressBarTrack}>
                <View
                  style={[
                    styles.progressBarFill,
                    { width: `${Math.round(progressRatio * 100)}%` },
                  ]}
                />
              </View>

              <Text style={styles.progressStageText}>{astroProgress.message}</Text>
            </View>
          </View>
        )}

        {/* Infinity Focus & Pipeline Badge */}
        <View style={styles.topViewfinderBadges}>
          <View style={styles.astroTagPill}>
            <Ionicons name="infinite" size={14} color="#38BDF8" />
            <Text style={styles.astroTagText}>FOCUS LOCKED AT ∞ (0.0 D)</Text>
          </View>
          <View style={styles.astroTagPill}>
            <MaterialCommunityIcons name="star-four-points-outline" size={14} color="#F59E0B" />
            <Text style={styles.astroTagText}>RANSAC STAR ALIGN + 1.8σ CLIP</Text>
          </View>
        </View>
      </View>

      {/* Astro Burst Configuration & Shutter Panel */}
      <View style={styles.astroControlPanel}>
        {/* Lens + Tripod Guard Row */}
        <View style={styles.configRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6, alignItems: 'center' }}
          >
            {sensors
              .filter((s) => s.facing === 'Back')
              .map((sensor) => {
                const active = sensor.cameraId === selectedCameraId;
                return (
                  <Pressable
                    key={sensor.cameraId}
                    onPress={() => !isCapturingAstro && setSelectedCameraId(sensor.cameraId)}
                    style={[styles.smallChip, active && styles.smallChipActive]}
                  >
                    <Text
                      style={[
                        styles.smallChipText,
                        active && styles.smallChipTextActive,
                      ]}
                    >
                      ID {sensor.cameraId} ({Math.round(sensor.equivFocalLength35mm || 25)}mm)
                    </Text>
                  </Pressable>
                );
              })}

            <Pressable
              style={[
                styles.smallChip,
                tripodGuardEnabled && styles.smallChipGuardActive,
              ]}
              onPress={() => setTripodGuardEnabled((v) => !v)}
            >
              <Text style={styles.smallChipText}>
                {tripodGuardEnabled ? 'Tripod Motion Guard: ON' : 'Tripod Motion Guard: OFF'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>

        {/* Burst Parameters Grid: Frame Count, Per-Frame Exposure, ISO */}
        <View style={styles.paramsColumnsRow}>
          {/* Frame Count (12, 20, 30) */}
          <View style={styles.paramBlock}>
            <Text style={styles.paramBlockLabel}>BURST FRAMES</Text>
            <View style={styles.pillGroupRow}>
              {FRAME_COUNT_OPTIONS.map((cnt) => {
                const active = frameCount === cnt;
                return (
                  <Pressable
                    key={cnt}
                    disabled={isCapturingAstro}
                    onPress={() => setFrameCount(cnt)}
                    style={[styles.optionPill, active && styles.optionPillActive]}
                  >
                    <Text
                      style={[
                        styles.optionPillText,
                        active && styles.optionPillTextActive,
                      ]}
                    >
                      {cnt}f
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Per-Frame Exposure Window (4s..10s) */}
          <View style={styles.paramBlock}>
            <Text style={styles.paramBlockLabel}>
              SUB-EXPOSURE (HW MAX {maxSensorExposureSec.toFixed(1)}s)
            </Text>
            <View style={styles.pillGroupRow}>
              {EXPOSURE_SEC_OPTIONS.map((sec) => {
                const active = perFrameSec === sec;
                return (
                  <Pressable
                    key={sec}
                    disabled={isCapturingAstro}
                    onPress={() => setPerFrameSec(sec)}
                    style={[styles.optionPill, active && styles.optionPillActive]}
                  >
                    <Text
                      style={[
                        styles.optionPillText,
                        active && styles.optionPillTextActive,
                      ]}
                    >
                      {sec}s
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {/* ISO Selection + Total Integration Readout */}
        <View style={styles.isoAndTotalRow}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <Text style={styles.paramBlockLabel}>ASTRO ISO:</Text>
            {ASTRO_ISO_OPTIONS.map((isoOpt) => {
              const active = astroIso === isoOpt;
              return (
                <Pressable
                  key={isoOpt}
                  disabled={isCapturingAstro}
                  onPress={() => setAstroIso(isoOpt)}
                  style={[styles.optionPill, active && styles.optionPillActive]}
                >
                  <Text
                    style={[
                      styles.optionPillText,
                      active && styles.optionPillTextActive,
                    ]}
                  >
                    {isoOpt}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.integrationSummaryText}>
            Total: {totalIntegrationSec}s • SNR +
            {(20 * Math.log10(Math.sqrt(frameCount))).toFixed(1)} dB
          </Text>
        </View>

        {/* Bottom Astro Shutter & Last Stack Viewer Button */}
        <View style={styles.astroBottomRow}>
          <View style={styles.leftInfoCol}>
            <Text style={styles.leftInfoLabel}>PIPELINE</Text>
            <Text style={styles.leftInfoVal}>C++17 JNI Stack</Text>
          </View>

          <Pressable
            style={[
              styles.astroShutterOuter,
              isCapturingAstro && styles.astroShutterOuterStop,
            ]}
            onPress={handleStartAstroCapture}
          >
            <View
              style={[
                styles.astroShutterInner,
                isCapturingAstro && styles.astroShutterInnerStop,
              ]}
            >
              {isCapturingAstro ? (
                <>
                  <Ionicons name="stop" size={18} color="#FFFFFF" />
                  <Text style={styles.astroShutterStopText}>STACK NOW</Text>
                </>
              ) : (
                <>
                  <Ionicons name="sparkles" size={18} color="#05070B" />
                  <Text style={styles.astroShutterGoText}>ASTRO</Text>
                </>
              )}
            </View>
          </Pressable>

          <Pressable
            style={[
              styles.compareBtn,
              !astroResult && { opacity: 0.4 },
            ]}
            disabled={!astroResult}
            onPress={() => setComparisonModalVisible(true)}
          >
            <MaterialCommunityIcons name="compare" size={16} color="#38BDF8" />
            <Text style={styles.compareBtnText}>Before / After</Text>
          </Pressable>
        </View>
      </View>

      {/* Instant Before / After Comparison Viewer Modal */}
      <Modal
        visible={comparisonModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setComparisonModalVisible(false)}
      >
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>COMPUTATIONAL ASTROPHOTOGRAPHY RESULT</Text>
              <Text style={styles.modalTitle}>
                Before (1 Frame) vs. Stacked ({astroResult?.framesStacked ?? 0} Frames)
              </Text>
            </View>
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => setComparisonModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>

          {/* Mode Switcher: Stacked vs Single Frame 1 vs Split Comparison */}
          <View style={styles.compareTabsRow}>
            {(
              [
                { key: 'STACKED', label: 'Stacked + Tone Curve (After)' },
                { key: 'SINGLE', label: 'Single Frame 1 (Before)' },
                { key: 'SPLIT', label: 'Side-by-Side Compare' },
              ] as const
            ).map((tab) => {
              const active = compareMode === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => setCompareMode(tab.key)}
                  style={[styles.compareTab, active && styles.compareTabActive]}
                >
                  <Text
                    style={[
                      styles.compareTabText,
                      active && styles.compareTabTextActive,
                    ]}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {astroResult && (
            <ScrollView contentContainerStyle={styles.modalContent}>
              {compareMode === 'SPLIT' ? (
                <View style={styles.splitCompareContainer}>
                  <View style={styles.splitPane}>
                    <Image
                      source={{ uri: astroResult.singleFrameUri }}
                      style={styles.splitImage}
                      resizeMode="cover"
                    />
                    <View style={styles.paneLabelBadge}>
                      <Text style={styles.paneLabelText}>BEFORE: Frame 1 (Raw Noise)</Text>
                    </View>
                  </View>

                  <View style={styles.splitPane}>
                    <Image
                      source={{ uri: astroResult.stackedUri }}
                      style={styles.splitImage}
                      resizeMode="cover"
                    />
                    <View style={[styles.paneLabelBadge, { backgroundColor: '#0284C7' }]}>
                      <Text style={styles.paneLabelText}>
                        AFTER: {astroResult.framesStacked}-Frame Sigma-Clipped Stack
                      </Text>
                    </View>
                  </View>
                </View>
              ) : (
                <View style={styles.singleCompareContainer}>
                  <Image
                    source={{
                      uri:
                        compareMode === 'STACKED'
                          ? astroResult.stackedUri
                          : astroResult.singleFrameUri,
                    }}
                    style={styles.fullCompareImage}
                    resizeMode="contain"
                  />
                  <View style={styles.overlayModeTag}>
                    <Text style={styles.overlayModeTagText}>
                      {compareMode === 'STACKED'
                        ? `STACKED (${astroResult.framesStacked} Frames • ${astroResult.totalIntegrationSec}s Total • Asinh Curve)`
                        : `SINGLE EXPOSURE (Frame 1 • ${astroResult.perFrameExposureSec}s @ ISO ${astroResult.iso})`}
                    </Text>
                  </View>
                </View>
              )}

              {/* Computational Stacking & Star Registration Report */}
              <View style={styles.statsCard}>
                <Text style={styles.statsCardTitle}>
                  Star Registration & Sigma-Clipped Stacking Telemetry
                </Text>
                {astroResult.abortedEarlyByMotion && (
                  <View style={styles.motionAbortNotice}>
                    <Ionicons name="information-circle" size={16} color="#F59E0B" />
                    <Text style={styles.motionAbortText}>
                      Handset motion detected mid-sequence — gracefully stacked the first{' '}
                      {astroResult.framesStacked} steady frames.
                    </Text>
                  </View>
                )}

                <View style={styles.statsGrid}>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Frames Aligned</Text>
                    <Text style={styles.statVal}>
                      {astroResult.framesStacked} / {astroResult.totalRequestedFrames}
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Total Integration</Text>
                    <Text style={styles.statVal}>{astroResult.totalIntegrationSec}s</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Reference Stars</Text>
                    <Text style={styles.statVal}>
                      {parsedAlignmentStats.referenceStars ?? 0} keypoints
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Max Star Drift</Text>
                    <Text style={styles.statVal}>
                      {(parsedAlignmentStats.maxStarDriftPx ?? 0).toFixed(1)} px
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>SNR Improvement</Text>
                    <Text style={[styles.statVal, { color: '#34D399' }]}>
                      {(parsedAlignmentStats.snrImprovementFactor ?? 1).toFixed(2)}× (+
                      {(parsedAlignmentStats.snrGainDb ?? 0).toFixed(1)} dB)
                    </Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statLabel}>Saved Gallery Path</Text>
                    <Text style={styles.statVal}>{astroResult.albumPath}</Text>
                  </View>
                </View>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
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
    fontSize: 17,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  permBtn: {
    marginTop: 18,
    backgroundColor: '#38BDF8',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
  },
  permBtnText: {
    color: '#07090D',
    fontWeight: '800',
    fontSize: 13,
  },
  stabilityBanner: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  stabilityBannerReady: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderBottomColor: 'rgba(16, 185, 129, 0.35)',
  },
  stabilityBannerWaiting: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderBottomColor: 'rgba(245, 158, 11, 0.35)',
  },
  stabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stabilityTitle: {
    fontSize: 12,
    fontWeight: '800',
    flex: 1,
  },
  gyroMetricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  gyroMetricText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
  },
  viewfinderBox: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  cameraSurface: {
    flex: 1,
  },
  progressivePreviewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  progressiveImage: {
    width: '100%',
    height: '100%',
  },
  progressiveBadge: {
    position: 'absolute',
    bottom: 10,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(5, 7, 11, 0.82)',
    borderWidth: 1,
    borderColor: '#38BDF8',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  progressiveBadgeText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
  },
  captureHudOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  progressCircleCard: {
    width: '88%',
    backgroundColor: 'rgba(7, 10, 16, 0.86)',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    padding: 18,
    alignItems: 'center',
  },
  progressFrameBig: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '900',
  },
  progressCountdown: {
    color: '#38BDF8',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 4,
  },
  progressBarTrack: {
    width: '100%',
    height: 8,
    backgroundColor: '#1E293B',
    borderRadius: 4,
    overflow: 'hidden',
    marginVertical: 12,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#38BDF8',
  },
  progressStageText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  topViewfinderBadges: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
  },
  astroTagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(7, 10, 16, 0.8)',
    borderWidth: 1,
    borderColor: '#1E293B',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  astroTagText: {
    color: '#E2E8F0',
    fontSize: 9,
    fontWeight: '800',
  },
  astroControlPanel: {
    backgroundColor: '#0A0D14',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: '#182232',
    gap: 9,
  },
  configRow: {
    flexDirection: 'row',
  },
  smallChip: {
    backgroundColor: '#111723',
    borderWidth: 1,
    borderColor: '#1F2A3C',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  smallChipActive: {
    borderColor: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
  },
  smallChipGuardActive: {
    borderColor: '#10B981',
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
  },
  smallChipText: {
    color: '#CBD5E1',
    fontSize: 10,
    fontWeight: '700',
  },
  smallChipTextActive: {
    color: '#38BDF8',
    fontWeight: '800',
  },
  paramsColumnsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  paramBlock: {
    flex: 1,
    backgroundColor: '#101622',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1B2537',
  },
  paramBlockLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '800',
    marginBottom: 5,
  },
  pillGroupRow: {
    flexDirection: 'row',
    gap: 6,
  },
  optionPill: {
    flex: 1,
    backgroundColor: '#161F2E',
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#263246',
  },
  optionPillActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    borderColor: '#38BDF8',
  },
  optionPillText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
  },
  optionPillTextActive: {
    color: '#38BDF8',
  },
  isoAndTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  integrationSummaryText: {
    color: '#F59E0B',
    fontSize: 11,
    fontWeight: '800',
  },
  astroBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  leftInfoCol: {
    minWidth: 100,
  },
  leftInfoLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '800',
  },
  leftInfoVal: {
    color: '#E2E8F0',
    fontSize: 12,
    fontWeight: '800',
  },
  astroShutterOuter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 3,
    borderColor: '#38BDF8',
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  astroShutterOuterStop: {
    borderColor: '#EF4444',
  },
  astroShutterInner: {
    width: '100%',
    height: '100%',
    borderRadius: 30,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  astroShutterInnerStop: {
    backgroundColor: '#EF4444',
  },
  astroShutterGoText: {
    color: '#05070B',
    fontSize: 9,
    fontWeight: '900',
    marginTop: 1,
  },
  astroShutterStopText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '900',
    marginTop: 1,
  },
  compareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#121926',
    borderWidth: 1,
    borderColor: '#25334A',
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 10,
    minWidth: 100,
    justifyContent: 'center',
  },
  compareBtnText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
  },
  modalSafe: {
    flex: 1,
    backgroundColor: '#06080D',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1B2434',
  },
  modalEyebrow: {
    color: '#38BDF8',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },
  modalTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 2,
  },
  modalCloseBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  modalCloseText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
  },
  compareTabsRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
  },
  compareTab: {
    flex: 1,
    backgroundColor: '#111723',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1F2A3C',
  },
  compareTabActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.18)',
    borderColor: '#38BDF8',
  },
  compareTabText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
  },
  compareTabTextActive: {
    color: '#38BDF8',
  },
  modalContent: {
    padding: 14,
    gap: 14,
  },
  singleCompareContainer: {
    height: 320,
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1E293B',
    position: 'relative',
  },
  fullCompareImage: {
    width: '100%',
    height: '100%',
  },
  overlayModeTag: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(6, 8, 13, 0.84)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  overlayModeTagText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  splitCompareContainer: {
    gap: 10,
  },
  splitPane: {
    height: 200,
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1E293B',
    position: 'relative',
  },
  splitImage: {
    width: '100%',
    height: '100%',
  },
  paneLabelBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
  },
  paneLabelText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
  },
  statsCard: {
    backgroundColor: '#0D131F',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1D283A',
  },
  statsCardTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 10,
  },
  motionAbortNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
  },
  motionAbortText: {
    color: '#FBBF24',
    fontSize: 11,
    flex: 1,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statBox: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: '#131B2B',
    padding: 10,
    borderRadius: 8,
  },
  statLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
  },
  statVal: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
});
