package com.vesant.nativecamera

import android.content.Context
import android.media.MediaPlayer
import android.net.Uri
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.VideoView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * Lightweight native Android VideoView wrapper so recorded `.mp4` clips can be played back
 * with audio directly inside NativeCamera's in-app Media Preview modal.
 */
class VideoPlayerContainerView(context: Context) : FrameLayout(context) {
    private val videoView: VideoView = VideoView(context)
    private var currentUriString: String = ""
    private var isPausedProp: Boolean = false
    private var isPrepared: Boolean = false

    init {
        setBackgroundColor(0xFF000000.toInt())
        val params = LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
            Gravity.CENTER
        )
        videoView.layoutParams = params
        addView(videoView)

        videoView.setOnPreparedListener { mp: MediaPlayer ->
            isPrepared = true
            mp.isLooping = true
            try {
                mp.setVideoScalingMode(MediaPlayer.VIDEO_SCALING_MODE_SCALE_TO_FIT)
            } catch (_: Throwable) {
            }
            if (!isPausedProp) {
                videoView.start()
            }
        }

        videoView.setOnErrorListener { _, what, extra ->
            Log.w("VideoPlayerView", "VideoView playback error (what=$what, extra=$extra)")
            true
        }
    }

    override fun requestLayout() {
        super.requestLayout()
        post {
            measure(
                MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
            )
            layout(left, top, right, bottom)
        }
    }

    fun setSourceUri(uriStr: String?) {
        val clean = uriStr?.trim() ?: ""
        if (clean.isEmpty() || clean == currentUriString) return
        currentUriString = clean
        isPrepared = false
        try {
            val uri = if (clean.startsWith("/")) {
                Uri.parse("file://$clean")
            } else {
                Uri.parse(clean)
            }
            videoView.setVideoURI(uri)
            videoView.requestFocus()
        } catch (e: Throwable) {
            Log.e("VideoPlayerView", "Failed setting video URI: $clean", e)
        }
    }

    fun setPaused(paused: Boolean) {
        isPausedProp = paused
        if (!isPrepared) return
        try {
            if (paused && videoView.isPlaying) {
                videoView.pause()
            } else if (!paused && !videoView.isPlaying) {
                videoView.start()
            }
        } catch (_: Throwable) {
        }
    }

    override fun onDetachedFromWindow() {
        try {
            videoView.stopPlayback()
        } catch (_: Throwable) {
        }
        super.onDetachedFromWindow()
    }
}

class VideoPlayerViewManager : SimpleViewManager<VideoPlayerContainerView>() {
    override fun getName(): String = "NativeVideoPlayerView"

    override fun createViewInstance(reactContext: ThemedReactContext): VideoPlayerContainerView {
        return VideoPlayerContainerView(reactContext)
    }

    @ReactProp(name = "sourceUri")
    fun setSourceUri(view: VideoPlayerContainerView, sourceUri: String?) {
        view.setSourceUri(sourceUri)
    }

    @ReactProp(name = "paused", defaultBoolean = false)
    fun setPaused(view: VideoPlayerContainerView, paused: Boolean) {
        view.setPaused(paused)
    }
}
