#include "preview-pixels.h"

#include <drm_fourcc.h>
#include <string.h>

const char *
tc_pixel_format_gst_name (TcPixelFormat format)
{
  switch (format) {
  case TC_PIXEL_FORMAT_BGRX:
    return "BGRx";
  case TC_PIXEL_FORMAT_BGRA:
    return "BGRA";
  }
  return "BGRx";
}

gboolean
tc_pixel_format_from_drm_fourcc (guint32 fourcc, TcPixelFormat *format)
{
  switch (fourcc) {
  case DRM_FORMAT_XRGB8888:
    *format = TC_PIXEL_FORMAT_BGRX;
    return TRUE;
  case DRM_FORMAT_ARGB8888:
    *format = TC_PIXEL_FORMAT_BGRA;
    return TRUE;
  default:
    return FALSE;
  }
}

const char *
tc_pixels_status_name (TcPixelsStatus status)
{
  switch (status) {
  case TC_PIXELS_OK:
    return "ok";
  case TC_PIXELS_BAD_DIMENSIONS:
    return "bad_dimensions";
  case TC_PIXELS_BAD_SIZE:
    return "bad_size";
  case TC_PIXELS_BAD_STRIDE:
    return "bad_stride";
  case TC_PIXELS_TOO_LARGE:
    return "too_large";
  }
  return "invalid";
}

TcPixelsStatus
tc_pixels_layout (int width, int height, gsize size, guint declared_stride, guint *stride)
{
  if (width <= 0 || height <= 0 || width > TC_PIXELS_MAX_DIMENSION || height > TC_PIXELS_MAX_DIMENSION)
    return TC_PIXELS_BAD_DIMENSIONS;
  guint64 row_bytes = (guint64) width * 4;
  guint64 rows = (guint64) height;
  guint64 available = (guint64) size;
  guint64 row_stride;
  if (declared_stride == 0) {
    if (available == 0 || available % rows != 0)
      return TC_PIXELS_BAD_SIZE;
    row_stride = available / rows;
  } else {
    row_stride = declared_stride;
  }
  if (row_stride < row_bytes)
    return TC_PIXELS_BAD_STRIDE;
  /* The last row needs no trailing padding. */
  guint64 needed = row_stride * (rows - 1) + row_bytes;
  if (needed > available)
    return TC_PIXELS_BAD_SIZE;
  /* Both products fit 64 bits: rows <= 8192 and row_stride <= 2^64 / rows,
   * because a derived stride is size / rows and a declared one is 32 bits. */
  if (row_stride > G_MAXUINT32 || row_stride * rows > TC_PIXELS_MAX_BYTES)
    return TC_PIXELS_TOO_LARGE;
  if (stride != NULL)
    *stride = (guint) row_stride;
  return TC_PIXELS_OK;
}

GBytes *
tc_pixels_copy (const guint8 *data, gsize size, int width, int height, guint declared_stride, TcPixelsStatus *status)
{
  guint stride = 0;
  TcPixelsStatus result = data == NULL ? TC_PIXELS_BAD_SIZE : tc_pixels_layout (width, height, size, declared_stride, &stride);
  if (status != NULL)
    *status = result;
  if (result != TC_PIXELS_OK)
    return NULL;
  gsize row_bytes = (gsize) width * 4;
  gsize total = row_bytes * (gsize) height;
  /* A failed allocation degrades the preview; it must not abort the player. */
  guint8 *tight = g_try_malloc (total);
  if (tight == NULL) {
    if (status != NULL)
      *status = TC_PIXELS_TOO_LARGE;
    return NULL;
  }
  for (int y = 0; y < height; y++)
    memcpy (tight + (gsize) y * row_bytes, data + (gsize) y * stride, row_bytes);
  return g_bytes_new_take (tight, total);
}
