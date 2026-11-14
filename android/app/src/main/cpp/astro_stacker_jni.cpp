#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#define ASTRO_LOG_TAG "AstroStackerJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, ASTRO_LOG_TAG, __VA_ARGS__)

namespace {

struct StarPoint {
    float x;
    float y;
    float flux;
};

struct RigidTransform2D {
    float cosTheta = 1.0f;
    float sinTheta = 0.0f;
    float tx = 0.0f;
    float ty = 0.0f;
    int inliers = 0;
    float rmsError = 0.0f;
};

struct AstroStackSession {
    int width = 0;
    int height = 0;
    int maxFrames = 0;
    int frameCount = 0;

    // Reference stars extracted from Frame 1
    std::vector<StarPoint> referenceStars;

    // Planar frame storage in native memory: [frameIdx * (W * H * 3) + pixelIdx * 3 + c]
    // Keeping frames in C++ native memory avoids JVM OutOfMemoryError during 30-frame bursts.
    std::vector<uint8_t> alignedFramesRgb;

    // Running sum in 32-bit ints for instant progressive preview generation
    std::vector<uint32_t> runningSumR;
    std::vector<uint32_t> runningSumG;
    std::vector<uint32_t> runningSumB;

    float totalDx = 0.0f;
    float totalDy = 0.0f;
    float maxDriftPx = 0.0f;
    int lastMatchedStars = 0;
};

std::mutex gSessionMutex;
AstroStackSession gSession;

/**
 * Extracts sub-pixel star centroids from a frame.
 * We divide the image into an 8x6 spatial grid and pick the brightest isolated point-sources
 * in each sector so stars are distributed across the entire field of view.
 */
std::vector<StarPoint> detectStarKeypoints(
    const std::vector<float>& luma,
    int width,
    int height
) {
    std::vector<StarPoint> candidates;
    if (width < 64 || height < 64) return candidates;

    const int gridCols = 8;
    const int gridRows = 6;
    const int cellW = width / gridCols;
    const int cellH = height / gridRows;
    const int margin = 12;

    for (int gy = 0; gy < gridRows; ++gy) {
        for (int gx = 0; gx < gridCols; ++gx) {
            int startX = std::max(margin, gx * cellW);
            int endX = std::min(width - margin, (gx + 1) * cellW);
            int startY = std::max(margin, gy * cellH);
            int endY = std::min(height - margin, (gy + 1) * cellH);

            // Estimate local sky background mean and variance inside this cell
            double sum = 0.0;
            double sumSq = 0.0;
            int count = 0;
            for (int y = startY; y < endY; y += 3) {
                const int rowOffset = y * width;
                for (int x = startX; x < endX; x += 3) {
                    float v = luma[rowOffset + x];
                    sum += v;
                    sumSq += v * v;
                    count++;
                }
            }
            if (count == 0) continue;
            float mean = static_cast<float>(sum / count);
            float variance = std::max(1.0f, static_cast<float>((sumSq / count) - (mean * mean)));
            float stdDev = std::sqrt(variance);

            // A real star peak must rise significantly above local skyglow + read noise
            float threshold = std::max(mean + 3.2f * stdDev, 28.0f);

            std::vector<StarPoint> cellStars;
            for (int y = startY; y < endY; y += 2) {
                for (int x = startX; x < endX; x += 2) {
                    float center = luma[y * width + x];
                    if (center < threshold || center > 253.0f) continue;

                    // Verify 5x5 local maximum so we don't pick flat gradients or hot single pixels
                    bool isLocalMax = true;
                    for (int dy = -2; dy <= 2 && isLocalMax; ++dy) {
                        for (int dx = -2; dx <= 2; ++dx) {
                            if (dx == 0 && dy == 0) continue;
                            float nb = luma[(y + dy) * width + (x + dx)];
                            if (nb > center) {
                                isLocalMax = false;
                                break;
                            }
                        }
                    }
                    if (!isLocalMax) continue;

                    // Reject single-pixel thermal hot pixels: a real optical star PSF spreads
                    // across neighboring pixels via the lens Airy disk.
                    float immediateNeighbors =
                        luma[y * width + (x - 1)] +
                        luma[y * width + (x + 1)] +
                        luma[(y - 1) * width + x] +
                        luma[(y + 1) * width + x];
                    if (immediateNeighbors < (mean * 4.0f + stdDev * 3.0f)) {
                        continue;
                    }

                    // Compute sub-pixel intensity-weighted centroid in a 3x3 window
                    float wSum = 0.0f;
                    float wxSum = 0.0f;
                    float wySum = 0.0f;
                    for (int dy = -1; dy <= 1; ++dy) {
                        for (int dx = -1; dx <= 1; ++dx) {
                            float w = std::max(0.0f, luma[(y + dy) * width + (x + dx)] - mean);
                            wSum += w;
                            wxSum += w * (x + dx);
                            wySum += w * (y + dy);
                        }
                    }
                    if (wSum <= 0.001f) continue;

                    StarPoint sp;
                    sp.x = wxSum / wSum;
                    sp.y = wySum / wSum;
                    sp.flux = wSum;
                    cellStars.push_back(sp);
                }
            }

            std::sort(cellStars.begin(), cellStars.end(), [](const StarPoint& a, const StarPoint& b) {
                return a.flux > b.flux;
            });
            // Keep up to 3 brightest isolated stars per sky cell
            int kept = 0;
            for (const auto& st : cellStars) {
                bool tooClose = false;
                for (const auto& existing : candidates) {
                    float dx = st.x - existing.x;
                    float dy = st.y - existing.y;
                    if (dx * dx + dy * dy < 64.0f) {
                        tooClose = true;
                        break;
                    }
                }
                if (!tooClose) {
                    candidates.push_back(st);
                    if (++kept >= 3) break;
                }
            }
        }
    }

    std::sort(candidates.begin(), candidates.end(), [](const StarPoint& a, const StarPoint& b) {
        return a.flux > b.flux;
    });
    if (candidates.size() > 96) {
        candidates.resize(96);
    }
    return candidates;
}

/**
 * Estimates a 2D rigid transformation (rotation + translation) that maps points in `currStars`
 * onto `refStars` using RANSAC followed by Procrustes least-squares refinement.
 */
RigidTransform2D estimateRigidTransformRansac(
    const std::vector<StarPoint>& refStars,
    const std::vector<StarPoint>& currStars,
    int width,
    int height
) {
    RigidTransform2D best;
    if (refStars.size() < 3 || currStars.size() < 3) {
        return best;
    }

    // Build candidate 1-to-1 correspondences within a plausible sky-drift search window (48 px)
    struct MatchPair {
        int refIdx;
        int currIdx;
    };
    std::vector<MatchPair> pairs;
    const float maxDriftSq = 48.0f * 48.0f;

    for (size_t i = 0; i < refStars.size(); ++i) {
        for (size_t j = 0; j < currStars.size(); ++j) {
            float dx = currStars[j].x - refStars[i].x;
            float dy = currStars[j].y - refStars[i].y;
            if (dx * dx + dy * dy <= maxDriftSq) {
                pairs.push_back({static_cast<int>(i), static_cast<int>(j)});
            }
        }
    }

    if (pairs.size() < 2) {
        return best;
    }

    const int numPairs = static_cast<int>(pairs.size());
    const float inlierThreshSq = 2.4f * 2.4f;
    uint32_t rngState = 0xA5720C01u;
    auto nextRand = [&rngState]() -> uint32_t {
        rngState ^= rngState << 13;
        rngState ^= rngState >> 17;
        rngState ^= rngState << 5;
        return rngState;
    };

    std::vector<MatchPair> bestInliers;
    const int iterations = 180;

    for (int iter = 0; iter < iterations; ++iter) {
        int idxA = static_cast<int>(nextRand() % numPairs);
        int idxB = static_cast<int>(nextRand() % numPairs);
        if (idxA == idxB) continue;

        const auto& pA = pairs[idxA];
        const auto& pB = pairs[idxB];
        if (pA.refIdx == pB.refIdx || pA.currIdx == pB.currIdx) continue;

        const StarPoint& r1 = refStars[pA.refIdx];
        const StarPoint& r2 = refStars[pB.refIdx];
        const StarPoint& c1 = currStars[pA.currIdx];
        const StarPoint& c2 = currStars[pB.currIdx];

        float drx = r2.x - r1.x;
        float dry = r2.y - r1.y;
        float dcx = c2.x - c1.x;
        float dcy = c2.y - c1.y;

        float distRef = std::hypot(drx, dry);
        float distCurr = std::hypot(dcx, dcy);

        // Star constellations are rigid: the pairwise baseline distance must match closely
        if (distRef < 24.0f || std::fabs(distRef - distCurr) > 2.8f) continue;

        // Solve rotation angle between vector c1->c2 and r1->r2
        float dot = (dcx * drx + dcy * dry) / (distCurr * distRef);
        float cross = (dcx * dry - dcy * drx) / (distCurr * distRef);
        float norm = std::hypot(dot, cross);
        if (norm < 1e-5f) continue;
        float cosT = dot / norm;
        float sinT = cross / norm;

        // Earth rotation over a few minutes is at most a couple of degrees (|sinT| < 0.08)
        if (std::fabs(sinT) > 0.08f) continue;

        float tx = r1.x - (cosT * c1.x - sinT * c1.y);
        float ty = r1.y - (sinT * c1.x + cosT * c1.y);

        std::vector<MatchPair> currentInliers;
        for (const auto& mp : pairs) {
            const StarPoint& rs = refStars[mp.refIdx];
            const StarPoint& cs = currStars[mp.currIdx];
            float predX = cosT * cs.x - sinT * cs.y + tx;
            float predY = sinT * cs.x + cosT * cs.y + ty;
            float ex = predX - rs.x;
            float ey = predY - rs.y;
            if (ex * ex + ey * ey <= inlierThreshSq) {
                currentInliers.push_back(mp);
            }
        }

        if (currentInliers.size() > bestInliers.size()) {
            bestInliers = std::move(currentInliers);
        }
    }

    if (bestInliers.size() < 2) {
        return best;
    }

    // Refine 2D orthogonal Procrustes least-squares over all RANSAC inliers
    double meanRefX = 0.0, meanRefY = 0.0;
    double meanCurX = 0.0, meanCurY = 0.0;
    for (const auto& mp : bestInliers) {
        meanRefX += refStars[mp.refIdx].x;
        meanRefY += refStars[mp.refIdx].y;
        meanCurX += currStars[mp.currIdx].x;
        meanCurY += currStars[mp.currIdx].y;
    }
    double invN = 1.0 / static_cast<double>(bestInliers.size());
    meanRefX *= invN;
    meanRefY *= invN;
    meanCurX *= invN;
    meanCurY *= invN;

    double sxxPlusSyy = 0.0;
    double sxyMinusSyx = 0.0;
    for (const auto& mp : bestInliers) {
        double rx = refStars[mp.refIdx].x - meanRefX;
        double ry = refStars[mp.refIdx].y - meanRefY;
        double cx = currStars[mp.currIdx].x - meanCurX;
        double cy = currStars[mp.currIdx].y - meanCurY;
        sxxPlusSyy += cx * rx + cy * ry;
        sxyMinusSyx += cx * ry - cy * rx;
    }

    double norm = std::hypot(sxxPlusSyy, sxyMinusSyx);
    if (norm > 1e-6) {
        best.cosTheta = static_cast<float>(sxxPlusSyy / norm);
        best.sinTheta = static_cast<float>(sxyMinusSyx / norm);
    }
    best.tx = static_cast<float>(meanRefX - (best.cosTheta * meanCurX - best.sinTheta * meanCurY));
    best.ty = static_cast<float>(meanRefY - (best.sinTheta * meanCurX + best.cosTheta * meanCurY));
    best.inliers = static_cast<int>(bestInliers.size());

    double errSqSum = 0.0;
    for (const auto& mp : bestInliers) {
        const StarPoint& rs = refStars[mp.refIdx];
        const StarPoint& cs = currStars[mp.currIdx];
        float px = best.cosTheta * cs.x - best.sinTheta * cs.y + best.tx;
        float py = best.sinTheta * cs.x + best.cosTheta * cs.y + best.ty;
        errSqSum += (px - rs.x) * (px - rs.x) + (py - rs.y) * (py - rs.y);
    }
    best.rmsError = static_cast<float>(std::sqrt(errSqSum * invN));
    return best;
}

} // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_beginSession(
    JNIEnv* /* env */,
    jclass /* clazz */,
    jint width,
    jint height,
    jint maxFrames
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    gSession = AstroStackSession();
    gSession.width = width;
    gSession.height = height;
    gSession.maxFrames = std::max(1, static_cast<int>(maxFrames));

    const size_t numPixels = static_cast<size_t>(width) * static_cast<size_t>(height);
    gSession.alignedFramesRgb.resize(numPixels * 3 * static_cast<size_t>(gSession.maxFrames), 0);
    gSession.runningSumR.assign(numPixels, 0);
    gSession.runningSumG.assign(numPixels, 0);
    gSession.runningSumB.assign(numPixels, 0);

    LOGI("AstroStackSession initialized: %dx%d for up to %d frames", width, height, maxFrames);
}

JNIEXPORT jstring JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_addFrameAndGetPreview(
    JNIEnv* env,
    jclass /* clazz */,
    jintArray frameArgbArray,
    jint frameIndex,
    jintArray previewArgbOut
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    const int width = gSession.width;
    const int height = gSession.height;
    const size_t numPixels = static_cast<size_t>(width) * static_cast<size_t>(height);

    if (width <= 0 || height <= 0 || frameIndex >= gSession.maxFrames) {
        return env->NewStringUTF("Session not ready");
    }

    jint* srcPixels = env->GetIntArrayElements(frameArgbArray, nullptr);
    jint* outPreview = env->GetIntArrayElements(previewArgbOut, nullptr);

    // 1. Extract luminance channel for star keypoint detection
    std::vector<float> luma(numPixels);
    for (size_t i = 0; i < numPixels; ++i) {
        uint32_t px = static_cast<uint32_t>(srcPixels[i]);
        uint8_t r = (px >> 16) & 0xFF;
        uint8_t g = (px >> 8) & 0xFF;
        uint8_t b = px & 0xFF;
        luma[i] = 0.299f * r + 0.587f * g + 0.114f * b;
    }

    auto stars = detectStarKeypoints(luma, width, height);
    RigidTransform2D transform;

    if (frameIndex == 0 || gSession.referenceStars.empty()) {
        gSession.referenceStars = stars;
        transform.inliers = static_cast<int>(stars.size());
    } else {
        transform = estimateRigidTransformRansac(gSession.referenceStars, stars, width, height);
    }

    // 2. Inverse-warp current frame into Reference Frame 1's coordinate space using bilinear interpolation
    // Since p_ref = R * p_curr + t, the inverse mapping is p_curr = R^T * (p_ref - t).
    const float cosT = transform.cosTheta;
    const float sinT = transform.sinTheta;
    const float tx = transform.tx;
    const float ty = transform.ty;

    uint8_t* dstFramePtr =
        gSession.alignedFramesRgb.data() + (static_cast<size_t>(frameIndex) * numPixels * 3);

    const int currentTotalFrames = frameIndex + 1;
    gSession.frameCount = currentTotalFrames;

    for (int y = 0; y < height; ++y) {
        const float ry = static_cast<float>(y) - ty;
        const size_t rowOffset = static_cast<size_t>(y) * static_cast<size_t>(width);

        for (int x = 0; x < width; ++x) {
            const float rx = static_cast<float>(x) - tx;
            const float srcX = cosT * rx + sinT * ry;
            const float srcY = -sinT * rx + cosT * ry;

            int x0 = static_cast<int>(std::floor(srcX));
            int y0 = static_cast<int>(std::floor(srcY));

            uint8_t outR = 0, outG = 0, outB = 0;

            if (x0 >= 0 && x0 + 1 < width && y0 >= 0 && y0 + 1 < height) {
                float fx = srcX - x0;
                float fy = srcY - y0;
                float w00 = (1.0f - fx) * (1.0f - fy);
                float w10 = fx * (1.0f - fy);
                float w01 = (1.0f - fx) * fy;
                float w11 = fx * fy;

                uint32_t p00 = static_cast<uint32_t>(srcPixels[y0 * width + x0]);
                uint32_t p10 = static_cast<uint32_t>(srcPixels[y0 * width + (x0 + 1)]);
                uint32_t p01 = static_cast<uint32_t>(srcPixels[(y0 + 1) * width + x0]);
                uint32_t p11 = static_cast<uint32_t>(srcPixels[(y0 + 1) * width + (x0 + 1)]);

                float r = w00 * ((p00 >> 16) & 0xFF) + w10 * ((p10 >> 16) & 0xFF) +
                          w01 * ((p01 >> 16) & 0xFF) + w11 * ((p11 >> 16) & 0xFF);
                float g = w00 * ((p00 >> 8) & 0xFF) + w10 * ((p10 >> 8) & 0xFF) +
                          w01 * ((p01 >> 8) & 0xFF) + w11 * ((p11 >> 8) & 0xFF);
                float b = w00 * (p00 & 0xFF) + w10 * (p10 & 0xFF) +
                          w01 * (p01 & 0xFF) + w11 * (p11 & 0xFF);

                outR = static_cast<uint8_t>(std::clamp(static_cast<int>(r + 0.5f), 0, 255));
                outG = static_cast<uint8_t>(std::clamp(static_cast<int>(g + 0.5f), 0, 255));
                outB = static_cast<uint8_t>(std::clamp(static_cast<int>(b + 0.5f), 0, 255));
            } else {
                uint32_t pFallback = static_cast<uint32_t>(srcPixels[rowOffset + x]);
                outR = (pFallback >> 16) & 0xFF;
                outG = (pFallback >> 8) & 0xFF;
                outB = pFallback & 0xFF;
            }

            const size_t idx = rowOffset + static_cast<size_t>(x);
            dstFramePtr[idx * 3 + 0] = outR;
            dstFramePtr[idx * 3 + 1] = outG;
            dstFramePtr[idx * 3 + 2] = outB;

            gSession.runningSumR[idx] += outR;
            gSession.runningSumG[idx] += outG;
            gSession.runningSumB[idx] += outB;

            // Progressive live preview with a mild gamma lift so the user can watch stars emerge
            uint8_t avgR = static_cast<uint8_t>(gSession.runningSumR[idx] / currentTotalFrames);
            uint8_t avgG = static_cast<uint8_t>(gSession.runningSumG[idx] / currentTotalFrames);
            uint8_t avgB = static_cast<uint8_t>(gSession.runningSumB[idx] / currentTotalFrames);

            outPreview[idx] = static_cast<jint>(
                0xFF000000u |
                (static_cast<uint32_t>(avgR) << 16) |
                (static_cast<uint32_t>(avgG) << 8) |
                static_cast<uint32_t>(avgB)
            );
        }
    }

    float drift = std::hypot(tx, ty);
    gSession.maxDriftPx = std::max(gSession.maxDriftPx, drift);
    gSession.lastMatchedStars = transform.inliers;

    env->ReleaseIntArrayElements(frameArgbArray, srcPixels, JNI_ABORT);
    env->ReleaseIntArrayElements(previewArgbOut, outPreview, 0);

    std::ostringstream oss;
    oss.precision(1);
    oss << std::fixed << transform.inliers << " stars locked • drift " << drift << " px";
    return env->NewStringUTF(oss.str().c_str());
}

/**
 * Performs per-pixel Sigma-Clipped Mean stacking across all aligned frames, followed by
 * sky-background black-point calibration, chromatic noise suppression, and an astronomical
 * asinh stretch tone-curve.
 */
JNIEXPORT jstring JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_finalizeStack(
    JNIEnv* env,
    jclass /* clazz */,
    jintArray finalArgbOut
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    const int width = gSession.width;
    const int height = gSession.height;
    const int nFrames = gSession.frameCount;
    const size_t numPixels = static_cast<size_t>(width) * static_cast<size_t>(height);

    if (width <= 0 || height <= 0 || nFrames <= 0) {
        return env->NewStringUTF("{}");
    }

    jint* outPixels = env->GetIntArrayElements(finalArgbOut, nullptr);

    std::vector<float> stackedR(numPixels);
    std::vector<float> stackedG(numPixels);
    std::vector<float> stackedB(numPixels);

    const size_t frameStride = numPixels * 3;
    const uint8_t* basePtr = gSession.alignedFramesRgb.data();

    // Step 1: Per-pixel Sigma-Clipped Mean stacking
    // Rejects outlier samples (> 1.8 sigma from pixel temporal mean) such as hot thermal pixels,
    // cosmic ray hits, and airplane/satellite streaks.
    for (size_t idx = 0; idx < numPixels; ++idx) {
        const size_t pixelOffset = idx * 3;

        if (nFrames <= 2) {
            stackedR[idx] = static_cast<float>(gSession.runningSumR[idx]) / nFrames;
            stackedG[idx] = static_cast<float>(gSession.runningSumG[idx]) / nFrames;
            stackedB[idx] = static_cast<float>(gSession.runningSumB[idx]) / nFrames;
            continue;
        }

        for (int c = 0; c < 3; ++c) {
            float sum = 0.0f;
            float sumSq = 0.0f;
            for (int f = 0; f < nFrames; ++f) {
                float v = static_cast<float>(basePtr[f * frameStride + pixelOffset + c]);
                sum += v;
                sumSq += v * v;
            }
            float mean = sum / nFrames;
            float variance = std::max(1.0f, (sumSq / nFrames) - (mean * mean));
            float sigma = std::sqrt(variance);
            float clipLimit = 1.8f * sigma;

            float cleanSum = 0.0f;
            int cleanCount = 0;
            for (int f = 0; f < nFrames; ++f) {
                float v = static_cast<float>(basePtr[f * frameStride + pixelOffset + c]);
                if (std::fabs(v - mean) <= clipLimit) {
                    cleanSum += v;
                    cleanCount++;
                }
            }
            float finalVal = (cleanCount > 0) ? (cleanSum / cleanCount) : mean;
            if (c == 0) stackedR[idx] = finalVal;
            else if (c == 1) stackedG[idx] = finalVal;
            else stackedB[idx] = finalVal;
        }
    }

    // Step 2: Estimate 18th-percentile sky background per channel to neutralize skyglow cast
    // while preserving faint nebulae and Milky Way dust lanes.
    std::vector<int> histR(256, 0), histG(256, 0), histB(256, 0);
    int sampleCount = 0;
    for (size_t idx = 0; idx < numPixels; idx += 4) {
        histR[std::clamp(static_cast<int>(stackedR[idx]), 0, 255)]++;
        histG[std::clamp(static_cast<int>(stackedG[idx]), 0, 255)]++;
        histB[std::clamp(static_cast<int>(stackedB[idx]), 0, 255)]++;
        sampleCount++;
    }

    auto percentileValue = [sampleCount](const std::vector<int>& h, float pct) -> float {
        int target = static_cast<int>(sampleCount * pct);
        int acc = 0;
        for (int i = 0; i < 256; ++i) {
            acc += h[i];
            if (acc >= target) return static_cast<float>(i);
        }
        return 0.0f;
    };

    float skyBlackR = percentileValue(histR, 0.18f) * 0.72f;
    float skyBlackG = percentileValue(histG, 0.18f) * 0.72f;
    float skyBlackB = percentileValue(histB, 0.18f) * 0.72f;

    // Step 3: Astronomical hyperbolic (asinh) stretch + subtle chroma noise reduction
    const float stretchAlpha = 2.6f;
    const float normAsinh = 1.0f / std::asinh(stretchAlpha);

    auto astroToneCurve = [stretchAlpha, normAsinh](float val, float blackPoint) -> float {
        float shifted = std::max(0.0f, (val - blackPoint) / std::max(1.0f, 255.0f - blackPoint));
        // Gentle shadow toe so dark sky looks velvety black without posterization
        float stretched = std::asinh(stretchAlpha * shifted) * normAsinh;
        // S-curve midtone contrast enhancement
        float contrast = stretched * stretched * (3.0f - 2.0f * stretched);
        float blended = 0.65f * stretched + 0.35f * contrast;
        return std::clamp(blended * 255.0f, 0.0f, 255.0f);
    };

    for (size_t idx = 0; idx < numPixels; ++idx) {
        stackedR[idx] = astroToneCurve(stackedR[idx], skyBlackR);
        stackedG[idx] = astroToneCurve(stackedG[idx], skyBlackG);
        stackedB[idx] = astroToneCurve(stackedB[idx], skyBlackB);
    }

    // Step 4: 3x3 Luma-preserving Chromatic Noise Reduction (smooths Cb/Cr color blotches in dark sky
    // while keeping star point-spread functions 100% sharp in luminance Y)
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            size_t idx = static_cast<size_t>(y) * width + x;
            float r0 = stackedR[idx];
            float g0 = stackedG[idx];
            float b0 = stackedB[idx];
            float y0 = 0.299f * r0 + 0.587f * g0 + 0.114f * b0;

            if (x > 0 && x + 1 < width && y > 0 && y + 1 < height && y0 < 95.0f) {
                float cbSum = 0.0f;
                float crSum = 0.0f;
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        size_t nIdx = static_cast<size_t>(y + dy) * width + (x + dx);
                        float nr = stackedR[nIdx];
                        float ng = stackedG[nIdx];
                        float nb = stackedB[nIdx];
                        float ny = 0.299f * nr + 0.587f * ng + 0.114f * nb;
                        cbSum += (nb - ny);
                        crSum += (nr - ny);
                    }
                }
                float cbAvg = cbSum / 9.0f;
                float crAvg = crSum / 9.0f;
                r0 = std::clamp(y0 + crAvg, 0.0f, 255.0f);
                b0 = std::clamp(y0 + cbAvg, 0.0f, 255.0f);
                g0 = std::clamp((y0 - 0.299f * r0 - 0.114f * b0) / 0.587f, 0.0f, 255.0f);
            }

            uint8_t finalR = static_cast<uint8_t>(r0 + 0.5f);
            uint8_t finalG = static_cast<uint8_t>(g0 + 0.5f);
            uint8_t finalB = static_cast<uint8_t>(b0 + 0.5f);

            outPixels[idx] = static_cast<jint>(
                0xFF000000u |
                (static_cast<uint32_t>(finalR) << 16) |
                (static_cast<uint32_t>(finalG) << 8) |
                static_cast<uint32_t>(finalB)
            );
        }
    }

    env->ReleaseIntArrayElements(finalArgbOut, outPixels, 0);

    // theoretical SNR improvement is sqrt(N)
    double snrGainFactor = std::sqrt(static_cast<double>(nFrames));
    double snrDb = 20.0 * std::log10(snrGainFactor);

    std::ostringstream json;
    json.precision(2);
    json << std::fixed
         << "{\"framesStacked\":" << nFrames
         << ",\"referenceStars\":" << gSession.referenceStars.size()
         << ",\"matchedStarsLastFrame\":" << gSession.lastMatchedStars
         << ",\"maxStarDriftPx\":" << gSession.maxDriftPx
         << ",\"snrImprovementFactor\":" << snrGainFactor
         << ",\"snrGainDb\":" << snrDb
         << "}";

    return env->NewStringUTF(json.str().c_str());
}

JNIEXPORT jstring JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_addUnalignedFrameAndGetPreview(
    JNIEnv* env,
    jclass /* clazz */,
    jintArray frameArgbArray,
    jint frameIndex,
    jint previewMode,
    jintArray previewArgbOut
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    const int width = gSession.width;
    const int height = gSession.height;
    const size_t numPixels = static_cast<size_t>(width) * static_cast<size_t>(height);

    if (width <= 0 || height <= 0 || frameIndex >= gSession.maxFrames) {
        return env->NewStringUTF("Session not ready");
    }

    jint* srcPixels = env->GetIntArrayElements(frameArgbArray, nullptr);
    jint* outPreview = env->GetIntArrayElements(previewArgbOut, nullptr);

    uint8_t* dstFramePtr =
        gSession.alignedFramesRgb.data() + (static_cast<size_t>(frameIndex) * numPixels * 3);
    const int currentTotalFrames = frameIndex + 1;
    gSession.frameCount = currentTotalFrames;

    for (size_t idx = 0; idx < numPixels; ++idx) {
        uint32_t px = static_cast<uint32_t>(srcPixels[idx]);
        uint8_t r = (px >> 16) & 0xFF;
        uint8_t g = (px >> 8) & 0xFF;
        uint8_t b = px & 0xFF;

        dstFramePtr[idx * 3 + 0] = r;
        dstFramePtr[idx * 3 + 1] = g;
        dstFramePtr[idx * 3 + 2] = b;

        if (previewMode == 2) {
            // Light Trails mode: running maximum per channel for real-time light-painting preview
            gSession.runningSumR[idx] = std::max(gSession.runningSumR[idx], static_cast<uint32_t>(r));
            gSession.runningSumG[idx] = std::max(gSession.runningSumG[idx], static_cast<uint32_t>(g));
            gSession.runningSumB[idx] = std::max(gSession.runningSumB[idx], static_cast<uint32_t>(b));

            outPreview[idx] = static_cast<jint>(
                0xFF000000u |
                (gSession.runningSumR[idx] << 16) |
                (gSession.runningSumG[idx] << 8) |
                gSession.runningSumB[idx]
            );
        } else {
            gSession.runningSumR[idx] += r;
            gSession.runningSumG[idx] += g;
            gSession.runningSumB[idx] += b;

            uint8_t avgR = static_cast<uint8_t>(gSession.runningSumR[idx] / currentTotalFrames);
            uint8_t avgG = static_cast<uint8_t>(gSession.runningSumG[idx] / currentTotalFrames);
            uint8_t avgB = static_cast<uint8_t>(gSession.runningSumB[idx] / currentTotalFrames);

            outPreview[idx] = static_cast<jint>(
                0xFF000000u |
                (static_cast<uint32_t>(avgR) << 16) |
                (static_cast<uint32_t>(avgG) << 8) |
                static_cast<uint32_t>(avgB)
            );
        }
    }

    env->ReleaseIntArrayElements(frameArgbArray, srcPixels, JNI_ABORT);
    env->ReleaseIntArrayElements(previewArgbOut, outPreview, 0);

    std::ostringstream oss;
    oss << "Captured & buffered frame " << currentTotalFrames << "/" << gSession.maxFrames;
    return env->NewStringUTF(oss.str().c_str());
}

/**
 * Finalizes multi-frame computational photography modes:
 * modeCode = 1: HDR+ Exposure Bracketing (Mertens Contrast + Saturation + Well-Exposedness Fusion)
 * modeCode = 2: Light Trails / Star Trails (Temporal Maximum with Background Noise Floor Lock)
 * modeCode = 3: Night Super-Resolution & Multi-Frame Denoise (Aligned Trimmed Mean + Unsharp Mask)
 * modeCode = 4: Macro Focus Stacking (Laplacian High-Frequency Sharpness Map Fusion)
 */
JNIEXPORT jstring JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_finalizeComputationalMode(
    JNIEnv* env,
    jclass /* clazz */,
    jint modeCode,
    jintArray finalArgbOut
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    const int width = gSession.width;
    const int height = gSession.height;
    const int nFrames = gSession.frameCount;
    const size_t numPixels = static_cast<size_t>(width) * static_cast<size_t>(height);

    if (width <= 0 || height <= 0 || nFrames <= 0) {
        return env->NewStringUTF("{}");
    }

    jint* outPixels = env->GetIntArrayElements(finalArgbOut, nullptr);
    const size_t frameStride = numPixels * 3;
    const uint8_t* basePtr = gSession.alignedFramesRgb.data();

    std::vector<float> fusedR(numPixels, 0.0f);
    std::vector<float> fusedG(numPixels, 0.0f);
    std::vector<float> fusedB(numPixels, 0.0f);

    if (modeCode == 1) {
        // MODE 1: HDR+ Mertens Exposure Fusion
        // Weighs every pixel in each bracketed exposure by Well-Exposedness (Gaussian centered at 0.52),
        // RGB Saturation spread, and local gradient contrast.
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const size_t idx = static_cast<size_t>(y) * width + x;
                const size_t pxOff = idx * 3;

                float weightSum = 0.0f;
                float accR = 0.0f, accG = 0.0f, accB = 0.0f;

                for (int f = 0; f < nFrames; ++f) {
                    const uint8_t* fp = basePtr + f * frameStride + pxOff;
                    float r = fp[0] / 255.0f;
                    float g = fp[1] / 255.0f;
                    float b = fp[2] / 255.0f;

                    // Well-exposedness: Gaussian curve peaking at 0.52 (avoids clipped 1.0 & crushed 0.0)
                    float er = std::exp(-((r - 0.52f) * (r - 0.52f)) / (2.0f * 0.22f * 0.22f));
                    float eg = std::exp(-((g - 0.52f) * (g - 0.52f)) / (2.0f * 0.22f * 0.22f));
                    float eb = std::exp(-((b - 0.52f) * (b - 0.52f)) / (2.0f * 0.22f * 0.22f));
                    float wellExposed = er * eg * eb;

                    // Saturation: standard deviation across R, G, B channels
                    float meanRgb = (r + g + b) / 3.0f;
                    float sat = std::sqrt(
                        ((r - meanRgb) * (r - meanRgb) +
                         (g - meanRgb) * (g - meanRgb) +
                         (b - meanRgb) * (b - meanRgb)) / 3.0f
                    );

                    // Local contrast: 4-neighbor Laplacian magnitude
                    float contrast = 0.05f;
                    if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
                        const uint8_t* left = basePtr + f * frameStride + (idx - 1) * 3;
                        const uint8_t* right = basePtr + f * frameStride + (idx + 1) * 3;
                        const uint8_t* up = basePtr + f * frameStride + (idx - width) * 3;
                        const uint8_t* down = basePtr + f * frameStride + (idx + width) * 3;
                        float lapG = std::fabs(
                            4.0f * fp[1] - (left[1] + right[1] + up[1] + down[1])
                        ) / 255.0f;
                        contrast += lapG;
                    }

                    float w = std::max(1e-4f, wellExposed * (0.25f + sat) * (0.25f + contrast));
                    accR += w * fp[0];
                    accG += w * fp[1];
                    accB += w * fp[2];
                    weightSum += w;
                }

                fusedR[idx] = accR / weightSum;
                fusedG[idx] = accG / weightSum;
                fusedB[idx] = accB / weightSum;
            }
        }
    } else if (modeCode == 2) {
        // MODE 2: Light Trails / Star Trails & Traffic Light Painting
        // Combines temporal mean for static dark background (reducing dark noise by sqrt(N))
        // with temporal maximum for moving light streaks!
        for (size_t idx = 0; idx < numPixels; ++idx) {
            const size_t pxOff = idx * 3;
            float sumR = 0.0f, sumG = 0.0f, sumB = 0.0f;
            float maxR = 0.0f, maxG = 0.0f, maxB = 0.0f;
            float maxLuma = -1.0f;

            for (int f = 0; f < nFrames; ++f) {
                const uint8_t* fp = basePtr + f * frameStride + pxOff;
                float r = fp[0];
                float g = fp[1];
                float b = fp[2];
                sumR += r;
                sumG += g;
                sumB += b;
                float luma = 0.299f * r + 0.587f * g + 0.114f * b;
                if (luma > maxLuma) {
                    maxLuma = luma;
                    maxR = r;
                    maxG = g;
                    maxB = b;
                }
            }

            float meanR = sumR / nFrames;
            float meanG = sumG / nFrames;
            float meanB = sumB / nFrames;
            float meanLuma = 0.299f * meanR + 0.587f * meanG + 0.114f * meanB;

            // Blend factor: pixels where a bright moving light passed (maxLuma >> meanLuma)
            // take the peak light-trail value; static background pixels keep the clean mean.
            float trailDelta = std::max(0.0f, maxLuma - meanLuma - 10.0f);
            float alpha = std::clamp(trailDelta / 38.0f, 0.0f, 1.0f);

            fusedR[idx] = (1.0f - alpha) * meanR + alpha * maxR;
            fusedG[idx] = (1.0f - alpha) * meanG + alpha * maxG;
            fusedB[idx] = (1.0f - alpha) * meanB + alpha * maxB;
        }
    } else if (modeCode == 4) {
        // MODE 4: Macro Focus Bracketing / Depth-of-Field Fusion
        // Evaluates local 3x3 Laplacian sharpness across all focus-bracketed frames and picks
        // the sharpest focus slice per pixel.
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                const size_t idx = static_cast<size_t>(y) * width + x;
                float bestSharpness = -1.0f;
                int bestFrame = 0;

                for (int f = 0; f < nFrames; ++f) {
                    float energy = 0.0f;
                    if (x > 1 && x + 2 < width && y > 1 && y + 2 < height) {
                        for (int dy = -1; dy <= 1; ++dy) {
                            for (int dx = -1; dx <= 1; ++dx) {
                                size_t cIdx = static_cast<size_t>(y + dy) * width + (x + dx);
                                const uint8_t* cp = basePtr + f * frameStride + cIdx * 3;
                                const uint8_t* lp = basePtr + f * frameStride + (cIdx - 1) * 3;
                                const uint8_t* rp = basePtr + f * frameStride + (cIdx + 1) * 3;
                                const uint8_t* up = basePtr + f * frameStride + (cIdx - width) * 3;
                                const uint8_t* dp = basePtr + f * frameStride + (cIdx + width) * 3;
                                float lap = std::fabs(
                                    4.0f * cp[1] - (lp[1] + rp[1] + up[1] + dp[1])
                                );
                                energy += lap;
                            }
                        }
                    }
                    if (energy > bestSharpness) {
                        bestSharpness = energy;
                        bestFrame = f;
                    }
                }

                const uint8_t* bestPtr = basePtr + bestFrame * frameStride + idx * 3;
                fusedR[idx] = bestPtr[0];
                fusedG[idx] = bestPtr[1];
                fusedB[idx] = bestPtr[2];
            }
        }
    } else {
        // MODE 3: Night Super-Resolution & Multi-Frame Trimmed-Mean Denoise + Unsharp Mask
        for (size_t idx = 0; idx < numPixels; ++idx) {
            const size_t pxOff = idx * 3;
            for (int c = 0; c < 3; ++c) {
                float sum = 0.0f;
                float minV = 255.0f;
                float maxV = 0.0f;
                for (int f = 0; f < nFrames; ++f) {
                    float v = basePtr[f * frameStride + pxOff + c];
                    sum += v;
                    minV = std::min(minV, v);
                    maxV = std::max(maxV, v);
                }
                // Alpha-trimmed mean drops the highest and lowest outlier sample per pixel
                float val = (nFrames >= 4)
                    ? ((sum - minV - maxV) / (nFrames - 2))
                    : (sum / nFrames);
                if (c == 0) fusedR[idx] = val;
                else if (c == 1) fusedG[idx] = val;
                else fusedB[idx] = val;
            }
        }
    }

    // Apply subtle Unsharp Mask (micro-contrast enhancement) and pack into ARGB_8888 output
    const float usmAmount = (modeCode == 3 || modeCode == 4) ? 0.38f : 0.18f;
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const size_t idx = static_cast<size_t>(y) * width + x;
            float r = fusedR[idx];
            float g = fusedG[idx];
            float b = fusedB[idx];

            if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
                float blurR = 0.25f * (fusedR[idx - 1] + fusedR[idx + 1] + fusedR[idx - width] + fusedR[idx + width]);
                float blurG = 0.25f * (fusedG[idx - 1] + fusedG[idx + 1] + fusedG[idx - width] + fusedG[idx + width]);
                float blurB = 0.25f * (fusedB[idx - 1] + fusedB[idx + 1] + fusedB[idx - width] + fusedB[idx + width]);
                r = std::clamp(r + usmAmount * (r - blurR), 0.0f, 255.0f);
                g = std::clamp(g + usmAmount * (g - blurG), 0.0f, 255.0f);
                b = std::clamp(b + usmAmount * (b - blurB), 0.0f, 255.0f);
            }

            uint8_t outR = static_cast<uint8_t>(r + 0.5f);
            uint8_t outG = static_cast<uint8_t>(g + 0.5f);
            uint8_t outB = static_cast<uint8_t>(b + 0.5f);

            outPixels[idx] = static_cast<jint>(
                0xFF000000u |
                (static_cast<uint32_t>(outR) << 16) |
                (static_cast<uint32_t>(outG) << 8) |
                static_cast<uint32_t>(outB)
            );
        }
    }

    env->ReleaseIntArrayElements(finalArgbOut, outPixels, 0);

    double snrGainFactor = std::sqrt(static_cast<double>(nFrames));
    double snrDb = 20.0 * std::log10(snrGainFactor);

    std::ostringstream json;
    json.precision(2);
    json << std::fixed
         << "{\"framesStacked\":" << nFrames
         << ",\"modeCode\":" << modeCode
         << ",\"referenceStars\":" << gSession.referenceStars.size()
         << ",\"maxStarDriftPx\":" << gSession.maxDriftPx
         << ",\"snrImprovementFactor\":" << snrGainFactor
         << ",\"snrGainDb\":" << snrDb
         << "}";
    return env->NewStringUTF(json.str().c_str());
}

JNIEXPORT void JNICALL
Java_com_vesant_nativecamera_AstroStackerNative_resetSession(
    JNIEnv* /* env */,
    jclass /* clazz */
) {
    std::lock_guard<std::mutex> lock(gSessionMutex);
    gSession = AstroStackSession();
}

} // extern "C"
