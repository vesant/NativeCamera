import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import {
  CameraSensorCharacteristics,
  inspectDeviceCameras,
} from '@/native/CameraInspector';
import {
  AstroCaptureResult,
  AstroProgressEvent,
  cancelAstroCapture,
  NativeCameraEngineView,
  startComputationalCapture,
  subscribeAstroProgress,
} from '@/native/CameraEngine';
import { CameraRollPreviewButton } from '@/components/MediaPreviewModal';

interface ComputationalModeSpec {
  modeCode: 1 | 2 | 3 | 4;
  id: string;
  title: string;
  badge: string;
  accent: string;
  icon: keyof typeof Ionicons.glyphMap;
  description: string;
  frameOptions: number[];
  defaultFrames: number;
  exposureOptions: number[];
  defaultExposureSec: number;
  isoOptions: number[];
  defaultIso: number;
}

const COMPUTATIONAL_MODES: ComputationalModeSpec[] = [
  {
    modeCode: 1,
    id: 'hdr_fusion',
    title: 'HDR+ Exposure Fusion',
    badge: 'MERTENS MULTI-EV',
    accent: '#F59E0B',
    icon: 'contrast-outline',
    description:
      'Sweeps Camera2 exposure time across [-2 EV .. +2 EV] and fuses shadow detail with unclipped highlights in C++17 using Mertens contrast × saturation × well-exposedness weights.',
    frameOptions: [3, 5, 7],
    defaultFrames: 5,
    exposureOptions: [0.0, 0.008, 0.033, 0.1],
    defaultExposureSec: 0.0, // 0.0 = center around live metered AE exposure
    isoOptions: [100, 200, 400, 800],
    defaultIso: 200,
  },
  {
    modeCode: 2,
    id: 'light_trails',
    title: 'Light Trails & Star Trails',
    badge: 'TEMPORAL MAX-BLEND',
    accent: '#EC4899',
    icon: 'sparkles-outline',
    description:
      'Captures continuous long exposures and fuses moving highlights (traffic trails, light painting, star arcs) via temporal maximum while averaging static dark sky/backgrounds.',
    frameOptions: [6, 12, 20],
    defaultFrames: 12,
    exposureOptions: [0.5, 1.0, 2.0, 4.0],
    defaultExposureSec: 1.0,
    isoOptions: [100, 200, 400, 800],
    defaultIso: 200,
  },
  {
    modeCode: 3,
    id: 'super_res',
    title: 'Handheld Night Super-Res',
    badge: 'RANSAC + UNSHARP',
    accent: '#06B6D4',
    icon: 'scan-circle-outline',
    description:
      'Aligns handheld burst frames via C++17 RANSAC keypoint registration, crushes high-ISO chroma noise with alpha-trimmed mean stacking, and boosts micro-contrast via Laplacian unsharp mask.',
    frameOptions: [5, 8, 12],
    defaultFrames: 8,
    exposureOptions: [0.05, 0.125, 0.25, 0.5],
    defaultExposureSec: 0.125,
    isoOptions: [400, 800, 1600, 3200],
    defaultIso: 1600,
  },
  {
    modeCode: 4,
    id: 'focus_stack',
    title: 'Macro Focus Bracketing',
    badge: 'LAPLACIAN DOF FUSION',
    accent: '#10B981',
    icon: 'layers-outline',
    description:
      'Automatically steps the lens voice-coil motor in diopters from closest macro focus (minFocusDistance) toward optical infinity (0.0 D) and fuses the sharpest focus plane per pixel.',
    frameOptions: [4, 6, 8],
    defaultFrames: 6,
    exposureOptions: [0.0, 0.016, 0.033, 0.066],
    defaultExposureSec: 0.0,
    isoOptions: [100, 200, 400, 800],
    defaultIso: 200,
  },
];

export default function ComputationalModesScreen() {
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [checkingPermission, setCheckingPermission] = useState<boolean>(true);
  const [sensors, setSensors] = useState<CameraSensorCharacteristics[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('0');

  const [selectedModeCode, setSelectedModeCode] = useState<1 | 2 | 3 | 4>(1);
  const [frameCount, setFrameCount] = useState<number>(5);
  const [baseExposureSec, setBaseExposureSec] = useState<number>(0.0);
  const [iso, setIso] = useState<number>(200);
  const [evStep, setEvStep] = useState<number>(1.0);

  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [progress, setProgress] = useState<AstroProgressEvent | null>(null);
  const [lastResult, setLastResult] = useState<AstroCaptureResult | null>(null);
  const [showCompareModal, setShowCompareModal] = useState<boolean>(false);
  const [compareView, setCompareView] = useState<'STACKED' | 'SINGLE'>('STACKED');

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => {
        setIsFocused(false);
      };
    }, [])
  );

  useEffect(() => {
    async function init() {
      setCheckingPermission(true);
      try {
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.CAMERA
          );
          setHasPermission(granted === PermissionsAndroid.RESULTS.GRANTED);
        } else {
          setHasPermission(true);
        }

        const report = await inspectDeviceCameras();
        setSensors(report.sensors);
        const primaryBack =
          report.sensors.find(
            (c: CameraSensorCharacteristics) => c.facing === 'Back'
          ) ?? report.sensors[0];
        if (primaryBack) {
          setSelectedCameraId(primaryBack.cameraId);
        }
      } finally {
        setCheckingPermission(false);
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (!isFocused) return;
    const progSub = subscribeAstroProgress((evt) => {
      setProgress(evt);
    });
    return () => {
      progSub.remove();
    };
  }, [isFocused]);

  const activeMode = useMemo(
    () =>
      COMPUTATIONAL_MODES.find((m) => m.modeCode === selectedModeCode) ??
      COMPUTATIONAL_MODES[0],
    [selectedModeCode]
  );

  const handleSelectMode = (spec: ComputationalModeSpec) => {
    if (isCapturing) return;
    setSelectedModeCode(spec.modeCode);
    setFrameCount(spec.defaultFrames);
    setBaseExposureSec(spec.defaultExposureSec);
    setIso(spec.defaultIso);
  };

  const handleTriggerCapture = async () => {
    if (isCapturing) {
      await cancelAstroCapture();
      return;
    }

    setIsCapturing(true);
    setProgress({
      currentFrame: 1,
      totalFrames: frameCount,
      stage: 'CAPTURING',
      message: `Starting ${activeMode.title} (${frameCount} frames)...`,
      previewUri: null,
      abortedByMotion: false,
    });

    try {
      const result = await startComputationalCapture({
        modeCode: activeMode.modeCode,
        frameCount,
        baseExposureSec,
        iso,
        evStep,
      });
      setLastResult(result);
      setCompareView('STACKED');
      setShowCompareModal(true);
    } catch (e: any) {
      Alert.alert(
        'Computational Capture Error',
        e?.message ?? 'Failed completing multi-frame synthesis.'
      );
    } finally {
      setIsCapturing(false);
      setProgress(null);
    }
  };

  if (checkingPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#F59E0B" />
        <Text style={styles.loadingText}>Loading Computational Lab Engine...</Text>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.centered}>
        <Ionicons name="sparkles-outline" size={48} color="#F59E0B" />
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
      </SafeAreaView>
    );
  }

  const progressRatio = progress
    ? Math.min(1, progress.currentFrame / Math.max(1, progress.totalFrames))
    : 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Live Camera2 Viewfinder + Progressive Synthesis Overlay */}
      <View style={styles.viewfinderWrap}>
        {isFocused ? (
          <NativeCameraEngineView
            style={styles.cameraSurface}
            cameraId={selectedCameraId}
            active={isFocused}
            manualExposure={baseExposureSec > 0}
            exposureTimeNs={
              baseExposureSec > 0 ? Math.round(baseExposureSec * 1_000_000_000) : 20_000_000
            }
            manualIso={true}
            isoValue={iso}
            manualFocus={false}
            focusDistanceDiopters={0.0}
            manualWhiteBalance={false}
            wbKelvin={5500}
            wbTint={0}
            enableRawDng={false}
            zoomRatio={1.0}
          />
        ) : (
          <View style={styles.cameraSurface} />
        )}

        {/* Progressive C++17 Preview while stacking */}
        {isCapturing && progress?.previewUri ? (
          <View style={styles.progressiveOverlay} pointerEvents="none">
            <Image
              source={{ uri: `${progress.previewUri}?t=${progress.currentFrame}` }}
              style={styles.progressiveImage}
              resizeMode="cover"
            />
            <View
              style={[
                styles.progressiveBadge,
                { borderColor: activeMode.accent },
              ]}
            >
              <Text style={[styles.progressiveBadgeText, { color: activeMode.accent }]}>
                LIVE C++17 PROGRESSIVE SYNTHESIS • FRAME {progress.currentFrame}/
                {progress.totalFrames}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Top Mode Banner */}
        <View style={styles.topHud}>
          <View
            style={[
              styles.modeHeaderBanner,
              { borderColor: activeMode.accent },
            ]}
          >
            <View style={styles.modeBannerTopRow}>
              <Ionicons
                name={activeMode.icon}
                size={16}
                color={activeMode.accent}
              />
              <Text style={styles.modeBannerTitle}>{activeMode.title}</Text>
              <View
                style={[
                  styles.modeBadgePill,
                  { backgroundColor: `${activeMode.accent}25` },
                ]}
              >
                <Text
                  style={[styles.modeBadgeText, { color: activeMode.accent }]}
                >
                  {activeMode.badge}
                </Text>
              </View>
            </View>
            <Text style={styles.modeBannerDesc} numberOfLines={2}>
              {activeMode.description}
            </Text>
          </View>
        </View>

        {/* Active Progress Card */}
        {isCapturing && progress && (
          <View style={styles.progressHudCard}>
            <View style={styles.progressHeaderRow}>
              <Text
                style={[styles.progressFrameCounter, { color: activeMode.accent }]}
              >
                Frame {progress.currentFrame} / {progress.totalFrames}
              </Text>
              <Text style={styles.progressStageBadge}>
                {Math.round(progressRatio * 100)}% • {progress.stage}
              </Text>
            </View>
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${Math.round(progressRatio * 100)}%`,
                    backgroundColor: activeMode.accent,
                  },
                ]}
              />
            </View>
            <Text style={styles.progressMessageText}>{progress.message}</Text>
          </View>
        )}

        {/* Compare Last Result Quick Pill */}
        {!isCapturing && lastResult && (
          <Pressable
            onPress={() => setShowCompareModal(true)}
            style={[
              styles.lastResultFloatingBtn,
              { borderColor: activeMode.accent },
            ]}
          >
            <Ionicons name="sparkles" size={15} color={activeMode.accent} />
            <Text style={styles.lastResultFloatingText}>
              Compare Last Output ({lastResult.framesStacked}F Fused)
            </Text>
            <Ionicons name="chevron-forward" size={14} color="#94A3B8" />
          </Pressable>
        )}
      </View>

      {/* Computational Lab Deck */}
      <View style={styles.labDeck}>
        {/* Physical Lens Switcher */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.modeCardsRow}
        >
          {sensors.map((sensor) => {
            const selected = sensor.cameraId === selectedCameraId;
            return (
              <Pressable
                key={sensor.cameraId}
                disabled={isCapturing}
                onPress={() => setSelectedCameraId(sensor.cameraId)}
                style={[
                  styles.configChip,
                  selected && {
                    backgroundColor: `${activeMode.accent}28`,
                    borderColor: activeMode.accent,
                    borderWidth: 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.configChipText,
                    selected && { color: '#F8FAFC' },
                  ]}
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

        {/* 4 Computational Mode Selector Cards */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.modeCardsRow}
        >
          {COMPUTATIONAL_MODES.map((spec) => {
            const selected = spec.modeCode === selectedModeCode;
            return (
              <Pressable
                key={spec.id}
                disabled={isCapturing}
                onPress={() => handleSelectMode(spec)}
                style={[
                  styles.modeCard,
                  selected && {
                    borderColor: spec.accent,
                    backgroundColor: `${spec.accent}18`,
                  },
                ]}
              >
                <Ionicons
                  name={spec.icon}
                  size={16}
                  color={selected ? spec.accent : '#94A3B8'}
                />
                <View>
                  <Text
                    style={[
                      styles.modeCardTitle,
                      selected && { color: '#F8FAFC' },
                    ]}
                  >
                    {spec.title}
                  </Text>
                  <Text
                    style={[
                      styles.modeCardBadge,
                      selected && { color: spec.accent },
                    ]}
                  >
                    {spec.badge}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Parameter Grid */}
        <View style={styles.configGrid}>
          <View style={styles.configColumn}>
            <Text style={styles.configLabel}>BURST FRAMES</Text>
            <View style={styles.chipRow}>
              {activeMode.frameOptions.map((n) => (
                <Pressable
                  key={n}
                  disabled={isCapturing}
                  onPress={() => setFrameCount(n)}
                  style={[
                    styles.configChip,
                    frameCount === n && {
                      backgroundColor: `${activeMode.accent}30`,
                      borderColor: activeMode.accent,
                      borderWidth: 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.configChipText,
                      frameCount === n && { color: '#F8FAFC' },
                    ]}
                  >
                    {n}F
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {activeMode.modeCode === 1 ? (
            <View style={styles.configColumn}>
              <Text style={styles.configLabel}>BRACKET STEP (EV)</Text>
              <View style={styles.chipRow}>
                {[0.7, 1.0, 1.5, 2.0].map((step) => (
                  <Pressable
                    key={step}
                    disabled={isCapturing}
                    onPress={() => setEvStep(step)}
                    style={[
                      styles.configChip,
                      evStep === step && {
                        backgroundColor: `${activeMode.accent}30`,
                        borderColor: activeMode.accent,
                        borderWidth: 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.configChipText,
                        evStep === step && { color: '#F8FAFC' },
                      ]}
                    >
                      ±{step}EV
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            <View style={styles.configColumn}>
              <Text style={styles.configLabel}>BASE SHUTTER</Text>
              <View style={styles.chipRow}>
                {activeMode.exposureOptions.map((sec) => (
                  <Pressable
                    key={sec}
                    disabled={isCapturing}
                    onPress={() => setBaseExposureSec(sec)}
                    style={[
                      styles.configChip,
                      baseExposureSec === sec && {
                        backgroundColor: `${activeMode.accent}30`,
                        borderColor: activeMode.accent,
                        borderWidth: 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.configChipText,
                        baseExposureSec === sec && { color: '#F8FAFC' },
                      ]}
                    >
                      {sec === 0
                        ? 'Auto'
                        : sec >= 0.4
                          ? `${sec}s`
                          : `1/${Math.round(1 / sec)}s`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Bottom Trigger Bar */}
        <View style={styles.triggerRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.isoScroll}
            contentContainerStyle={{ gap: 5, alignItems: 'center' }}
          >
            <Text style={styles.configLabel}>ISO</Text>
            {activeMode.isoOptions.map((val) => (
              <Pressable
                key={val}
                disabled={isCapturing}
                onPress={() => setIso(val)}
                style={[
                  styles.configChip,
                  iso === val && {
                    backgroundColor: `${activeMode.accent}30`,
                    borderColor: activeMode.accent,
                    borderWidth: 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.configChipText,
                    iso === val && { color: '#F8FAFC' },
                  ]}
                >
                  {val}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable
              onPress={handleTriggerCapture}
              style={[
                styles.synthShutterOuter,
                { borderColor: activeMode.accent },
                isCapturing && { borderColor: '#EF4444' },
              ]}
            >
              <View
                style={[
                  styles.synthShutterInner,
                  { backgroundColor: activeMode.accent },
                  isCapturing && styles.synthShutterInnerStop,
                ]}
              >
                <Ionicons
                  name={isCapturing ? 'stop' : activeMode.icon}
                  size={22}
                  color="#070A10"
                />
              </View>
            </Pressable>

            <CameraRollPreviewButton size={48} disabled={isCapturing} />
          </View>
        </View>
      </View>

      {/* Before / After Computational Comparison Modal */}
      <Modal
        visible={showCompareModal && lastResult !== null}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowCompareModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>C++17 Computational Fusion Result</Text>
                <Text style={styles.modalSubtitle}>
                  {lastResult?.framesStacked} frames • {lastResult?.totalIntegrationSec}s
                  total integration • Saved to {lastResult?.albumPath}
                </Text>
              </View>
              <Pressable
                onPress={() => setShowCompareModal(false)}
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={20} color="#F8FAFC" />
              </Pressable>
            </View>

            {lastResult && (
              <View style={styles.compareImageBox}>
                <Image
                  source={{
                    uri:
                      compareView === 'STACKED'
                        ? lastResult.stackedUri
                        : lastResult.singleFrameUri,
                  }}
                  style={styles.compareImage}
                  resizeMode="contain"
                />
                <View style={styles.compareModeTag}>
                  <Text style={styles.compareModeTagText}>
                    {compareView === 'STACKED'
                      ? `AFTER: C++17 FUSED (${lastResult.framesStacked} FRAMES)`
                      : 'BEFORE: SINGLE REFERENCE FRAME 1'}
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.compareToggleRow}>
              <Pressable
                onPress={() => setCompareView('SINGLE')}
                style={[
                  styles.compareToggleBtn,
                  compareView === 'SINGLE' && styles.compareToggleBtnActive,
                ]}
              >
                <Text
                  style={[
                    styles.compareToggleText,
                    compareView === 'SINGLE' && styles.compareToggleTextActive,
                  ]}
                >
                  Before (Single Frame 1)
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setCompareView('STACKED')}
                style={[
                  styles.compareToggleBtn,
                  compareView === 'STACKED' && styles.compareToggleBtnActive,
                ]}
              >
                <Text
                  style={[
                    styles.compareToggleText,
                    compareView === 'STACKED' && styles.compareToggleTextActive,
                  ]}
                >
                  After ({lastResult?.framesStacked ?? 0}F C++17 Fused)
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  viewfinderWrap: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },
  cameraSurface: {
    flex: 1,
  },
  progressiveOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(5, 8, 15, 0.5)',
  },
  progressiveImage: {
    width: '100%',
    height: '100%',
  },
  progressiveBadge: {
    position: 'absolute',
    top: 84,
    alignSelf: 'center',
    backgroundColor: 'rgba(9, 13, 22, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  progressiveBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  topHud: {
    position: 'absolute',
    top: 10,
    left: 12,
    right: 12,
  },
  modeHeaderBanner: {
    backgroundColor: 'rgba(9, 13, 22, 0.88)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
  },
  modeBannerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modeBannerTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
    flex: 1,
  },
  modeBadgePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  modeBadgeText: {
    fontSize: 9,
    fontWeight: '800',
  },
  modeBannerDesc: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
    lineHeight: 15,
  },
  progressHudCard: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    right: 14,
    backgroundColor: 'rgba(9, 13, 22, 0.94)',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  progressHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progressFrameCounter: {
    fontSize: 13,
    fontWeight: '800',
  },
  progressStageBadge: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: '#1E293B',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressBarFill: {
    height: '100%',
  },
  progressMessageText: {
    color: '#94A3B8',
    fontSize: 11,
  },
  lastResultFloatingBtn: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(9, 13, 22, 0.92)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  lastResultFloatingText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
  },
  labDeck: {
    backgroundColor: '#0B0F17',
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  modeCardsRow: {
    gap: 8,
    paddingBottom: 10,
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#111827',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  modeCardTitle: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '800',
  },
  modeCardBadge: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1,
  },
  configGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  configColumn: {
    flex: 1,
    backgroundColor: '#0F1623',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  configLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '800',
    marginBottom: 5,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 4,
    flexWrap: 'wrap',
  },
  configChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  configChipText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
  },
  triggerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  isoScroll: {
    flex: 1,
    backgroundColor: '#0F1623',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  synthShutterOuter: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  synthShutterInner: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  synthShutterInnerStop: {
    backgroundColor: '#EF4444',
    borderRadius: 10,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3, 6, 12, 0.92)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#0F1623',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '800',
  },
  modalSubtitle: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compareImageBox: {
    width: '100%',
    height: 290,
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 12,
  },
  compareImage: {
    width: '100%',
    height: '100%',
  },
  compareModeTag: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: 'rgba(9, 13, 22, 0.88)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  compareModeTagText: {
    color: '#F59E0B',
    fontSize: 10,
    fontWeight: '800',
  },
  compareToggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  compareToggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1E293B',
    alignItems: 'center',
  },
  compareToggleBtnActive: {
    backgroundColor: '#F59E0B',
  },
  compareToggleText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
  },
  compareToggleTextActive: {
    color: '#070A10',
  },
});
