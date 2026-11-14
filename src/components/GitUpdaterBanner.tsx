import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  checkForGitUpdates,
  downloadAndApplyOtaUpdate,
  downloadAndInstallApk,
  getCurrentBuildInfo,
  GitBuildInfo,
  GitUpdateCheckResult,
  GitUpdateProgressEvent,
  restartApp,
  rollbackToBuiltInBundle,
  subscribeGitUpdateProgress,
} from '@/native/GitUpdater';

interface GitUpdaterTriggerProps {
  compact?: boolean;
}

/**
 * Provides both:
 * 1. An automatic background Git update checker that shows an instant banner whenever
 *    a new commit/OTA bundle is pushed to `https://github.com/vesant/NativeCamera`.
 * 2. An interactive Git OTA & APK Updater console modal showing live Git commit history,
 *    SHA-256 verified bundle hot-swapping, and one-tap app reload without USB debugging.
 */
export function GitUpdaterHeaderButton({ compact = false }: GitUpdaterTriggerProps) {
  const [buildInfo, setBuildInfo] = useState<GitBuildInfo | null>(null);
  const [checkResult, setCheckResult] = useState<GitUpdateCheckResult | null>(null);
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [isInstalling, setIsInstalling] = useState<boolean>(false);
  const [progress, setProgress] = useState<GitUpdateProgressEvent | null>(null);

  const performCheck = useCallback(async (silent = false) => {
    if (!silent) setIsChecking(true);
    try {
      const info = await getCurrentBuildInfo();
      setBuildInfo(info);
      const res = await checkForGitUpdates();
      setCheckResult(res);
    } catch (e: any) {
      if (!silent) {
        Alert.alert(
          'GitHub Fetch Error',
          e?.message ?? 'Could not reach github.com/vesant/NativeCamera.'
        );
      }
    } finally {
      if (!silent) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    getCurrentBuildInfo()
      .then((info) => {
        if (mounted) setBuildInfo(info);
        return checkForGitUpdates();
      })
      .then((res) => {
        if (mounted) setCheckResult(res);
      })
      .catch(() => {});

    const sub = subscribeGitUpdateProgress((evt) => {
      setProgress(evt);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const handleOpenModal = () => {
    setModalVisible(true);
    performCheck(false);
  };

  const handleApplyOtaUpdate = async () => {
    if (!checkResult || isInstalling) return;
    setIsInstalling(true);
    setProgress({
      stage: 'CONNECTING',
      bytesRead: 0,
      totalBytes: checkResult.bundleSizeBytes || 2_500_000,
      percent: 2,
      message: 'Connecting to GitHub repository...',
    });

    try {
      const targetSha =
        checkResult.remoteOtaCommitSha ||
        checkResult.latestGitCommitSha ||
        'latest';
      const installed = await downloadAndApplyOtaUpdate({
        bundleUrl: checkResult.bundleUrl,
        expectedSha256: checkResult.bundleSha256,
        commitSha: targetSha,
        commitMessage: checkResult.remoteCommitMessage || 'Git OTA Update',
      });

      const updatedInfo = await getCurrentBuildInfo();
      setBuildInfo(updatedInfo);

      Alert.alert(
        'Git OTA Update Installed',
        `Verified commit ${installed.commitSha} (${installed.sizeKb} KB, SHA-256 matched).\n\nRestart NativeCamera now to load the new version?`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Restart Now',
            style: 'default',
            onPress: () => {
              restartApp();
            },
          },
        ]
      );
    } catch (e: any) {
      Alert.alert(
        'OTA Update Failed',
        e?.message ?? 'Could not download or verify the OTA bundle from GitHub.'
      );
    } finally {
      setIsInstalling(false);
      setProgress(null);
    }
  };

  const handleInstallApk = async () => {
    if (!checkResult?.apkDownloadUrl || isInstalling) return;
    setIsInstalling(true);
    try {
      await downloadAndInstallApk(checkResult.apkDownloadUrl);
    } catch (e: any) {
      Alert.alert('APK Installer Notice', e?.message ?? 'Could not install APK.');
    } finally {
      setIsInstalling(false);
      setProgress(null);
    }
  };

  const handleRollback = async () => {
    Alert.alert(
      'Rollback to Built-In APK Bundle?',
      'This removes the downloaded Git OTA bundle and restores the original bundle packaged inside the installed APK.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rollback & Restart',
          style: 'destructive',
          onPress: async () => {
            await rollbackToBuiltInBundle();
            await restartApp();
          },
        },
      ]
    );
  };

  const hasUpdate = checkResult?.updateAvailable ?? false;

  return (
    <>
      <Pressable
        onPress={handleOpenModal}
        style={[
          styles.triggerBtn,
          compact && styles.triggerBtnCompact,
          hasUpdate && styles.triggerBtnUpdateReady,
        ]}
      >
        <Ionicons
          name={hasUpdate ? 'cloud-download' : 'logo-github'}
          size={15}
          color={hasUpdate ? '#05070B' : '#38BDF8'}
        />
        <Text
          style={[
            styles.triggerBtnText,
            hasUpdate && styles.triggerBtnTextUpdateReady,
          ]}
        >
          {hasUpdate
            ? `Update (${checkResult?.remoteCommitSha})`
            : `Git ${buildInfo?.activeCommitSha ?? '...'}`}
        </Text>
        {hasUpdate ? <View style={styles.pulseDot} /> : null}
      </Pressable>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => {
          if (!isInstalling) setModalVisible(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            {/* Header */}
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleRow}>
                <Ionicons name="logo-github" size={22} color="#F8FAFC" />
                <View>
                  <Text style={styles.sheetTitle}>
                    GitHub OTA & Self-Updater
                  </Text>
                  <Text style={styles.sheetSub}>
                    vesant/NativeCamera • branch: main (No USB Needed)
                  </Text>
                </View>
              </View>

              <Pressable
                disabled={isInstalling}
                onPress={() => setModalVisible(false)}
                style={styles.closeIconBtn}
              >
                <Ionicons name="close" size={20} color="#94A3B8" />
              </Pressable>
            </View>

            <ScrollView
              style={styles.sheetBody}
              contentContainerStyle={{ paddingBottom: 24 }}
              showsVerticalScrollIndicator={false}
            >
              {/* Current Running Version Card */}
              <View style={styles.statusCard}>
                <View style={styles.statusHeaderRow}>
                  <Text style={styles.cardSectionLabel}>
                    INSTALLED ON THIS PHONE
                  </Text>
                  <View
                    style={[
                      styles.sourceBadge,
                      buildInfo?.isUsingOtaBundle && styles.sourceBadgeOta,
                    ]}
                  >
                    <Text style={styles.sourceBadgeText}>
                      {buildInfo?.isUsingOtaBundle
                        ? 'GIT OTA HOT-BUNDLE'
                        : 'BUILT-IN APK ASSET'}
                    </Text>
                  </View>
                </View>

                <View style={styles.shaComparisonRow}>
                  <View style={styles.shaBox}>
                    <Text style={styles.shaBoxLabel}>ACTIVE COMMIT</Text>
                    <Text style={styles.shaBoxVal}>
                      #{buildInfo?.activeCommitSha ?? '...'}
                    </Text>
                  </View>
                  <View style={styles.shaBox}>
                    <Text style={styles.shaBoxLabel}>BASE APK COMMIT</Text>
                    <Text style={styles.shaBoxVal}>
                      #{buildInfo?.apkCommitSha ?? '...'}
                    </Text>
                  </View>
                  <View style={styles.shaBox}>
                    <Text style={styles.shaBoxLabel}>APP VERSION</Text>
                    <Text style={styles.shaBoxVal}>
                      v{buildInfo?.versionName ?? '1.2.0'}
                    </Text>
                  </View>
                </View>

                <Text style={styles.activeMsgText} numberOfLines={2}>
                  {buildInfo?.activeCommitMessage ?? 'Built-in APK Release'}
                </Text>
              </View>

              {/* Remote GitHub Repository Status Card */}
              <View
                style={[
                  styles.statusCard,
                  hasUpdate && styles.statusCardHighlight,
                ]}
              >
                <View style={styles.statusHeaderRow}>
                  <Text style={styles.cardSectionLabel}>
                    REMOTE GITHUB (ORIGIN/MAIN)
                  </Text>
                  <Pressable
                    disabled={isChecking || isInstalling}
                    onPress={() => performCheck(false)}
                    style={styles.refreshMiniBtn}
                  >
                    {isChecking ? (
                      <ActivityIndicator size="small" color="#38BDF8" />
                    ) : (
                      <>
                        <Ionicons name="refresh" size={13} color="#38BDF8" />
                        <Text style={styles.refreshMiniText}>Check Now</Text>
                      </>
                    )}
                  </Pressable>
                </View>

                {checkResult ? (
                  <>
                    <View style={styles.remoteInfoRow}>
                      <View
                        style={[
                          styles.updateStateBadge,
                          hasUpdate
                            ? styles.updateStateBadgeAvailable
                            : styles.updateStateBadgeUpToDate,
                        ]}
                      >
                        <Ionicons
                          name={
                            hasUpdate
                              ? 'arrow-up-circle'
                              : 'checkmark-circle'
                          }
                          size={15}
                          color={hasUpdate ? '#F59E0B' : '#10B981'}
                        />
                        <Text
                          style={[
                            styles.updateStateText,
                            { color: hasUpdate ? '#FBBF24' : '#34D399' },
                          ]}
                        >
                          {hasUpdate
                            ? `NEW UPDATE AVAILABLE (#${checkResult.remoteCommitSha})`
                            : `UP TO DATE WITH GITHUB (#${checkResult.remoteCommitSha})`}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.remoteCommitMsg}>
                      “{checkResult.remoteCommitMessage}”
                    </Text>
                    <Text style={styles.remoteMetaSub}>
                      OTA Bundle:{' '}
                      {checkResult.bundleSizeBytes > 0
                        ? `${(checkResult.bundleSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                        : 'Hermes Bytecode'}{' '}
                      • SHA-256:{' '}
                      {checkResult.bundleSha256
                        ? `${checkResult.bundleSha256.slice(0, 12)}...`
                        : 'Verified'}
                    </Text>

                    {/* Progress Bar during download */}
                    {isInstalling && progress ? (
                      <View style={styles.progressBox}>
                        <View style={styles.progressTopRow}>
                          <Text style={styles.progressStageText}>
                            {progress.message}
                          </Text>
                          <Text style={styles.progressPctText}>
                            {progress.percent}%
                          </Text>
                        </View>
                        <View style={styles.progressBarBg}>
                          <View
                            style={[
                              styles.progressBarFill,
                              { width: `${Math.max(4, progress.percent)}%` },
                            ]}
                          />
                        </View>
                      </View>
                    ) : null}

                    {/* Action Buttons */}
                    <View style={styles.actionButtonsCol}>
                      <Pressable
                        disabled={isInstalling || !checkResult.otaManifestFound}
                        onPress={handleApplyOtaUpdate}
                        style={[
                          styles.primaryUpdateBtn,
                          !hasUpdate && styles.primaryUpdateBtnReinstall,
                          (isInstalling || !checkResult.otaManifestFound) && {
                            opacity: 0.5,
                          },
                        ]}
                      >
                        <Ionicons
                          name="flash"
                          size={18}
                          color={hasUpdate ? '#05070B' : '#F8FAFC'}
                        />
                        <Text
                          style={[
                            styles.primaryUpdateBtnText,
                            !hasUpdate && { color: '#F8FAFC' },
                          ]}
                        >
                          {hasUpdate
                            ? `Fetch & Apply Git Update (#${checkResult.remoteCommitSha})`
                            : `Re-Fetch Latest Git Bundle (#${checkResult.remoteCommitSha})`}
                        </Text>
                      </Pressable>

                      {checkResult.apkDownloadUrl ? (
                        <Pressable
                          disabled={isInstalling}
                          onPress={handleInstallApk}
                          style={styles.secondaryApkBtn}
                        >
                          <Ionicons
                            name="download-outline"
                            size={16}
                            color="#38BDF8"
                          />
                          <Text style={styles.secondaryApkBtnText}>
                            Download & Install Full APK from GitHub
                          </Text>
                        </Pressable>
                      ) : null}

                      {buildInfo?.isUsingOtaBundle ? (
                        <Pressable
                          disabled={isInstalling}
                          onPress={handleRollback}
                          style={styles.rollbackBtn}
                        >
                          <Ionicons
                            name="arrow-undo-outline"
                            size={15}
                            color="#F87171"
                          />
                          <Text style={styles.rollbackBtnText}>
                            Rollback to Built-In APK Bundle (#
                            {buildInfo.apkCommitSha})
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </>
                ) : (
                  <View style={styles.loadingWrap}>
                    <ActivityIndicator size="small" color="#38BDF8" />
                    <Text style={styles.loadingText}>
                      Querying github.com/vesant/NativeCamera...
                    </Text>
                  </View>
                )}
              </View>

              {/* Live GitHub Commit History */}
              {checkResult && checkResult.recentCommits.length > 0 ? (
                <View style={styles.statusCard}>
                  <Text style={styles.cardSectionLabel}>
                    RECENT COMMITS ON GITHUB (MAIN)
                  </Text>
                  {checkResult.recentCommits.map((commit, idx) => {
                    const isCurrent =
                      buildInfo?.activeCommitSha &&
                      (commit.sha.startsWith(buildInfo.activeCommitSha) ||
                        buildInfo.activeCommitSha.startsWith(commit.sha));
                    return (
                      <View
                        key={commit.fullSha || idx}
                        style={[
                          styles.commitRow,
                          idx === checkResult.recentCommits.length - 1 && {
                            borderBottomWidth: 0,
                          },
                        ]}
                      >
                        <View style={styles.commitTopLine}>
                          <View
                            style={[
                              styles.commitShaPill,
                              isCurrent && styles.commitShaPillActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.commitShaText,
                                isCurrent && { color: '#10B981' },
                              ]}
                            >
                              {commit.sha}
                              {isCurrent ? ' • ACTIVE' : ''}
                            </Text>
                          </View>
                          <Text style={styles.commitDateText}>
                            {commit.date
                              ? commit.date.replace('T', ' ').slice(0, 16)
                              : ''}
                          </Text>
                        </View>
                        <Text style={styles.commitMsgText} numberOfLines={2}>
                          {commit.message}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  triggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#131C2B',
    borderWidth: 1,
    borderColor: '#26354D',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
  },
  triggerBtnCompact: {
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  triggerBtnUpdateReady: {
    backgroundColor: '#F59E0B',
    borderColor: '#FBBF24',
  },
  triggerBtnText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '800',
  },
  triggerBtnTextUpdateReady: {
    color: '#05070B',
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#05070B',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3, 6, 12, 0.82)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#0B1018',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    maxHeight: '88%',
    paddingTop: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#162030',
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sheetTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '800',
  },
  sheetSub: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 1,
  },
  closeIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#151E2E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: {
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  statusCard: {
    backgroundColor: '#111824',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 12,
  },
  statusCardHighlight: {
    borderColor: '#F59E0B',
  },
  statusHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  cardSectionLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  sourceBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: '#38BDF8',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  sourceBadgeOta: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: '#10B981',
  },
  sourceBadgeText: {
    color: '#F8FAFC',
    fontSize: 9,
    fontWeight: '800',
  },
  shaComparisonRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  shaBox: {
    flex: 1,
    backgroundColor: '#090D14',
    padding: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#182234',
  },
  shaBoxLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: '700',
  },
  shaBoxVal: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  activeMsgText: {
    color: '#CBD5E1',
    fontSize: 12,
  },
  refreshMiniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#162234',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 7,
  },
  refreshMiniText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  remoteInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  updateStateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 7,
  },
  updateStateBadgeAvailable: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
  },
  updateStateBadgeUpToDate: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
  },
  updateStateText: {
    fontSize: 11,
    fontWeight: '800',
  },
  remoteCommitMsg: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  remoteMetaSub: {
    color: '#64748B',
    fontSize: 11,
    marginBottom: 12,
  },
  progressBox: {
    backgroundColor: '#080C12',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  progressTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progressStageText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
  },
  progressPctText: {
    color: '#F59E0B',
    fontSize: 11,
    fontWeight: '800',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: '#1E293B',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#F59E0B',
  },
  actionButtonsCol: {
    gap: 8,
  },
  primaryUpdateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F59E0B',
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryUpdateBtnReinstall: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  primaryUpdateBtnText: {
    color: '#05070B',
    fontSize: 13,
    fontWeight: '800',
  },
  secondaryApkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: '#38BDF8',
    paddingVertical: 10,
    borderRadius: 10,
  },
  secondaryApkBtnText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '800',
  },
  rollbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    paddingVertical: 9,
    borderRadius: 10,
  },
  rollbackBtnText: {
    color: '#F87171',
    fontSize: 12,
    fontWeight: '700',
  },
  loadingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 12,
  },
  commitRow: {
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#192334',
  },
  commitTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  commitShaPill: {
    backgroundColor: '#090D14',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#243247',
  },
  commitShaPillActive: {
    borderColor: '#10B981',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
  },
  commitShaText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
  },
  commitDateText: {
    color: '#64748B',
    fontSize: 10,
  },
  commitMsgText: {
    color: '#E2E8F0',
    fontSize: 12,
  },
});
