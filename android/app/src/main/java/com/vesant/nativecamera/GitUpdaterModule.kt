package com.vesant.nativecamera

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * Self-contained Git Over-The-Air (OTA) Bundle & APK Updater (`GitUpdaterModule`).
 *
 * Allows the phone to fetch new features directly from `https://github.com/vesant/NativeCamera`
 * over Wi-Fi / 5G without needing a USB debugging (`adb`) connection:
 * 1. **Instant Hermes Bytecode OTA Hot-Swap:** Downloads `ota/index.android.bundle` from the GitHub
 *    repository, verifies its SHA-256 checksum against `ota/manifest.json`, writes it to internal
 *    storage (`filesDir/git_ota/index.android.bundle`), and hot-restarts the app process so
 *    `MainApplication` boots directly into the new bundle.
 * 2. **Crash-Safe Boot Guard:** Tracks consecutive boot attempts in `SharedPreferences`. If an OTA
 *    bundle ever fails to initialize twice in a row, `resolveStartupBundlePath()` automatically
 *    purges the OTA bundle and falls back to the built-in APK asset bundle.
 * 3. **Full APK Self-Updater:** Can also download a full `.apk` from GitHub Releases and launch
 *    Android's native package installer via `FileProvider`.
 */
class GitUpdaterModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "GitUpdaterModule"
        private const val PREFS_NAME = "nativecamera_git_ota_prefs"
        private const val KEY_BOOT_ATTEMPTS = "ota_boot_attempts"
        private const val OTA_DIR_NAME = "git_ota"
        private const val OTA_BUNDLE_FILENAME = "index.android.bundle"
        private const val OTA_INSTALLED_JSON = "installed.json"

        const val REPO_OWNER = "vesant"
        const val REPO_NAME = "NativeCamera"
        const val BRANCH = "main"

        const val RAW_MANIFEST_URL =
            "https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$BRANCH/ota/manifest.json"
        const val RAW_BUNDLE_URL =
            "https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$BRANCH/ota/index.android.bundle"
        const val GITHUB_COMMITS_API =
            "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/commits?sha=$BRANCH&per_page=6"
        const val GITHUB_LATEST_RELEASE_API =
            "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest"

        /**
         * Called by `MainApplication.kt` when constructing `ExpoReactHostFactory.getDefaultReactHost`.
         * Returns the absolute path to a verified downloaded Git OTA bundle if one is installed,
         * or `null` to use the APK's built-in `assets://index.android.bundle`.
         */
        fun resolveStartupBundlePath(context: Context): String? {
            return try {
                val otaDir = File(context.filesDir, OTA_DIR_NAME)
                val bundleFile = File(otaDir, OTA_BUNDLE_FILENAME)
                val metaFile = File(otaDir, OTA_INSTALLED_JSON)

                if (!bundleFile.exists() || !metaFile.exists() || bundleFile.length() < 4096L) {
                    return null
                }

                val metaJson = JSONObject(metaFile.readText())
                val baseApkSha = metaJson.optString("baseApkCommitSha", "")

                // If the user installed a newer base APK since this OTA bundle was downloaded,
                // clear the older OTA bundle so the newer APK's native + JS code takes precedence.
                if (baseApkSha.isNotEmpty() && baseApkSha != BuildConfig.GIT_COMMIT_SHA) {
                    Log.i(
                        TAG,
                        "Base APK changed ($baseApkSha -> ${BuildConfig.GIT_COMMIT_SHA}); clearing older OTA bundle."
                    )
                    bundleFile.delete()
                    metaFile.delete()
                    return null
                }

                // Crash-safe boot guard: if an OTA bundle failed to reach JS readiness twice in a row,
                // automatically roll back to the built-in APK bundle.
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val attempts = prefs.getInt(KEY_BOOT_ATTEMPTS, 0)
                if (attempts >= 2) {
                    Log.w(TAG, "OTA bundle failed $attempts consecutive boots; rolling back to built-in APK bundle.")
                    bundleFile.delete()
                    metaFile.delete()
                    prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).apply()
                    return null
                }

                prefs.edit().putInt(KEY_BOOT_ATTEMPTS, attempts + 1).apply()
                Log.i(TAG, "Booting NativeCamera from Git OTA bundle: ${bundleFile.absolutePath}")
                bundleFile.absolutePath
            } catch (e: Throwable) {
                Log.e(TAG, "Failed resolving startup OTA bundle, falling back to APK asset", e)
                null
            }
        }
    }

    private val ioExecutor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "GitUpdaterModule"

    private fun markBundleHealthy() {
        try {
            val prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (prefs.getInt(KEY_BOOT_ATTEMPTS, 0) != 0) {
                prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).apply()
            }
        } catch (_: Throwable) {
        }
    }

    @ReactMethod
    fun getCurrentBuildInfo(promise: Promise) {
        markBundleHealthy()
        try {
            val otaDir = File(reactContext.filesDir, OTA_DIR_NAME)
            val bundleFile = File(otaDir, OTA_BUNDLE_FILENAME)
            val metaFile = File(otaDir, OTA_INSTALLED_JSON)

            var isUsingOta = false
            var activeSha = BuildConfig.GIT_COMMIT_SHA
            var activeMsg = "Built-in APK Bundle (${BuildConfig.BUILD_TIMESTAMP})"
            var installedAt = BuildConfig.BUILD_TIMESTAMP
            var bundleSizeKb = 0

            if (bundleFile.exists() && metaFile.exists() && bundleFile.length() > 4096L) {
                try {
                    val obj = JSONObject(metaFile.readText())
                    isUsingOta = true
                    activeSha = obj.optString("commitSha", BuildConfig.GIT_COMMIT_SHA)
                    activeMsg = obj.optString("commitMessage", "Git OTA Update")
                    installedAt = obj.optString("installedAt", "")
                    bundleSizeKb = (bundleFile.length() / 1024L).toInt()
                } catch (_: Throwable) {
                }
            }

            val map = Arguments.createMap().apply {
                putString("repoUrl", "https://github.com/$REPO_OWNER/$REPO_NAME")
                putString("branch", BRANCH)
                putString("versionName", BuildConfig.VERSION_NAME)
                putString("apkCommitSha", BuildConfig.GIT_COMMIT_SHA)
                putString("apkBuildTime", BuildConfig.BUILD_TIMESTAMP)
                putString("activeCommitSha", activeSha)
                putString("activeCommitMessage", activeMsg)
                putBoolean("isUsingOtaBundle", isUsingOta)
                putString("installedAt", installedAt)
                putInt("bundleSizeKb", bundleSizeKb)
            }
            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("BUILD_INFO_ERROR", "Could not read build info: ${e.message}", e)
        }
    }

    @ReactMethod
    fun checkForGitUpdates(promise: Promise) {
        markBundleHealthy()
        ioExecutor.execute {
            try {
                val otaDir = File(reactContext.filesDir, OTA_DIR_NAME)
                val bundleFile = File(otaDir, OTA_BUNDLE_FILENAME)
                val metaFile = File(otaDir, OTA_INSTALLED_JSON)

                var activeSha = BuildConfig.GIT_COMMIT_SHA
                if (bundleFile.exists() && metaFile.exists()) {
                    try {
                        val obj = JSONObject(metaFile.readText())
                        activeSha = obj.optString("commitSha", BuildConfig.GIT_COMMIT_SHA)
                    } catch (_: Throwable) {
                    }
                }

                // 1. Fetch ota/manifest.json from GitHub raw
                var manifestJson: JSONObject? = null
                try {
                    val text = fetchUrlText("$RAW_MANIFEST_URL?cb=${System.currentTimeMillis()}")
                    if (text.isNotBlank()) {
                        manifestJson = JSONObject(text)
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "OTA manifest fetch notice: ${e.message}")
                }

                // 2. Fetch recent commits from GitHub API
                val recentCommitsArray = Arguments.createArray()
                var latestGitShortSha = ""
                var latestGitFullSha = ""
                var latestGitMessage = ""
                var latestGitAuthor = ""
                var latestGitDate = ""

                try {
                    val commitsText = fetchUrlText(GITHUB_COMMITS_API)
                    if (commitsText.isNotBlank()) {
                        val arr = JSONArray(commitsText)
                        for (i in 0 until arr.length()) {
                            val item = arr.getJSONObject(i)
                            val fullSha = item.optString("sha", "")
                            val shortSha = if (fullSha.length >= 7) fullSha.substring(0, 7) else fullSha
                            val commitObj = item.optJSONObject("commit")
                            val rawMsg = commitObj?.optString("message", "") ?: ""
                            val firstLineMsg = rawMsg.lineSequence().firstOrNull()?.trim() ?: rawMsg
                            val authorObj = commitObj?.optJSONObject("author")
                            val authorName = authorObj?.optString("name", REPO_OWNER) ?: REPO_OWNER
                            val dateStr = authorObj?.optString("date", "") ?: ""

                            if (i == 0) {
                                latestGitShortSha = shortSha
                                latestGitFullSha = fullSha
                                latestGitMessage = firstLineMsg
                                latestGitAuthor = authorName
                                latestGitDate = dateStr
                            }

                            val cMap = Arguments.createMap().apply {
                                putString("sha", shortSha)
                                putString("fullSha", fullSha)
                                putString("message", firstLineMsg)
                                putString("author", authorName)
                                putString("date", dateStr)
                            }
                            recentCommitsArray.pushMap(cMap)
                        }
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "GitHub commits API notice: ${e.message}")
                }

                // 3. Check if a GitHub Release APK asset exists
                var releaseApkUrl = manifestJson?.optString("apkUrl", "") ?: ""
                if (releaseApkUrl.isBlank()) {
                    try {
                        val relText = fetchUrlText(GITHUB_LATEST_RELEASE_API)
                        if (relText.isNotBlank()) {
                            val relObj = JSONObject(relText)
                            val assets = relObj.optJSONArray("assets")
                            if (assets != null) {
                                for (i in 0 until assets.length()) {
                                    val asset = assets.getJSONObject(i)
                                    val name = asset.optString("name", "")
                                    if (name.endsWith(".apk", ignoreCase = true)) {
                                        releaseApkUrl = asset.optString("browser_download_url", "")
                                        break
                                    }
                                }
                            }
                        }
                    } catch (_: Throwable) {
                    }
                }

                val otaSha = manifestJson?.optString("commitSha", "") ?: ""
                val otaMsg = manifestJson?.optString("commitMessage", "") ?: latestGitMessage
                val otaAuthor = manifestJson?.optString("author", REPO_OWNER) ?: latestGitAuthor
                val otaPublishedAt = manifestJson?.optString("publishedAt", "") ?: latestGitDate
                val otaBundleUrl = manifestJson?.optString("bundleUrl", RAW_BUNDLE_URL) ?: RAW_BUNDLE_URL
                val otaBundleSha256 = manifestJson?.optString("bundleSha256", "") ?: ""
                val otaBundleSizeBytes = manifestJson?.optInt("bundleSizeBytes", 0) ?: 0

                val effectiveRemoteSha = otaSha.ifBlank { latestGitShortSha }
                val isOtaAvailable = otaSha.isNotBlank() && !shasMatch(otaSha, activeSha)
                val isGitAhead = latestGitShortSha.isNotBlank() && !shasMatch(latestGitShortSha, activeSha)

                val result = Arguments.createMap().apply {
                    putBoolean("otaManifestFound", manifestJson != null)
                    putBoolean("updateAvailable", isOtaAvailable)
                    putBoolean("gitRepoAhead", isGitAhead)
                    putString("activeCommitSha", activeSha)
                    putString("apkCommitSha", BuildConfig.GIT_COMMIT_SHA)
                    putString("remoteOtaCommitSha", otaSha)
                    putString("latestGitCommitSha", latestGitShortSha)
                    putString("remoteCommitSha", effectiveRemoteSha)
                    putString("remoteCommitFullSha", latestGitFullSha)
                    putString("remoteCommitMessage", otaMsg.ifBlank { latestGitMessage })
                    putString("remoteCommitAuthor", otaAuthor)
                    putString("remoteCommitDate", otaPublishedAt)
                    putString("bundleUrl", otaBundleUrl)
                    putString("bundleSha256", otaBundleSha256)
                    putInt("bundleSizeBytes", otaBundleSizeBytes)
                    putString("apkDownloadUrl", releaseApkUrl)
                    putArray("recentCommits", recentCommitsArray)
                }
                promise.resolve(result)
            } catch (e: Throwable) {
                promise.reject(
                    "GIT_CHECK_FAILED",
                    "Failed checking GitHub repository for updates: ${e.message}",
                    e
                )
            }
        }
    }

    @ReactMethod
    fun downloadAndApplyOtaUpdate(
        bundleUrl: String,
        expectedSha256: String,
        commitSha: String,
        commitMessage: String,
        promise: Promise
    ) {
        ioExecutor.execute {
            val otaDir = File(reactContext.filesDir, OTA_DIR_NAME).apply { mkdirs() }
            val tempFile = File(otaDir, "$OTA_BUNDLE_FILENAME.tmp")
            val finalFile = File(otaDir, OTA_BUNDLE_FILENAME)
            val metaFile = File(otaDir, OTA_INSTALLED_JSON)

            try {
                emitProgress("CONNECTING", 0, 0, "Connecting to GitHub raw bundle stream...")
                val targetUrl = if (bundleUrl.contains("?")) {
                    "$bundleUrl&cb=${System.currentTimeMillis()}"
                } else {
                    "$bundleUrl?cb=${System.currentTimeMillis()}"
                }

                val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    requestMethod = "GET"
                    setRequestProperty("Accept", "application/octet-stream")
                    setRequestProperty("Cache-Control", "no-cache")
                    instanceFollowRedirects = true
                }
                conn.connect()

                if (conn.responseCode !in 200..299) {
                    throw IllegalStateException("GitHub returned HTTP ${conn.responseCode}")
                }

                val totalBytes = conn.contentLength.coerceAtLeast(0)
                val digest = MessageDigest.getInstance("SHA-256")
                var bytesReadTotal = 0
                var lastEmitMs = 0L

                BufferedInputStream(conn.inputStream).use { input ->
                    FileOutputStream(tempFile).use { output ->
                        val buffer = ByteArray(32 * 1024)
                        var count: Int
                        while (input.read(buffer).also { count = it } != -1) {
                            output.write(buffer, 0, count)
                            digest.update(buffer, 0, count)
                            bytesReadTotal += count

                            val now = System.currentTimeMillis()
                            if (now - lastEmitMs >= 80L) {
                                lastEmitMs = now
                                val pct = if (totalBytes > 0) {
                                    ((bytesReadTotal.toDouble() / totalBytes.toDouble()) * 100.0).roundToInt()
                                        .coerceIn(1, 99)
                                } else {
                                    50
                                }
                                emitProgress(
                                    "DOWNLOADING",
                                    bytesReadTotal,
                                    totalBytes,
                                    "Downloading Hermes OTA Bundle (${bytesReadTotal / 1024} KB)...",
                                    pct
                                )
                            }
                        }
                        output.flush()
                    }
                }

                if (tempFile.length() < 4096L) {
                    tempFile.delete()
                    throw IllegalStateException("Downloaded bundle is too small (${tempFile.length()} bytes).")
                }

                val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                if (expectedSha256.isNotBlank() && !expectedSha256.equals(actualSha256, ignoreCase = true)) {
                    tempFile.delete()
                    throw IllegalStateException(
                        "SHA-256 mismatch (expected ${expectedSha256.take(12)}..., got ${actualSha256.take(12)}...)."
                    )
                }

                emitProgress("VERIFYING", bytesReadTotal, bytesReadTotal, "SHA-256 verified! Installing OTA bundle...", 100)

                if (finalFile.exists()) finalFile.delete()
                if (!tempFile.renameTo(finalFile)) {
                    tempFile.copyTo(finalFile, overwrite = true)
                    tempFile.delete()
                }

                val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                val installedJson = JSONObject().apply {
                    put("commitSha", commitSha.ifBlank { "latest" })
                    put("commitMessage", commitMessage.ifBlank { "Git OTA Update" })
                    put("baseApkCommitSha", BuildConfig.GIT_COMMIT_SHA)
                    put("sha256", actualSha256)
                    put("sizeBytes", finalFile.length())
                    put("installedAt", timestamp)
                }
                metaFile.writeText(installedJson.toString())

                val prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).apply()

                val res = Arguments.createMap().apply {
                    putBoolean("installed", true)
                    putString("commitSha", commitSha)
                    putString("sha256", actualSha256)
                    putInt("sizeKb", (finalFile.length() / 1024L).toInt())
                    putString("installedAt", timestamp)
                }
                promise.resolve(res)
            } catch (e: Throwable) {
                tempFile.delete()
                promise.reject("OTA_INSTALL_ERROR", "Failed installing Git OTA update: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun downloadAndInstallApk(apkUrl: String, promise: Promise) {
        if (apkUrl.isBlank()) {
            promise.reject("NO_APK_URL", "No APK release URL is configured in the GitHub repository.")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!reactContext.packageManager.canRequestPackageInstalls()) {
                try {
                    val settingsIntent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${reactContext.packageName}")
                    ).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    reactContext.startActivity(settingsIntent)
                } catch (_: Throwable) {
                }
                promise.reject(
                    "INSTALL_PERMISSION_REQUIRED",
                    "Please enable 'Allow from this source' in the Android settings screen that just opened, then tap Install APK again."
                )
                return
            }
        }

        ioExecutor.execute {
            val apkDir = File(reactContext.externalCacheDir ?: reactContext.cacheDir, "git_apk").apply { mkdirs() }
            val apkFile = File(apkDir, "NativeCamera-update.apk")

            try {
                emitProgress("DOWNLOADING_APK", 0, 0, "Connecting to GitHub APK release...", 1)
                val conn = (URL(apkUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 60_000
                    instanceFollowRedirects = true
                }
                conn.connect()

                if (conn.responseCode !in 200..299) {
                    throw IllegalStateException("GitHub APK download returned HTTP ${conn.responseCode}")
                }

                val totalBytes = conn.contentLength.coerceAtLeast(0)
                var bytesReadTotal = 0
                var lastEmitMs = 0L

                BufferedInputStream(conn.inputStream).use { input ->
                    FileOutputStream(apkFile).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var count: Int
                        while (input.read(buffer).also { count = it } != -1) {
                            output.write(buffer, 0, count)
                            bytesReadTotal += count
                            val now = System.currentTimeMillis()
                            if (now - lastEmitMs >= 100L) {
                                lastEmitMs = now
                                val pct = if (totalBytes > 0) {
                                    ((bytesReadTotal.toDouble() / totalBytes.toDouble()) * 100.0).roundToInt()
                                        .coerceIn(1, 99)
                                } else {
                                    50
                                }
                                val mb = ((bytesReadTotal.toDouble() / (1024.0 * 1024.0)) * 10.0).roundToInt() / 10.0
                                emitProgress(
                                    "DOWNLOADING_APK",
                                    bytesReadTotal,
                                    totalBytes,
                                    "Downloading APK ($mb MB)...",
                                    pct
                                )
                            }
                        }
                        output.flush()
                    }
                }

                val contentUri = FileProvider.getUriForFile(
                    reactContext,
                    "${reactContext.packageName}.fileprovider",
                    apkFile
                )
                val installIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(contentUri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                reactContext.startActivity(installIntent)
                promise.resolve(true)
            } catch (e: Throwable) {
                promise.reject("APK_UPDATE_ERROR", "Failed downloading/launching APK update: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun rollbackToBuiltInBundle(promise: Promise) {
        try {
            val otaDir = File(reactContext.filesDir, OTA_DIR_NAME)
            File(otaDir, OTA_BUNDLE_FILENAME).delete()
            File(otaDir, OTA_INSTALLED_JSON).delete()
            val prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit().putInt(KEY_BOOT_ATTEMPTS, 0).apply()
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("ROLLBACK_ERROR", "Failed rolling back OTA bundle: ${e.message}", e)
        }
    }

    @ReactMethod
    fun restartApp(promise: Promise) {
        try {
            promise.resolve(true)
            Handler(Looper.getMainLooper()).postDelayed({
                val pm = reactContext.packageManager
                val launchIntent = pm.getLaunchIntentForPackage(reactContext.packageName)
                val component = launchIntent?.component
                if (component != null) {
                    val restartIntent = Intent.makeRestartActivityTask(component)
                    reactContext.startActivity(restartIntent)
                }
                Runtime.getRuntime().exit(0)
            }, 250L)
        } catch (e: Throwable) {
            promise.reject("RESTART_ERROR", "Could not restart app: ${e.message}", e)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    private fun shasMatch(shaA: String, shaB: String): Boolean {
        val a = shaA.trim().lowercase(Locale.US)
        val b = shaB.trim().lowercase(Locale.US)
        if (a.isEmpty() || b.isEmpty() || a == "unknown" || b == "unknown") return false
        return a.startsWith(b) || b.startsWith(a)
    }

    private fun fetchUrlText(urlString: String): String {
        val conn = (URL(urlString).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 12_000
            requestMethod = "GET"
            setRequestProperty("User-Agent", "NativeCamera-Android-Updater/1.2")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-cache")
            instanceFollowRedirects = true
        }
        conn.connect()
        if (conn.responseCode !in 200..299) {
            throw IllegalStateException("HTTP ${conn.responseCode} from $urlString")
        }
        return conn.inputStream.bufferedReader().use { it.readText() }
    }

    private fun emitProgress(
        stage: String,
        bytesRead: Int,
        totalBytes: Int,
        message: String,
        percent: Int = 0
    ) {
        try {
            val payload = Arguments.createMap().apply {
                putString("stage", stage)
                putInt("bytesRead", bytesRead)
                putInt("totalBytes", totalBytes)
                putInt("percent", percent)
                putString("message", message)
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onGitUpdateProgress", payload)
        } catch (_: Throwable) {
        }
    }
}
