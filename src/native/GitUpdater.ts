import {
  DeviceEventEmitter,
  EmitterSubscription,
  NativeModules,
  Platform,
} from 'react-native';

export interface GitBuildInfo {
  repoUrl: string;
  branch: string;
  versionName: string;
  apkCommitSha: string;
  apkBuildTime: string;
  activeCommitSha: string;
  activeCommitMessage: string;
  isUsingOtaBundle: boolean;
  installedAt: string;
  bundleSizeKb: number;
}

export interface GitCommitSummary {
  sha: string;
  fullSha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitUpdateCheckResult {
  otaManifestFound: boolean;
  updateAvailable: boolean;
  gitRepoAhead: boolean;
  activeCommitSha: string;
  apkCommitSha: string;
  remoteOtaCommitSha: string;
  latestGitCommitSha: string;
  remoteCommitSha: string;
  remoteCommitFullSha: string;
  remoteCommitMessage: string;
  remoteCommitAuthor: string;
  remoteCommitDate: string;
  bundleUrl: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  apkDownloadUrl: string;
  recentCommits: GitCommitSummary[];
}

export interface GitOtaInstallResult {
  installed: boolean;
  commitSha: string;
  sha256: string;
  sizeKb: number;
  installedAt: string;
}

export interface GitUpdateProgressEvent {
  stage: 'CONNECTING' | 'DOWNLOADING' | 'VERIFYING' | 'DOWNLOADING_APK' | string;
  bytesRead: number;
  totalBytes: number;
  percent: number;
  message: string;
}

interface NativeGitUpdaterModuleSpec {
  getCurrentBuildInfo(): Promise<GitBuildInfo>;
  checkForGitUpdates(): Promise<GitUpdateCheckResult>;
  downloadAndApplyOtaUpdate(
    bundleUrl: string,
    expectedSha256: string,
    commitSha: string,
    commitMessage: string
  ): Promise<GitOtaInstallResult>;
  downloadAndInstallApk(apkUrl: string): Promise<boolean>;
  rollbackToBuiltInBundle(): Promise<boolean>;
  restartApp(): Promise<boolean>;
}

const GitUpdaterNative = NativeModules.GitUpdaterModule as
  | NativeGitUpdaterModuleSpec
  | undefined;

export async function getCurrentBuildInfo(): Promise<GitBuildInfo> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    return {
      repoUrl: 'https://github.com/vesant/NativeCamera',
      branch: 'main',
      versionName: '1.2.0',
      apkCommitSha: 'dev',
      apkBuildTime: 'Local',
      activeCommitSha: 'dev',
      activeCommitMessage: 'Local Development',
      isUsingOtaBundle: false,
      installedAt: '',
      bundleSizeKb: 0,
    };
  }
  return await GitUpdaterNative.getCurrentBuildInfo();
}

export async function checkForGitUpdates(): Promise<GitUpdateCheckResult> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    throw new Error('GitUpdaterModule is only available on Android.');
  }
  return await GitUpdaterNative.checkForGitUpdates();
}

export async function downloadAndApplyOtaUpdate(params: {
  bundleUrl: string;
  expectedSha256: string;
  commitSha: string;
  commitMessage: string;
}): Promise<GitOtaInstallResult> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    throw new Error('GitUpdaterModule is only available on Android.');
  }
  return await GitUpdaterNative.downloadAndApplyOtaUpdate(
    params.bundleUrl,
    params.expectedSha256,
    params.commitSha,
    params.commitMessage
  );
}

export async function downloadAndInstallApk(apkUrl: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    throw new Error('GitUpdaterModule is only available on Android.');
  }
  return await GitUpdaterNative.downloadAndInstallApk(apkUrl);
}

export async function rollbackToBuiltInBundle(): Promise<boolean> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    return false;
  }
  return await GitUpdaterNative.rollbackToBuiltInBundle();
}

export async function restartApp(): Promise<boolean> {
  if (Platform.OS !== 'android' || !GitUpdaterNative) {
    return false;
  }
  return await GitUpdaterNative.restartApp();
}

export function subscribeGitUpdateProgress(
  listener: (evt: GitUpdateProgressEvent) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onGitUpdateProgress', listener);
}
