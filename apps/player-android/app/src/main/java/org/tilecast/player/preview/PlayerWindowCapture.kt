package org.tilecast.player.preview

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.annotation.RequiresApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlin.math.min
import kotlin.math.roundToInt

internal sealed interface WindowCapture {
    data class Success(val bitmap: Bitmap) : WindowCapture
    data class Failure(val status: String) : WindowCapture
}

/**
 * The one capture gate shared by still previews and ephemeral live streaming.
 * PixelCopy and SurfaceView composition are serialized so the two independent
 * features cannot race the activity window or double-load the video surface.
 */
internal class PlayerWindowCapture(private val activity: Activity) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mutex = Mutex()

    suspend fun capture(maxWidth: Int, maxHeight: Int, allowed: () -> Boolean): WindowCapture = mutex.withLock {
        withContext(Dispatchers.Main.immediate) {
            val view = activity.window.decorView
            if (!allowed() || !view.isAttachedToWindow || view.width < 1 || view.height < 1) {
                return@withContext WindowCapture.Failure("window_unavailable")
            }
            // PixelCopy reads the most recently queued window buffer. Wait for
            // a new eligible frame so a dismissed screen cannot still be in it.
            val useWindowBuffer = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && view.isHardwareAccelerated
            if (useWindowBuffer && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !awaitCommittedFrame(view)) {
                return@withContext WindowCapture.Failure("window_frame_unavailable")
            }
            if (!allowed()) return@withContext WindowCapture.Failure("window_unavailable")
            val dimensions = scaledDimensions(view.width, view.height, maxWidth, maxHeight)
            val bitmap = runCatching {
                Bitmap.createBitmap(dimensions.width, dimensions.height, Bitmap.Config.ARGB_8888)
            }.getOrElse { return@withContext WindowCapture.Failure("bitmap_allocation_failed") }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                captureWithPixelCopy(view, bitmap, useWindowBuffer, allowed)
            } else {
                captureWithCanvas(view, bitmap)
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private suspend fun awaitCommittedFrame(view: View): Boolean {
        val observer = view.viewTreeObserver
        if (!observer.isAlive) return false
        var callback: Runnable? = null
        return try {
            withTimeoutOrNull(1_000) {
                suspendCancellableCoroutine<Boolean> { continuation ->
                    val ready = Runnable {
                        if (continuation.isActive) continuation.resume(true)
                    }
                    callback = ready
                    observer.registerFrameCommitCallback(ready)
                    view.invalidate()
                }
            } ?: false
        } finally {
            callback?.let { if (observer.isAlive) observer.unregisterFrameCommitCallback(it) }
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun captureWithPixelCopy(
        root: View,
        bitmap: Bitmap,
        useWindowBuffer: Boolean,
        allowed: () -> Boolean,
    ): WindowCapture {
        // Older Android versions cannot confirm a new buffer was submitted.
        // Draw the current hierarchy and still copy its visible video surfaces.
        suspend fun captureBase(): WindowCapture = if (useWindowBuffer) {
            val result = copyWindow(bitmap)
            if (result == PixelCopy.SUCCESS) WindowCapture.Success(bitmap) else WindowCapture.Failure("pixel_copy_$result")
        } else {
            captureWithCanvas(root, bitmap)
        }

        val base = captureBase()
        if (base is WindowCapture.Failure) {
            if (!bitmap.isRecycled) bitmap.recycle()
            return base
        }

        val surfaces = visibleSurfaceViews(root)
        var surfaceFailure = overlaySurfaceViews(root, surfaces, bitmap)
        if (surfaces.isNotEmpty() && (surfaceFailure != null || isNearlyBlack(bitmap))) {
            delay(250)
            if (!allowed()) {
                bitmap.recycle()
                return WindowCapture.Failure("window_unavailable")
            }
            surfaceFailure = when (val retry = captureBase()) {
                is WindowCapture.Success -> overlaySurfaceViews(root, visibleSurfaceViews(root), bitmap)
                is WindowCapture.Failure -> retry.status
            }
        }
        // A frame missing a visible video surface is not a screenshot of the
        // screen, even when the rest of it has content.
        if (surfaceFailure != null) {
            if (!bitmap.isRecycled) bitmap.recycle()
            return WindowCapture.Failure(surfaceFailure)
        }
        if (surfaces.isNotEmpty() && isNearlyBlack(bitmap)) {
            bitmap.recycle()
            return WindowCapture.Failure("blank_video_frame")
        }
        return WindowCapture.Success(bitmap)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun copyWindow(bitmap: Bitmap): Int =
        suspendCancellableCoroutine { continuation ->
            PixelCopy.request(
                activity.window,
                bitmap,
                { result -> if (continuation.isActive) continuation.resume(result) },
                mainHandler,
            )
        }

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun copySurface(surface: SurfaceView, bitmap: Bitmap): Int =
        suspendCancellableCoroutine { continuation ->
            PixelCopy.request(
                surface,
                bitmap,
                { result -> if (continuation.isActive) continuation.resume(result) },
                mainHandler,
            )
        }

    @RequiresApi(Build.VERSION_CODES.O)
    /** Draws each visible surface over the window copy. Returns a failure status if any surface could not be copied. */
    private suspend fun overlaySurfaceViews(root: View, surfaces: List<SurfaceView>, destination: Bitmap): String? {
        if (surfaces.isEmpty()) return null
        val rootLocation = IntArray(2).also(root::getLocationInWindow)
        val scaleX = destination.width.toFloat() / root.width
        val scaleY = destination.height.toFloat() / root.height
        val canvas = Canvas(destination)
        for (surface in surfaces) {
            val location = IntArray(2).also(surface::getLocationInWindow)
            val width = (surface.width * scaleX).roundToInt().coerceAtLeast(1)
            val height = (surface.height * scaleY).roundToInt().coerceAtLeast(1)
            val layer = runCatching {
                Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            }.getOrNull() ?: return "surface_allocation_failed"
            try {
                val result = copySurface(surface, layer)
                if (result != PixelCopy.SUCCESS) return "surface_copy_$result"
                val left = (location[0] - rootLocation[0]) * scaleX
                val top = (location[1] - rootLocation[1]) * scaleY
                canvas.drawBitmap(layer, left, top, null)
            } finally {
                layer.recycle()
            }
        }
        return null
    }

    private fun captureWithCanvas(view: View, bitmap: Bitmap): WindowCapture = runCatching {
        val canvas = Canvas(bitmap)
        canvas.scale(bitmap.width.toFloat() / view.width, bitmap.height.toFloat() / view.height)
        view.draw(canvas)
        WindowCapture.Success(bitmap)
    }.getOrElse {
        bitmap.recycle()
        WindowCapture.Failure("view_draw_failed")
    }
}


private fun visibleSurfaceViews(root: View): List<SurfaceView> {
    val result = mutableListOf<SurfaceView>()
    fun visit(view: View) {
        if (view is SurfaceView && view.isShown && view.width > 0 && view.height > 0) result += view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) visit(view.getChildAt(index))
        }
    }
    visit(root)
    return result
}

internal fun isNearlyBlack(bitmap: Bitmap): Boolean {
    val columns = 12
    val rows = 8
    var dark = 0
    var sampled = 0
    for (column in 0 until columns) {
        val x = ((column + 0.5f) * bitmap.width / columns).toInt().coerceIn(0, bitmap.width - 1)
        for (row in 0 until rows) {
            val y = ((row + 0.5f) * bitmap.height / rows).toInt().coerceIn(0, bitmap.height - 1)
            val pixel = bitmap.getPixel(x, y)
            val brightness = (android.graphics.Color.red(pixel) + android.graphics.Color.green(pixel) + android.graphics.Color.blue(pixel)) / 3
            if (brightness <= 10) dark++
            sampled++
        }
    }
    return sampled > 0 && dark * 100 / sampled >= 98
}
