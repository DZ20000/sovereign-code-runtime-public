package com.sovereign.runtime.android.screen

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.graphics.createBitmap
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

internal class MediaProjectionFrameProducer private constructor(
    context: Context,
    override val generation: Long,
    override val projectionSessionId: String,
    private val handlerThread: HandlerThread,
    private val handler: Handler,
    private var imageReader: ImageReader,
    private val virtualDisplay: VirtualDisplay,
    initialDimensions: ProjectionFrameDimensions,
) : ProjectionFrameSource {
    private val applicationContext = context.applicationContext
    private val closed = AtomicBoolean(false)
    private val captureMutex = Mutex()

    @Volatile
    private var contentDimensions: ProjectionFrameDimensions? = initialDimensions

    @Volatile
    private var contentVisible = true

    private var configuredDimensions = initialDimensions
    private var pendingCapture: PendingCapture? = null

    init {
        require(generation >= 1) {
            "MediaProjection frame producer generation must be positive."
        }
        require(
            runCatching { java.util.UUID.fromString(projectionSessionId) }.isSuccess,
        ) {
            "MediaProjection frame producer session ID must be a UUID."
        }
        installImageListener(imageReader)
    }

    override fun dimensions(): ProjectionFrameDimensions {
        check(!closed.get()) { "The MediaProjection frame producer is closed." }
        return checkNotNull(contentDimensions) {
            "Android reported invalid MediaProjection content dimensions."
        }
    }

    override suspend fun capture(lease: ScreenCaptureLease): ProjectionFrameResult =
        captureMutex.withLock {
            if (closed.get()) return@withLock unavailableFailure()
            if (
                lease.projectionGeneration != generation ||
                lease.projectionSessionId != projectionSessionId
            ) {
                return@withLock failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_frame_lease_mismatch",
                    "The MediaProjection frame source rejected a lease from another session.",
                )
            }
            if (!contentVisible) {
                return@withLock failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_content_not_visible",
                    "Android reported that the projected content is not visible.",
                )
            }
            val currentDimensions = runCatching(::dimensions).getOrElse {
                return@withLock failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_dimensions_invalid",
                    "The MediaProjection content dimensions are no longer valid.",
                )
            }
            if (
                currentDimensions.width != lease.width ||
                currentDimensions.height != lease.height
            ) {
                return@withLock failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_geometry_changed",
                    "The MediaProjection dimensions changed after the capture lease was issued.",
                )
            }

            val deferred = CompletableDeferred<ProjectionFrameResult>()
            val posted = handler.post {
                prepareCapture(lease, deferred)
            }
            if (!posted) return@withLock unavailableFailure()
            val result = try {
                withTimeoutOrNull(FRAME_TIMEOUT_MS) {
                    deferred.await()
                }
            } finally {
                deferred.cancel()
                handler.post {
                    val pending = pendingCapture
                    if (pending?.result === deferred) {
                        pendingCapture = null
                        runCatching { virtualDisplay.surface = null }
                    }
                    drainImages(imageReader)
                }
            }
            result ?: failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_timeout",
                "The MediaProjection frame did not arrive before the timeout.",
            )
        }

    fun updateCapturedContentSize(width: Int, height: Int) {
        contentDimensions = runCatching {
            boundProjectionFrameDimensions(width, height)
        }.getOrNull()
    }

    fun updateCapturedContentVisibility(visible: Boolean) {
        contentVisible = visible
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val closeAction = Runnable(::closeOnHandler)
        if (Looper.myLooper() === handler.looper) {
            closeAction.run()
        } else if (!handler.post(closeAction)) {
            closeAction.run()
        }
    }

    private fun prepareCapture(
        lease: ScreenCaptureLease,
        result: CompletableDeferred<ProjectionFrameResult>,
    ) {
        if (closed.get()) {
            result.complete(unavailableFailure())
            return
        }
        try {
            ensureConfigured(ProjectionFrameDimensions(lease.width, lease.height))
            drainImages(imageReader)
            check(pendingCapture == null) {
                "A MediaProjection frame request is already pending."
            }
            pendingCapture = PendingCapture(lease = lease, result = result)
            try {
                virtualDisplay.surface = imageReader.surface
            } catch (error: Throwable) {
                pendingCapture = null
                throw error
            }
        } catch (_: IllegalArgumentException) {
            result.complete(
                failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_dimensions_invalid",
                    "The MediaProjection frame dimensions failed validation.",
                ),
            )
        } catch (_: IllegalStateException) {
            result.complete(unavailableFailure())
        } catch (_: SecurityException) {
            result.complete(
                failure(
                    ScreenCaptureStatus.SECURE_WINDOW,
                    "secure_window",
                    "Android blocked the MediaProjection frame surface.",
                ),
            )
        }
    }

    private fun installImageListener(reader: ImageReader) {
        reader.setOnImageAvailableListener(
            { available -> handleImageAvailable(available) },
            handler,
        )
    }

    private fun handleImageAvailable(reader: ImageReader) {
        val image = try {
            reader.acquireLatestImage()
        } catch (_: IllegalStateException) {
            val pending = pendingCapture
            pendingCapture = null
            runCatching { virtualDisplay.surface = null }
            pending?.result?.complete(unavailableFailure())
            return
        }
        if (image == null) return
        if (reader !== imageReader) {
            image.close()
            return
        }
        val pending = pendingCapture
        if (pending == null) {
            image.close()
            return
        }
        pendingCapture = null
        runCatching { virtualDisplay.surface = null }
        val expectedDimensions = ProjectionFrameDimensions(
            width = pending.lease.width,
            height = pending.lease.height,
        )
        val result = when {
            !contentVisible -> {
                image.close()
                failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_content_not_visible",
                    "Android reported that the projected content is not visible.",
                )
            }
            contentDimensions != expectedDimensions -> {
                image.close()
                failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_geometry_changed",
                    "The MediaProjection dimensions changed after the capture lease was issued.",
                )
            }
            else -> encodeImage(image, pending.lease)
        }
        if (!pending.result.complete(result)) {
            (result as? ProjectionFrameResult.Success)?.frame?.zeroize()
        }
    }

    private fun ensureConfigured(dimensions: ProjectionFrameDimensions) {
        if (configuredDimensions == dimensions) return
        val nextReader = ImageReader.newInstance(
            dimensions.width,
            dimensions.height,
            PixelFormat.RGBA_8888,
            MAX_IMAGES,
        )
        installImageListener(nextReader)
        val previousReader = imageReader
        val previousDimensions = configuredDimensions
        try {
            virtualDisplay.resize(
                dimensions.width,
                dimensions.height,
                densityDpi(applicationContext),
            )
            imageReader = nextReader
            configuredDimensions = dimensions
            previousReader.setOnImageAvailableListener(null, null)
            previousReader.close()
        } catch (error: Throwable) {
            nextReader.setOnImageAvailableListener(null, null)
            nextReader.close()
            runCatching {
                virtualDisplay.resize(
                    previousDimensions.width,
                    previousDimensions.height,
                    densityDpi(applicationContext),
                )
            }
            throw error
        }
    }

    private fun encodeImage(
        image: Image,
        lease: ScreenCaptureLease,
    ): ProjectionFrameResult {
        var bitmap: Bitmap? = null
        var rowPixels: IntArray? = null
        try {
            if (
                image.format != PixelFormat.RGBA_8888 ||
                image.width != lease.width ||
                image.height != lease.height
            ) {
                return failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_frame_geometry_mismatch",
                    "Android returned a MediaProjection frame with unexpected geometry.",
                )
            }
            val plane = image.planes.singleOrNull() ?: return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_plane_invalid",
                "Android returned an unsupported MediaProjection pixel layout.",
            )
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            if (pixelStride < BYTES_PER_PIXEL || rowStride < image.width * pixelStride) {
                return failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_frame_stride_invalid",
                    "Android returned invalid MediaProjection row or pixel stride metadata.",
                )
            }
            val lastByte =
                (image.height - 1L) * rowStride.toLong() +
                    (image.width - 1L) * pixelStride.toLong() +
                    (BYTES_PER_PIXEL - 1L)
            val buffer = plane.buffer
            if (lastByte < 0 || lastByte >= buffer.limit().toLong()) {
                return failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_frame_buffer_truncated",
                    "Android returned a truncated MediaProjection pixel buffer.",
                )
            }

            bitmap = createBitmap(
                image.width,
                image.height,
                Bitmap.Config.ARGB_8888,
            )
            rowPixels = IntArray(image.width)
            var visibleInterior = false
            val verticalInset = image.height / 10
            val interiorTop = verticalInset.coerceAtMost(image.height - 1)
            val interiorBottom =
                (image.height - verticalInset).coerceAtLeast(interiorTop + 1)
            for (y in 0 until image.height) {
                val rowOffset = y * rowStride
                for (x in 0 until image.width) {
                    val offset = rowOffset + x * pixelStride
                    val red = buffer.get(offset).toInt() and 0xff
                    val green = buffer.get(offset + 1).toInt() and 0xff
                    val blue = buffer.get(offset + 2).toInt() and 0xff
                    val alpha = buffer.get(offset + 3).toInt() and 0xff
                    rowPixels[x] =
                        alpha shl 24 or red shl 16 or green shl 8 or blue
                }
                bitmap.setPixels(
                    rowPixels,
                    0,
                    image.width,
                    0,
                    y,
                    image.width,
                    1,
                )
                if (
                    !visibleInterior &&
                    y in interiorTop until interiorBottom &&
                    projectionFrameHasVisibleInterior(
                        rowPixels,
                        image.width,
                        1,
                    )
                ) {
                    visibleInterior = true
                }
            }
            if (!visibleInterior) {
                return failure(
                    ScreenCaptureStatus.SECURE_WINDOW,
                    "projection_frame_blank_or_protected",
                    "Android returned a blank or protected MediaProjection frame.",
                )
            }

            val output = ZeroingBoundedOutputStream(
                ScreenCaptureArtifact.MAX_ENCODED_BYTES,
            )
            return try {
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                    failure(
                        ScreenCaptureStatus.FAILED,
                        "projection_frame_encode_failed",
                        "The MediaProjection frame could not be encoded.",
                    )
                } else {
                    val bytes = output.copyBytes()
                    try {
                        ProjectionFrameResult.Success(
                            ProjectionFrame(
                                generation = generation,
                                projectionSessionId = projectionSessionId,
                                width = image.width,
                                height = image.height,
                                mimeType = "image/png",
                                bytes = bytes,
                            ),
                        )
                    } catch (error: Throwable) {
                        bytes.fill(0)
                        throw error
                    }
                }
            } catch (_: EncodedFrameTooLargeException) {
                failure(
                    ScreenCaptureStatus.FAILED,
                    "projection_frame_too_large",
                    "The encoded MediaProjection frame exceeds the in-memory safety limit.",
                )
            } finally {
                output.clear()
            }
        } catch (_: SecurityException) {
            return failure(
                ScreenCaptureStatus.SECURE_WINDOW,
                "secure_window",
                "Android blocked capture of the current projected surface.",
            )
        } catch (_: OutOfMemoryError) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_memory_limit",
                "The MediaProjection frame could not be processed within memory limits.",
            )
        } catch (_: Exception) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_processing_failed",
                "The MediaProjection frame failed during bounded in-memory processing.",
            )
        } finally {
            rowPixels?.fill(0)
            bitmap?.runCatching {
                eraseColor(Color.TRANSPARENT)
                recycle()
            }
            image.close()
        }
    }

    private fun closeOnHandler() {
        val pending = pendingCapture
        pendingCapture = null
        pending?.result?.complete(unavailableFailure())
        runCatching { virtualDisplay.surface = null }
        imageReader.setOnImageAvailableListener(null, null)
        drainImages(imageReader)
        imageReader.close()
        virtualDisplay.release()
        handlerThread.quitSafely()
    }

    private fun drainImages(reader: ImageReader) {
        while (true) {
            val image = runCatching { reader.acquireLatestImage() }.getOrNull()
                ?: return
            image.close()
        }
    }

    private fun unavailableFailure(): ProjectionFrameResult.Failure = failure(
        ScreenCaptureStatus.FAILED,
        "projection_frame_source_unavailable",
        "The MediaProjection frame source is unavailable.",
    )

    private fun failure(
        status: ScreenCaptureStatus,
        reasonCode: String,
        explanation: String,
    ): ProjectionFrameResult.Failure = ProjectionFrameResult.Failure(
        ScreenCaptureFailure(status, reasonCode, explanation),
    )

    private data class PendingCapture(
        val lease: ScreenCaptureLease,
        val result: CompletableDeferred<ProjectionFrameResult>,
    )

    private class EncodedFrameTooLargeException : IOException()

    private class ZeroingBoundedOutputStream(
        private val maximumBytes: Int,
    ) : OutputStream() {
        private var buffer = ByteArray(minOf(INITIAL_ENCODE_BUFFER_BYTES, maximumBytes))
        private var count = 0

        init {
            require(maximumBytes > 0) {
                "Encoded frame byte limit must be positive."
            }
        }

        override fun write(value: Int) {
            ensureCapacityFor(1)
            buffer[count] = value.toByte()
            count += 1
        }

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            require(
                offset >= 0 &&
                    length >= 0 &&
                    offset <= bytes.size - length
            ) {
                "Encoded frame write range is invalid."
            }
            ensureCapacityFor(length)
            bytes.copyInto(
                destination = buffer,
                destinationOffset = count,
                startIndex = offset,
                endIndex = offset + length,
            )
            count += length
        }

        fun copyBytes(): ByteArray = buffer.copyOf(count)

        fun clear() {
            buffer.fill(0)
            count = 0
        }

        private fun ensureCapacityFor(additionalBytes: Int) {
            if (additionalBytes > maximumBytes - count) {
                throw EncodedFrameTooLargeException()
            }
            val required = count + additionalBytes
            if (required <= buffer.size) return
            val nextSize = maxOf(required, buffer.size * 2).coerceAtMost(maximumBytes)
            val previous = buffer
            buffer = ByteArray(nextSize)
            previous.copyInto(buffer, endIndex = count)
            previous.fill(0)
        }
    }

    companion object {
        private const val DISPLAY_NAME = "SovereignMediaProjection"
        private const val MAX_IMAGES = 2
        private const val BYTES_PER_PIXEL = 4
        private const val INITIAL_ENCODE_BUFFER_BYTES = 64 * 1_024
        private const val FRAME_TIMEOUT_MS = 2_000L

        fun create(
            context: Context,
            projection: MediaProjection,
            generation: Long,
            projectionSessionId: String,
        ): MediaProjectionFrameProducer {
            val dimensions = currentDisplayDimensions(context)
            val thread = HandlerThread("SovereignProjectionFrames").apply { start() }
            val handler = Handler(thread.looper)
            var reader: ImageReader? = null
            var display: VirtualDisplay? = null
            return try {
                reader = ImageReader.newInstance(
                    dimensions.width,
                    dimensions.height,
                    PixelFormat.RGBA_8888,
                    MAX_IMAGES,
                )
                display = projection.createVirtualDisplay(
                    DISPLAY_NAME,
                    dimensions.width,
                    dimensions.height,
                    densityDpi(context),
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    null,
                    null,
                    handler,
                ) ?: throw IllegalStateException(
                    "Android returned no MediaProjection virtual display.",
                )
                MediaProjectionFrameProducer(
                    context = context,
                    generation = generation,
                    projectionSessionId = projectionSessionId,
                    handlerThread = thread,
                    handler = handler,
                    imageReader = reader,
                    virtualDisplay = display,
                    initialDimensions = dimensions,
                )
            } catch (error: Throwable) {
                runCatching { display?.release() }
                runCatching { reader?.close() }
                thread.quitSafely()
                throw error
            }
        }

        @Suppress("DEPRECATION")
        private fun currentDisplayDimensions(context: Context): ProjectionFrameDimensions {
            val windowManager = context.getSystemService(WindowManager::class.java)
                ?: throw IllegalStateException("WindowManager is unavailable.")
            val metrics = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bounds = windowManager.maximumWindowMetrics.bounds
                DisplayMetrics().apply {
                    widthPixels = bounds.width()
                    heightPixels = bounds.height()
                }
            } else {
                DisplayMetrics().also(windowManager.defaultDisplay::getRealMetrics)
            }
            return boundProjectionFrameDimensions(
                width = metrics.widthPixels,
                height = metrics.heightPixels,
            )
        }

        private fun densityDpi(context: Context): Int =
            context.resources.displayMetrics.densityDpi.coerceIn(1, 4_096)
    }
}
