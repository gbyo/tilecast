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

    suspend fun capture(maxWidth: Int, maxHeight: Int): WindowCapture = mutex.withLock {
        withContext(Dispatchers.Main.immediate) {
            val view = activity.window.decorView
            if (!view.isAttachedToWindow || view.width < 1 || view.height < 1) {
                return@withContext WindowCapture.Failure("window_unavailable")
            }
            val dimensions = scaledDimensions(view.width, view.height, maxWidth, maxHeight)
            val bitmap = runCatching {
                Bitmap.createBitmap(dimensions.width, dimensions.height, Bitmap.Config.ARGB_8888)
            }.getOrElse { return@withContext WindowCapture.Failure("bitmap_allocation_failed") }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                captureWithPixelCopy(view, bitmap)
            } else {
                captureWithCanvas(view, bitmap)
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private suspend fun captureWithPixelCopy(root: View, bitmap: Bitmap): WindowCapture {
        val windowResult = copyWindow(bitmap)
        if (windowResult != PixelCopy.SUCCESS) {
            bitmap.recycle()
            return WindowCapture.Failure("pixel_copy_$windowResult")
        }

        val surfaces = visibleSurfaceViews(root)
        overlaySurfaceViews(root, surfaces, bitmap)
        if (surfaces.isNotEmpty() && isNearlyBlack(bitmap)) {
            delay(250)
            if (copyWindow(bitmap) == PixelCopy.SUCCESS) {
                overlaySurfaceViews(root, surfaces, bitmap)
            }
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
    private suspend fun overlaySurfaceViews(root: View, surfaces: List<SurfaceView>, destination: Bitmap) {
        if (surfaces.isEmpty()) return
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
            }.getOrNull() ?: continue
            try {
                if (copySurface(surface, layer) != PixelCopy.SUCCESS) continue
                val left = (location[0] - rootLocation[0]) * scaleX
                val top = (location[1] - rootLocation[1]) * scaleY
                canvas.drawBitmap(layer, left, top, null)
            } finally {
                layer.recycle()
            }
        }
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
