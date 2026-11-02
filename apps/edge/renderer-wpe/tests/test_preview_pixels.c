/* Tests for the preview capture's pixel validation and deep copy.
 *
 * These cover what the renderer accepts from a presented WPE buffer before
 * it reads a byte: format selection, the stride derived from the size the
 * DMA-BUF import returns, impossible or truncated buffers, 64-bit overflow
 * and the ownership of the copy. GLib only; no WPE graphics stack.
 */
#include "preview-pixels.h"

#include <drm_fourcc.h>
#include <string.h>

static void
test_format_selection (void)
{
  TcPixelFormat format = TC_PIXEL_FORMAT_BGRA;
  g_assert_true (tc_pixel_format_from_drm_fourcc (DRM_FORMAT_XRGB8888, &format));
  g_assert_cmpint (format, ==, TC_PIXEL_FORMAT_BGRX);
  g_assert_cmpstr (tc_pixel_format_gst_name (format), ==, "BGRx");
  g_assert_true (tc_pixel_format_from_drm_fourcc (DRM_FORMAT_ARGB8888, &format));
  g_assert_cmpint (format, ==, TC_PIXEL_FORMAT_BGRA);
  g_assert_cmpstr (tc_pixel_format_gst_name (format), ==, "BGRA");

  /* Everything else is refused, including formats that are also 32-bit. */
  static const guint32 refused[] = {
    0, DRM_FORMAT_XBGR8888, DRM_FORMAT_ABGR8888, DRM_FORMAT_RGB565, DRM_FORMAT_RGB888, DRM_FORMAT_XRGB2101010,
    DRM_FORMAT_ARGB2101010, DRM_FORMAT_NV12, DRM_FORMAT_ABGR16161616F, G_MAXUINT32,
  };
  for (guint i = 0; i < G_N_ELEMENTS (refused); i++) {
    format = TC_PIXEL_FORMAT_BGRX;
    g_assert_false (tc_pixel_format_from_drm_fourcc (refused[i], &format));
    g_assert_cmpint (format, ==, TC_PIXEL_FORMAT_BGRX);
  }
}

static void
test_tight_layout (void)
{
  guint stride = 0;
  g_assert_cmpint (tc_pixels_layout (1920, 1080, 1920 * 4 * 1080, 0, &stride), ==, TC_PIXELS_OK);
  g_assert_cmpuint (stride, ==, 1920 * 4);
  /* A declared stride equal to the row is the same layout. */
  g_assert_cmpint (tc_pixels_layout (1920, 1080, 1920 * 4 * 1080, 1920 * 4, &stride), ==, TC_PIXELS_OK);
  g_assert_cmpuint (stride, ==, 1920 * 4);
}

/* The DMA-BUF import returns height * mapStride and no stride. */
static void
test_stride_derived_from_the_returned_size (void)
{
  guint stride = 0;
  /* 1366 px rows padded to 64 pixels by the driver. */
  gsize padded = 1408 * 4;
  g_assert_cmpint (tc_pixels_layout (1366, 768, padded * 768, 0, &stride), ==, TC_PIXELS_OK);
  g_assert_cmpuint (stride, ==, padded);

  /* A size that is not a whole number of rows has no stride. */
  g_assert_cmpint (tc_pixels_layout (1366, 768, padded * 768 + 1, 0, &stride), ==, TC_PIXELS_BAD_SIZE);
  g_assert_cmpint (tc_pixels_layout (1366, 768, padded * 768 - 1, 0, &stride), ==, TC_PIXELS_BAD_SIZE);
  /* A stride shorter than one row of pixels is not a picture. */
  g_assert_cmpint (tc_pixels_layout (1920, 1080, 1919 * 4 * 1080, 0, &stride), ==, TC_PIXELS_BAD_STRIDE);
  g_assert_cmpint (tc_pixels_layout (1920, 1080, 1080, 0, &stride), ==, TC_PIXELS_BAD_STRIDE);
}

static void
test_declared_stride (void)
{
  guint stride = 0;
  /* A shared-memory stride with padding is honored. */
  g_assert_cmpint (tc_pixels_layout (100, 50, 512 * 50, 512, &stride), ==, TC_PIXELS_OK);
  g_assert_cmpuint (stride, ==, 512);
  /* The last row needs no trailing padding. */
  g_assert_cmpint (tc_pixels_layout (100, 50, 512 * 49 + 400, 512, &stride), ==, TC_PIXELS_OK);
  /* One byte short of the last row is truncated. */
  g_assert_cmpint (tc_pixels_layout (100, 50, 512 * 49 + 399, 512, &stride), ==, TC_PIXELS_BAD_SIZE);
  g_assert_cmpint (tc_pixels_layout (100, 50, 0, 512, &stride), ==, TC_PIXELS_BAD_SIZE);
  /* A declared stride below the row length. */
  g_assert_cmpint (tc_pixels_layout (100, 50, 400 * 50, 399, &stride), ==, TC_PIXELS_BAD_STRIDE);
}

static void
test_bad_dimensions (void)
{
  guint stride = 0;
  g_assert_cmpint (tc_pixels_layout (0, 10, 400, 0, &stride), ==, TC_PIXELS_BAD_DIMENSIONS);
  g_assert_cmpint (tc_pixels_layout (10, 0, 400, 0, &stride), ==, TC_PIXELS_BAD_DIMENSIONS);
  g_assert_cmpint (tc_pixels_layout (-1, 10, 400, 0, &stride), ==, TC_PIXELS_BAD_DIMENSIONS);
  g_assert_cmpint (tc_pixels_layout (10, G_MININT, 400, 0, &stride), ==, TC_PIXELS_BAD_DIMENSIONS);
  g_assert_cmpint (tc_pixels_layout (TC_PIXELS_MAX_DIMENSION + 1, 10, G_MAXSIZE, 0, &stride), ==,
                   TC_PIXELS_BAD_DIMENSIONS);
  g_assert_cmpint (tc_pixels_layout (10, G_MAXINT, 400, 0, &stride), ==, TC_PIXELS_BAD_DIMENSIONS);
}

static void
test_overflow_is_refused (void)
{
  guint stride = 0;
  /* The largest picture is fine: 8192 x 8192 x 4 is exactly the bound. */
  g_assert_cmpint (
    tc_pixels_layout (TC_PIXELS_MAX_DIMENSION, TC_PIXELS_MAX_DIMENSION, TC_PIXELS_MAX_BYTES, 0, &stride), ==,
    TC_PIXELS_OK);
  /* One byte of padding per row pushes it over. */
  g_assert_cmpint (tc_pixels_layout (TC_PIXELS_MAX_DIMENSION, TC_PIXELS_MAX_DIMENSION,
                                     (gsize) TC_PIXELS_MAX_BYTES + TC_PIXELS_MAX_DIMENSION, 0, &stride),
                   ==, TC_PIXELS_TOO_LARGE);
  /* Sizes and strides near the limits of 32 and 64 bits never wrap. */
  g_assert_cmpint (tc_pixels_layout (2, 8192, G_MAXSIZE, 0, &stride), ==, TC_PIXELS_BAD_SIZE);
  g_assert_cmpint (tc_pixels_layout (2, 8192, G_MAXSIZE - (G_MAXSIZE % 8192), 0, &stride), ==, TC_PIXELS_TOO_LARGE);
  g_assert_cmpint (tc_pixels_layout (2, 8192, G_MAXSIZE, G_MAXUINT32, &stride), ==, TC_PIXELS_TOO_LARGE);
  g_assert_cmpint (tc_pixels_layout (2, 8192, 8192 * 8, G_MAXUINT32, &stride), ==, TC_PIXELS_BAD_SIZE);
  g_assert_cmpint (tc_pixels_layout (8192, 8192, 4, G_MAXUINT32, &stride), ==, TC_PIXELS_BAD_SIZE);
  g_assert_cmpint (tc_pixels_layout (1, 1, 4, G_MAXUINT32, &stride), ==, TC_PIXELS_TOO_LARGE);
}

static void
test_copy_is_tight_and_exact (void)
{
  /* 3 x 2 pixels with a 20-byte stride: 8 bytes of padding per row. */
  guint8 source[20 * 2];
  memset (source, 0xee, sizeof source);
  for (int y = 0; y < 2; y++)
    for (int x = 0; x < 12; x++)
      source[y * 20 + x] = (guint8) (y * 100 + x);
  TcPixelsStatus status = TC_PIXELS_BAD_SIZE;
  g_autoptr (GBytes) copy = tc_pixels_copy (source, sizeof source, 3, 2, 20, &status);
  g_assert_cmpint (status, ==, TC_PIXELS_OK);
  g_assert_nonnull (copy);
  gsize size = 0;
  const guint8 *data = g_bytes_get_data (copy, &size);
  g_assert_cmpuint (size, ==, 3 * 4 * 2);
  for (int y = 0; y < 2; y++)
    for (int x = 0; x < 12; x++)
      g_assert_cmpuint (data[y * 12 + x], ==, y * 100 + x);
}

/* The WPE buffer owns the memory the import returns and may reuse or unmap
 * it as soon as it is released. The copy must stand on its own. */
static void
test_copy_does_not_refer_to_the_source (void)
{
  gsize size = 64 * 64 * 4;
  guint8 *source = g_malloc (size);
  memset (source, 0x5a, size);
  g_autoptr (GBytes) copy = tc_pixels_copy (source, size, 64, 64, 0, NULL);
  g_assert_nonnull (copy);
  memset (source, 0xff, size);
  g_free (source);
  gsize copied_size = 0;
  const guint8 *data = g_bytes_get_data (copy, &copied_size);
  g_assert_cmpuint (copied_size, ==, 64 * 64 * 4);
  for (gsize i = 0; i < copied_size; i++)
    g_assert_cmpuint (data[i], ==, 0x5a);
}

static void
test_copy_refuses_impossible_buffers (void)
{
  guint8 small[16] = { 0 };
  TcPixelsStatus status = TC_PIXELS_OK;
  /* Truncated: 4 x 4 pixels need 64 bytes. */
  g_assert_null (tc_pixels_copy (small, sizeof small, 4, 4, 0, &status));
  g_assert_cmpint (status, ==, TC_PIXELS_BAD_STRIDE);
  g_assert_null (tc_pixels_copy (small, sizeof small, 2, 2, 16, &status));
  g_assert_cmpint (status, ==, TC_PIXELS_BAD_SIZE);
  g_assert_null (tc_pixels_copy (NULL, 64, 4, 4, 0, &status));
  g_assert_cmpint (status, ==, TC_PIXELS_BAD_SIZE);
  g_assert_null (tc_pixels_copy (small, sizeof small, 0, 4, 0, &status));
  g_assert_cmpint (status, ==, TC_PIXELS_BAD_DIMENSIONS);
  /* NULL status is allowed. */
  g_assert_null (tc_pixels_copy (small, sizeof small, 4, 4, 0, NULL));
}

static void
test_status_names_are_log_tokens (void)
{
  for (int status = TC_PIXELS_OK; status <= TC_PIXELS_TOO_LARGE; status++) {
    const char *name = tc_pixels_status_name ((TcPixelsStatus) status);
    g_assert_true (g_regex_match_simple ("^[a-z_]+$", name, 0, 0));
  }
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/preview-pixels/format-selection", test_format_selection);
  g_test_add_func ("/preview-pixels/tight-layout", test_tight_layout);
  g_test_add_func ("/preview-pixels/stride-from-size", test_stride_derived_from_the_returned_size);
  g_test_add_func ("/preview-pixels/declared-stride", test_declared_stride);
  g_test_add_func ("/preview-pixels/bad-dimensions", test_bad_dimensions);
  g_test_add_func ("/preview-pixels/overflow", test_overflow_is_refused);
  g_test_add_func ("/preview-pixels/copy-is-tight", test_copy_is_tight_and_exact);
  g_test_add_func ("/preview-pixels/copy-owns-its-bytes", test_copy_does_not_refer_to_the_source);
  g_test_add_func ("/preview-pixels/copy-refuses-impossible", test_copy_refuses_impossible_buffers);
  g_test_add_func ("/preview-pixels/status-names", test_status_names_are_log_tokens);
  return g_test_run ();
}
