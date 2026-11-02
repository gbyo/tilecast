/*
 * Pure pixel-buffer helpers for the preview capture (preview.c).
 *
 * A WPE buffer's pixels are memory the buffer owns, described by a width, a
 * height, a format and a size. These functions decide whether such a
 * description is safe to read and make the one deep copy the encoder
 * works from. They use GLib only, so tests/test_preview_pixels.c checks them
 * without a WPE graphics stack.
 */
#pragma once

#include <glib.h>

G_BEGIN_DECLS

/* Longest edge and largest copy the capture accepts. A presented buffer is
 * the display size (4K at most today); anything beyond these is malformed. */
#define TC_PIXELS_MAX_DIMENSION 8192
#define TC_PIXELS_MAX_BYTES (256u * 1024u * 1024u)

/* The two 32-bit layouts a presented WPE buffer can be read as. Both are
 * little-endian words on every release architecture (x86_64, aarch64), so
 * the bytes in memory are B, G, R, then X or A. */
typedef enum {
  TC_PIXEL_FORMAT_BGRX, /* DRM_FORMAT_XRGB8888 */
  TC_PIXEL_FORMAT_BGRA, /* DRM_FORMAT_ARGB8888, WPE_PIXEL_FORMAT_ARGB8888 */
} TcPixelFormat;

/* GStreamer raw-video format name of `format`. */
const char *tc_pixel_format_gst_name (TcPixelFormat format);

/* Selects the layout of a DMA-BUF buffer from its DRM fourcc. Only the two
 * 32-bit formats the WPE pixel import supports are accepted. */
gboolean tc_pixel_format_from_drm_fourcc (guint32 fourcc, TcPixelFormat *format);

typedef enum {
  TC_PIXELS_OK,
  TC_PIXELS_BAD_DIMENSIONS, /* zero, negative or over TC_PIXELS_MAX_DIMENSION */
  TC_PIXELS_BAD_SIZE,       /* no bytes, truncated, or not a whole number of rows */
  TC_PIXELS_BAD_STRIDE,     /* shorter than one row of pixels */
  TC_PIXELS_TOO_LARGE,      /* over TC_PIXELS_MAX_BYTES */
} TcPixelsStatus;

/* A short lowercase token for logs. */
const char *tc_pixels_status_name (TcPixelsStatus status);

/*
 * Decides the row stride of `size` bytes holding `height` rows of `width`
 * 32-bit pixels.
 *
 * `declared_stride` is the stride the buffer reports, or 0 when it reports
 * none. The DMA-BUF pixel import reports none: it returns height * the
 * stride the GBM mapping chose, so the stride is size / height, and the size
 * must divide evenly. A declared stride (shared-memory buffers) must hold a
 * row and the rows it implies must fit in `size`.
 *
 * Uses 64-bit arithmetic throughout; no input can overflow it.
 */
TcPixelsStatus tc_pixels_layout (int width, int height, gsize size, guint declared_stride, guint *stride);

/*
 * Copies the pixels of a validated layout into new, tightly packed memory
 * (stride width * 4) that does not refer to `data`. Returns NULL, and sets
 * `status` when it is not NULL, if the layout is not valid for `size`.
 */
GBytes *tc_pixels_copy (const guint8 *data, gsize size, int width, int height, guint declared_stride,
                        TcPixelsStatus *status);

G_END_DECLS
