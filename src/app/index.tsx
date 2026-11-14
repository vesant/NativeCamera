import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  CameraInspectionReport,
  CameraSensorCharacteristics,
  inspectDeviceCameras,
} from '@/native/CameraInspector';
import { GitUpdaterHeaderButton } from '@/components/GitUpdaterBanner';

export default function SensorInfoScreen() {
  const [report, setReport] = useState<CameraInspectionReport | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedFeedback, setCopiedFeedback] = useState<boolean>(false);
  const [jsonModalVisible, setJsonModalVisible] = useState<boolean>(false);

  const loadHardwareReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await inspectDeviceCameras();
      setReport(data);
      setSelectedIndex(0);
    } catch (err: any) {
      setError(err?.message ?? 'Unable to query Camera2 characteristics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    inspectDeviceCameras()
      .then((data) => {
        if (!mounted) return;
        setReport(data);
        setSelectedIndex(0);
        setError(null);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message ?? 'Unable to query Camera2 characteristics.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleCopyJsonReport = useCallback(async () => {
    if (!report?.jsonReport) return;
    await Clipboard.setStringAsync(report.jsonReport);
    setCopiedFeedback(true);
    setTimeout(() => setCopiedFeedback(false), 2400);
  }, [report]);

  const handleExportJsonReport = useCallback(async () => {
    if (!report?.jsonReport) return;
    try {
      await Share.share({
        title: `NativeCamera_${report.deviceModel}_SensorReport.json`,
        message: report.jsonReport,
      });
    } catch (err: any) {
      Alert.alert('Export Error', err?.message ?? 'Could not share sensor report.');
    }
  }, [report]);

  const selectedSensor: CameraSensorCharacteristics | undefined =
    report?.sensors?.[selectedIndex];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Top Leica/Halide-inspired Hardware Telemetry Header */}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <View>
            <Text style={styles.brandTag}>NATIVECAMERA // HARDWARE LAB</Text>
            <Text style={styles.headerTitle}>Camera2 & CMOS Inspector</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <GitUpdaterHeaderButton />
            <Pressable style={styles.refreshBtn} onPress={loadHardwareReport}>
              <Ionicons name="refresh" size={18} color="#F59E0B" />
              <Text style={styles.refreshBtnText}>Rescan</Text>
            </Pressable>
          </View>
        </View>

        {report && (
          <View style={styles.deviceSummaryStrip}>
            <View style={styles.deviceMetaChip}>
              <MaterialCommunityIcons name="cellphone-cog" size={14} color="#94A3B8" />
              <Text style={styles.deviceMetaText}>
                {report.deviceManufacturer.toUpperCase()} {report.deviceModel}
              </Text>
            </View>
            <View style={styles.deviceMetaChip}>
              <MaterialCommunityIcons name="memory" size={14} color="#94A3B8" />
              <Text style={styles.deviceMetaText}>SoC: {report.socModel}</Text>
            </View>
            <View style={styles.deviceMetaChip}>
              <Ionicons name="logo-android" size={14} color="#38BDF8" />
              <Text style={styles.deviceMetaText}>
                Android {report.androidRelease} (API {report.sdkInt}) • {report.sensors.length} Sensors
              </Text>
            </View>
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#F59E0B" />
          <Text style={styles.loadingText}>
            Probing CameraManager & physical sub-sensors (IDs 0..15)...
          </Text>
        </View>
      ) : error ? (
        <View style={styles.centerBox}>
          <Ionicons name="warning-outline" size={42} color="#EF4444" />
          <Text style={styles.errorTitle}>Hardware Probe Failed</Text>
          <Text style={styles.errorSub}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={loadHardwareReport}>
            <Text style={styles.retryButtonText}>Retry Probe</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Sensor Selector Pills */}
          <Text style={styles.sectionHeaderLabel}>DETECTED LOGICAL & PHYSICAL SENSORS</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.sensorTabsRow}
          >
            {report?.sensors.map((sensor, idx) => {
              const active = idx === selectedIndex;
              return (
                <Pressable
                  key={sensor.cameraId}
                  onPress={() => setSelectedIndex(idx)}
                  style={[styles.sensorPill, active && styles.sensorPillActive]}
                >
                  <View style={styles.sensorPillTop}>
                    <Text style={[styles.sensorPillId, active && styles.sensorPillIdActive]}>
                      ID {sensor.cameraId}
                    </Text>
                    <View
                      style={[
                        styles.facingDot,
                        {
                          backgroundColor:
                            sensor.facing === 'Back'
                              ? '#10B981'
                              : sensor.facing === 'Front'
                              ? '#38BDF8'
                              : '#A855F7',
                        },
                      ]}
                    />
                  </View>
                  <Text
                    style={[styles.sensorPillRole, active && styles.sensorPillRoleActive]}
                    numberOfLines={1}
                  >
                    {sensor.facing} • {sensor.megapixels}MP
                  </Text>
                  <Text style={styles.sensorPillSub} numberOfLines={1}>
                    {sensor.equivFocalLength35mm > 0
                      ? `${sensor.equivFocalLength35mm}mm eq`
                      : sensor.hardwareLevel}
                    {!sensor.isPublicCameraId ? ' • AUX' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {selectedSensor && (
            <>
              {/* Card 1: Camera ID, Facing & Hardware Support Level */}
              <View style={styles.card}>
                <View style={styles.cardHeaderRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardEyebrow}>
                      CAMERA ID #{selectedSensor.cameraId} • {selectedSensor.facing.toUpperCase()} FACING
                    </Text>
                    <Text style={styles.cardMainTitle}>{selectedSensor.lensRole}</Text>
                    <Text style={styles.topologyText}>{selectedSensor.sensorTypeLabel}</Text>
                  </View>

                  <View
                    style={[
                      styles.hwBadge,
                      getHardwareBadgeStyle(selectedSensor.hardwareLevel).container,
                    ]}
                  >
                    <Text
                      style={[
                        styles.hwBadgeText,
                        getHardwareBadgeStyle(selectedSensor.hardwareLevel).text,
                      ]}
                    >
                      {selectedSensor.hardwareLevel}
                    </Text>
                  </View>
                </View>

                <View style={styles.hwExplanationBox}>
                  <Text style={styles.hwExplanationText}>
                    {selectedSensor.hardwareLevelSummary}
                  </Text>
                  <View style={styles.capRow}>
                    <View
                      style={[
                        styles.capChip,
                        selectedSensor.supportsFullManual ? styles.capChipOk : styles.capChipNo,
                      ]}
                    >
                      <Ionicons
                        name={
                          selectedSensor.supportsFullManual
                            ? 'checkmark-circle'
                            : 'close-circle'
                        }
                        size={14}
                        color={selectedSensor.supportsFullManual ? '#10B981' : '#EF4444'}
                      />
                      <Text style={styles.capChipText}>
                        {selectedSensor.supportsFullManual
                          ? 'Full Manual Exposure/ISO'
                          : 'Restricted Manual Control'}
                      </Text>
                    </View>

                    <View
                      style={[
                        styles.capChip,
                        selectedSensor.supportsRaw ? styles.capChipOk : styles.capChipNo,
                      ]}
                    >
                      <Ionicons
                        name={selectedSensor.supportsRaw ? 'checkmark-circle' : 'close-circle'}
                        size={14}
                        color={selectedSensor.supportsRaw ? '#10B981' : '#EF4444'}
                      />
                      <Text style={styles.capChipText}>
                        {selectedSensor.supportsRaw
                          ? '16-Bit RAW DNG Capable'
                          : 'No Bayer RAW Stream'}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Card 2: Physical Sensor Metrics */}
              <View style={styles.card}>
                <View style={styles.cardSectionTitleRow}>
                  <MaterialCommunityIcons name="image-filter-center-focus" size={18} color="#F59E0B" />
                  <Text style={styles.cardSectionTitle}>Physical CMOS Sensor Metrics</Text>
                </View>

                <View style={styles.metricsGrid}>
                  <MetricTile
                    label="Physical Dimensions"
                    value={`${selectedSensor.sensorWidthMm} × ${selectedSensor.sensorHeightMm} mm`}
                    sub={`Diagonal: ${selectedSensor.sensorDiagonalMm} mm`}
                  />
                  <MetricTile
                    label="Pixel Pitch"
                    value={
                      selectedSensor.pixelPitchUm > 0
                        ? `${selectedSensor.pixelPitchUm} µm`
                        : 'N/A'
                    }
                    sub={`CFA: ${selectedSensor.cfaPattern}`}
                    highlight
                  />
                  <MetricTile
                    label="Native Pixel Array"
                    value={`${selectedSensor.pixelArrayWidth} × ${selectedSensor.pixelArrayHeight}`}
                    sub={`${selectedSensor.megapixels} MP Total`}
                  />
                  <MetricTile
                    label="Active Pixel Array"
                    value={`${selectedSensor.activeArrayWidth} × ${selectedSensor.activeArrayHeight}`}
                    sub="Valid photo-site area"
                  />
                  <MetricTile
                    label="35mm Crop Factor"
                    value={
                      selectedSensor.cropFactor35mm > 0
                        ? `${selectedSensor.cropFactor35mm}×`
                        : 'N/A'
                    }
                    sub="vs. 36×24mm Full Frame"
                    highlight
                  />
                  <MetricTile
                    label="Topology Visibility"
                    value={selectedSensor.isPublicCameraId ? 'Public ID' : 'Hidden Aux ID'}
                    sub={
                      selectedSensor.physicalSubIds.length > 0
                        ? `Sub-IDs: ${selectedSensor.physicalSubIds.join(', ')}`
                        : 'Direct HAL stream'
                    }
                  />
                </View>
              </View>

              {/* Card 3: Optics & Lens */}
              <View style={styles.card}>
                <View style={styles.cardSectionTitleRow}>
                  <Ionicons name="aperture-outline" size={18} color="#F59E0B" />
                  <Text style={styles.cardSectionTitle}>Optics & Lens Assembly</Text>
                </View>

                <View style={styles.metricsGrid}>
                  <MetricTile
                    label="Apertures"
                    value={
                      selectedSensor.apertures.length > 0
                        ? selectedSensor.apertures.map((a) => `f/${a}`).join(', ')
                        : 'Fixed'
                    }
                    sub="Available iris stops"
                    highlight
                  />
                  <MetricTile
                    label="Focal Length"
                    value={
                      selectedSensor.focalLengthsMm.length > 0
                        ? `${selectedSensor.focalLengthsMm.join(', ')} mm`
                        : 'N/A'
                    }
                    sub={
                      selectedSensor.equivFocalLength35mm > 0
                        ? `${selectedSensor.equivFocalLength35mm} mm (35mm equiv.)`
                        : 'Physical focal length'
                    }
                  />
                  <MetricTile
                    label="Min Focus Distance"
                    value={
                      selectedSensor.minFocusDistanceDiopters > 0
                        ? `${selectedSensor.minFocusDistanceDiopters} D (${selectedSensor.minFocusDistanceCm} cm)`
                        : '0.0 D (Fixed ∞)'
                    }
                    sub={selectedSensor.focusCalibration}
                  />
                  <MetricTile
                    label="Optical Stabilization"
                    value={selectedSensor.supportsOis ? 'OIS Supported' : 'No Hardware OIS'}
                    sub={
                      selectedSensor.distortionModes.length > 0
                        ? `Distortion: ${selectedSensor.distortionModes.join(', ')}`
                        : 'Distortion Corr: N/A'
                    }
                  />
                </View>
              </View>

              {/* Card 4: Exposure & Sensitivity Limits */}
              <View style={styles.card}>
                <View style={styles.cardSectionTitleRow}>
                  <MaterialCommunityIcons name="timer-outline" size={18} color="#F59E0B" />
                  <Text style={styles.cardSectionTitle}>Exposure & Sensitivity Limits</Text>
                </View>

                <View style={styles.metricsGrid}>
                  <MetricTile
                    label="ISO Sensitivity Range"
                    value={`ISO ${selectedSensor.minIso} – ${selectedSensor.maxIso}`}
                    sub={`Max Analog Gain: ISO ${selectedSensor.maxAnalogIso}`}
                    highlight
                  />
                  <MetricTile
                    label="Shutter Speed Range"
                    value={`${selectedSensor.minExposureFormatted} – ${selectedSensor.maxExposureFormatted}`}
                    sub={`${Math.round(selectedSensor.minExposureNs).toLocaleString()} ns → ${(
                      selectedSensor.maxExposureNs / 1e9
                    ).toFixed(2)} s`}
                    highlight
                  />
                </View>
              </View>

              {/* Card 5: Supported Stream Formats */}
              <View style={styles.card}>
                <View style={styles.cardSectionTitleRow}>
                  <MaterialCommunityIcons name="database-outline" size={18} color="#F59E0B" />
                  <Text style={styles.cardSectionTitle}>Hardware Stream & RAW Formats</Text>
                </View>

                {selectedSensor.streamFormats.map((fmt) => (
                  <View key={fmt.name} style={styles.streamRow}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.streamNameRow}>
                        <Text style={styles.streamName}>{fmt.name}</Text>
                        <Text style={styles.streamDesc}>{fmt.description}</Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.streamStatusBadge,
                        fmt.supported ? styles.streamStatusSupported : styles.streamStatusUnsupported,
                      ]}
                    >
                      <Text
                        style={[
                          styles.streamStatusText,
                          fmt.supported
                            ? styles.streamStatusTextSupported
                            : styles.streamStatusTextUnsupported,
                        ]}
                      >
                        {fmt.supported ? fmt.maxResolution : 'UNSUPPORTED'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>

              {/* Copy / Export Full JSON Report Action Bar */}
              <View style={styles.exportActionContainer}>
                <Pressable
                  style={[styles.primaryExportBtn, copiedFeedback && styles.primaryExportBtnSuccess]}
                  onPress={handleCopyJsonReport}
                >
                  <Ionicons
                    name={copiedFeedback ? 'checkmark-done' : 'copy-outline'}
                    size={18}
                    color="#07090D"
                  />
                  <Text style={styles.primaryExportBtnText}>
                    {copiedFeedback
                      ? 'Copied Full JSON Report to Clipboard!'
                      : 'Copy / Export Full JSON Report'}
                  </Text>
                </Pressable>

                <View style={styles.secondaryExportRow}>
                  <Pressable style={styles.secondaryBtn} onPress={handleExportJsonReport}>
                    <Ionicons name="share-social-outline" size={16} color="#F8FAFC" />
                    <Text style={styles.secondaryBtnText}>Share JSON Dump</Text>
                  </Pressable>

                  <Pressable
                    style={styles.secondaryBtn}
                    onPress={() => setJsonModalVisible(true)}
                  >
                    <Ionicons name="code-slash-outline" size={16} color="#F59E0B" />
                    <Text style={styles.secondaryBtnText}>Inspect Raw JSON</Text>
                  </Pressable>
                </View>
              </View>
            </>
          )}
        </ScrollView>
      )}

      {/* Raw JSON Report Inspector Modal */}
      <Modal
        visible={jsonModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setJsonModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Full CameraCharacteristics JSON Dump</Text>
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => setJsonModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.modalScroll} contentContainerStyle={{ padding: 16 }}>
            <Text style={styles.jsonCodeText} selectable>
              {report?.jsonReport}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function MetricTile({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.metricTile, highlight && styles.metricTileHighlight]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, highlight && styles.metricValueHighlight]}>
        {value}
      </Text>
      <Text style={styles.metricSub}>{sub}</Text>
    </View>
  );
}

function getHardwareBadgeStyle(level: string) {
  switch (level) {
    case 'LEVEL_3':
      return {
        container: { backgroundColor: 'rgba(16, 185, 129, 0.16)', borderColor: '#10B981' },
        text: { color: '#34D399' },
      };
    case 'FULL':
      return {
        container: { backgroundColor: 'rgba(56, 189, 248, 0.16)', borderColor: '#38BDF8' },
        text: { color: '#38BDF8' },
      };
    case 'LIMITED':
      return {
        container: { backgroundColor: 'rgba(245, 158, 11, 0.16)', borderColor: '#F59E0B' },
        text: { color: '#FBBF24' },
      };
    default:
      return {
        container: { backgroundColor: 'rgba(239, 68, 68, 0.16)', borderColor: '#EF4444' },
        text: { color: '#F87171' },
      };
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#07090D',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#161D2A',
    backgroundColor: '#0A0D14',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandTag: {
    color: '#F59E0B',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 2,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#131924',
    borderWidth: 1,
    borderColor: '#263042',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  refreshBtnText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  deviceSummaryStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  deviceMetaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#111621',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1D2636',
  },
  deviceMetaText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '600',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 13,
    marginTop: 14,
    textAlign: 'center',
  },
  errorTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 10,
  },
  errorSub: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#07090D',
    fontWeight: '800',
    fontSize: 13,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
  },
  sectionHeaderLabel: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  sensorTabsRow: {
    gap: 10,
    paddingBottom: 14,
  },
  sensorPill: {
    backgroundColor: '#0E131D',
    borderWidth: 1,
    borderColor: '#1E293B',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 124,
  },
  sensorPillActive: {
    backgroundColor: '#171F2E',
    borderColor: '#F59E0B',
  },
  sensorPillTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sensorPillId: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
  },
  sensorPillIdActive: {
    color: '#F59E0B',
  },
  facingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  sensorPillRole: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  sensorPillRoleActive: {
    color: '#FFFFFF',
  },
  sensorPillSub: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#0D121B',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1B2434',
    padding: 15,
    marginBottom: 14,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardEyebrow: {
    color: '#F59E0B',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  cardMainTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 3,
  },
  topologyText: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 3,
  },
  hwBadge: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  hwBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  hwExplanationBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#192231',
  },
  hwExplanationText: {
    color: '#CBD5E1',
    fontSize: 12,
    lineHeight: 18,
  },
  capRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  capChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  capChipOk: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  capChipNo: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  capChipText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
  },
  cardSectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  cardSectionTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metricTile: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: '#121824',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#1D2738',
  },
  metricTileHighlight: {
    borderColor: 'rgba(245, 158, 11, 0.4)',
    backgroundColor: 'rgba(245, 158, 11, 0.05)',
  },
  metricLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  metricValue: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4,
  },
  metricValueHighlight: {
    color: '#FBBF24',
  },
  metricSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 3,
  },
  streamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#161F2E',
    gap: 10,
  },
  streamNameRow: {
    flexDirection: 'column',
  },
  streamName: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
  },
  streamDesc: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 1,
  },
  streamStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  streamStatusSupported: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  streamStatusUnsupported: {
    backgroundColor: 'rgba(100, 116, 139, 0.12)',
    borderColor: '#1E293B',
  },
  streamStatusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  streamStatusTextSupported: {
    color: '#34D399',
  },
  streamStatusTextUnsupported: {
    color: '#64748B',
  },
  exportActionContainer: {
    marginTop: 6,
    gap: 10,
  },
  primaryExportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F59E0B',
    paddingVertical: 14,
    borderRadius: 12,
  },
  primaryExportBtnSuccess: {
    backgroundColor: '#10B981',
  },
  primaryExportBtnText: {
    color: '#07090D',
    fontSize: 14,
    fontWeight: '800',
  },
  secondaryExportRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: '#121824',
    borderWidth: 1,
    borderColor: '#243044',
    paddingVertical: 11,
    borderRadius: 10,
  },
  secondaryBtnText: {
    color: '#E2E8F0',
    fontSize: 12,
    fontWeight: '700',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#07090D',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    backgroundColor: '#0B0F17',
  },
  modalTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
  },
  modalCloseBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  modalCloseText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  modalScroll: {
    flex: 1,
  },
  jsonCodeText: {
    color: '#38BDF8',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
});
