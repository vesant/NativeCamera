import { NativeModules, Platform } from 'react-native';

export interface StreamFormatSupport {
  name: 'RAW_SENSOR' | 'RAW10' | 'RAW12' | 'YUV_420_888' | 'JPEG' | string;
  description: string;
  supported: boolean;
  maxResolution: string;
}

export interface CameraSensorCharacteristics {
  cameraId: string;
  facing: 'Back' | 'Front' | 'External' | 'Unknown';
  lensRole: string;
  isPublicCameraId: boolean;
  isLogicalMultiCamera: boolean;
  sensorTypeLabel: string;
  physicalSubIds: string[];
  hardwareLevel: 'LEVEL_3' | 'FULL' | 'LIMITED' | 'LEGACY' | 'EXTERNAL' | 'UNKNOWN';
  hardwareLevelSummary: string;
  supportsFullManual: boolean;
  supportsRaw: boolean;
  supportsManualPostProcessing: boolean;

  // Physical sensor geometry
  sensorWidthMm: number;
  sensorHeightMm: number;
  sensorDiagonalMm: number;
  pixelArrayWidth: number;
  pixelArrayHeight: number;
  activeArrayWidth: number;
  activeArrayHeight: number;
  megapixels: number;
  pixelPitchUm: number;
  cropFactor35mm: number;
  cfaPattern: string;

  // Optics & lens
  apertures: number[];
  focalLengthsMm: number[];
  equivFocalLength35mm: number;
  minFocusDistanceDiopters: number;
  minFocusDistanceCm: number;
  focusCalibration: string;
  supportsOis: boolean;
  distortionModes: string[];

  // Exposure & ISO limits
  minIso: number;
  maxIso: number;
  maxAnalogIso: number;
  minExposureNs: number;
  maxExposureNs: number;
  minExposureFormatted: string;
  maxExposureFormatted: string;

  // Stream formats
  streamFormats: StreamFormatSupport[];
}

export interface CameraInspectionReport {
  deviceManufacturer: string;
  deviceModel: string;
  socModel: string;
  androidRelease: string;
  sdkInt: number;
  sensors: CameraSensorCharacteristics[];
  jsonReport: string;
}

interface NativeCameraInspectorSpec {
  inspectAllCameras(): Promise<CameraInspectionReport>;
}

const NativeCameraInspector = NativeModules.CameraInspectorModule as
  | NativeCameraInspectorSpec
  | undefined;

/**
 * Queries the native Android Camera2 CameraInspectorModule for all logical
 * and physical sensors on the handset.
 */
export async function inspectDeviceCameras(): Promise<CameraInspectionReport> {
  if (Platform.OS !== 'android' || !NativeCameraInspector) {
    throw new Error('CameraInspectorModule is only available on native Android builds.');
  }
  return await NativeCameraInspector.inspectAllCameras();
}
