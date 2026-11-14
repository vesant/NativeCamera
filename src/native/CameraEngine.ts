import {
  DeviceEventEmitter,
  EmitterSubscription,
  NativeModules,
  Platform,
  requireNativeComponent,
  ViewProps,
} from 'react-native';

export interface CameraEngineViewProps extends ViewProps {
  cameraId: string;
  active?: boolean;
  manualExposure?: boolean;
  exposureTimeNs?: number;
  manualIso?: boolean;
  isoValue?: number;
  manualFocus?: boolean;
  focusDistanceDiopters?: number;
  manualWhiteBalance?: boolean;
  wbKelvin?: number;
  wbTint?: number;
  enableRawDng?: boolean;
  zoomRatio?: number;
}

export const NativeCameraEngineView =
  requireNativeComponent<CameraEngineViewProps>('CameraEngineView');

export interface CameraHistogramPayload {
  luma: number[];
  red: number[];
  green: number[];
  blue: number[];
  meanLuminance: number;
  highlightClipPct: number;
  shadowClipPct: number;
}

export interface CameraLiveTelemetry {
  exposureTimeNs: number;
  shutterFormatted: string;
  iso: number;
  focusDiopters: number;
  aperture: number;
  rawReady: boolean;
}

export interface CameraStatusEvent {
  status: 'ready' | 'error' | string;
  message: string;
  cameraId: string;
}

export interface MotionTelemetry {
  rollDeg: number;
  pitchDeg: number;
  isLevel: boolean;
  gyroRadSec: number;
  accelJitterMps2: number;
  isTripodSteady: boolean;
  steadyHoldSeconds: number;
  stabilityPct: number;
  stabilityBanner: string;
}

export interface ProPhotoCaptureResult {
  jpegUri: string;
  dngUri: string | null;
  savedDng: boolean;
  albumPath: string;
  timestamp: string;
  shutterFormatted: string;
  iso: number;
}

export interface AstroProgressEvent {
  currentFrame: number;
  totalFrames: number;
  stage: 'CAPTURING' | 'ALIGNED' | 'STACKING' | string;
  message: string;
  previewUri?: string | null;
  abortedByMotion: boolean;
}

export interface AstroCaptureResult {
  stackedUri: string;
  mediaStoreUri: string;
  singleFrameUri: string;
  framesStacked: number;
  totalRequestedFrames: number;
  perFrameExposureSec: number;
  totalIntegrationSec: number;
  iso: number;
  abortedEarlyByMotion: boolean;
  alignmentReportJson: string;
  albumPath: string;
}

export interface VideoStartResult {
  resolution: string;
  fps: number;
  bitrateMbps: number;
  audioEnabled: boolean;
}

export interface VideoStopResult {
  videoUri: string;
  resolution: string;
  fps: number;
  bitrateMbps: number;
  durationSec: number;
  fileSizeMb: number;
  albumPath: string;
}

interface NativeCameraEngineModuleSpec {
  startMotionSensors(): Promise<boolean>;
  stopMotionSensors(): Promise<boolean>;
  captureProPhoto(): Promise<ProPhotoCaptureResult>;
  startAstroCapture(
    frameCount: number,
    frameExposureSec: number,
    iso: number,
    abortIfMoved: boolean
  ): Promise<AstroCaptureResult>;
  cancelAstroCapture(): Promise<boolean>;
  startVideoRecording(
    resolutionPreset: string,
    fps: number,
    bitrateMbps: number,
    enableAudio: boolean,
    enableStabilization: boolean
  ): Promise<VideoStartResult>;
  pauseVideoRecording(): Promise<boolean>;
  resumeVideoRecording(): Promise<boolean>;
  stopVideoRecording(): Promise<VideoStopResult>;
  startComputationalCapture(
    modeCode: number,
    frameCount: number,
    baseExposureSec: number,
    iso: number,
    evStep: number
  ): Promise<AstroCaptureResult>;
}

const CameraEngineNative = NativeModules.CameraEngineModule as
  | NativeCameraEngineModuleSpec
  | undefined;

export async function startMotionSensors(): Promise<void> {
  if (Platform.OS === 'android' && CameraEngineNative) {
    await CameraEngineNative.startMotionSensors();
  }
}

export async function stopMotionSensors(): Promise<void> {
  if (Platform.OS === 'android' && CameraEngineNative) {
    await CameraEngineNative.stopMotionSensors();
  }
}

export async function captureProPhoto(): Promise<ProPhotoCaptureResult> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    throw new Error('CameraEngineModule is only available on Android.');
  }
  return await CameraEngineNative.captureProPhoto();
}

export async function startAstroCapture(params: {
  frameCount: number;
  frameExposureSec: number;
  iso: number;
  abortIfMoved: boolean;
}): Promise<AstroCaptureResult> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    throw new Error('CameraEngineModule is only available on Android.');
  }
  return await CameraEngineNative.startAstroCapture(
    params.frameCount,
    params.frameExposureSec,
    params.iso,
    params.abortIfMoved
  );
}

export async function cancelAstroCapture(): Promise<boolean> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    return false;
  }
  return await CameraEngineNative.cancelAstroCapture();
}

export async function startVideoRecording(params: {
  resolutionPreset: '4K' | '1080P' | '720P';
  fps: 24 | 30 | 60;
  bitrateMbps: number;
  enableAudio: boolean;
  enableStabilization: boolean;
}): Promise<VideoStartResult> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    throw new Error('CameraEngineModule is only available on Android.');
  }
  return await CameraEngineNative.startVideoRecording(
    params.resolutionPreset,
    params.fps,
    params.bitrateMbps,
    params.enableAudio,
    params.enableStabilization
  );
}

export async function pauseVideoRecording(): Promise<boolean> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    return false;
  }
  return await CameraEngineNative.pauseVideoRecording();
}

export async function resumeVideoRecording(): Promise<boolean> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    return false;
  }
  return await CameraEngineNative.resumeVideoRecording();
}

export async function stopVideoRecording(): Promise<VideoStopResult> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    throw new Error('CameraEngineModule is only available on Android.');
  }
  return await CameraEngineNative.stopVideoRecording();
}

export async function startComputationalCapture(params: {
  modeCode: 1 | 2 | 3 | 4;
  frameCount: number;
  baseExposureSec: number;
  iso: number;
  evStep: number;
}): Promise<AstroCaptureResult> {
  if (Platform.OS !== 'android' || !CameraEngineNative) {
    throw new Error('CameraEngineModule is only available on Android.');
  }
  return await CameraEngineNative.startComputationalCapture(
    params.modeCode,
    params.frameCount,
    params.baseExposureSec,
    params.iso,
    params.evStep
  );
}

export function subscribeHistogram(
  listener: (data: CameraHistogramPayload) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onCameraHistogram', listener);
}

export function subscribeTelemetry(
  listener: (data: CameraLiveTelemetry) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onCameraTelemetry', listener);
}

export function subscribeCameraStatus(
  listener: (data: CameraStatusEvent) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onCameraStatus', listener);
}

export function subscribeMotionTelemetry(
  listener: (data: MotionTelemetry) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onMotionTelemetry', listener);
}

export function subscribeAstroProgress(
  listener: (data: AstroProgressEvent) => void
): EmitterSubscription {
  return DeviceEventEmitter.addListener('onAstroProgress', listener);
}

/**
 * Formats a nanosecond shutter duration into standard camera markings (e.g., 1/4000s, 0.8s, 8.0s).
 */
export function formatExposureNs(ns: number): string {
  if (!ns || ns <= 0) return '1/60s';
  const sec = ns / 1_000_000_000;
  if (sec >= 0.4) {
    return `${sec.toFixed(1)}s`;
  }
  const denom = Math.max(1, Math.round(1 / sec));
  return `1/${denom}s`;
}
