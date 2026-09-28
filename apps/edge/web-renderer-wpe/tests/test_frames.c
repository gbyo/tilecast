/*
 * The GPU copy of the DMA-BUF path (frames.c), run on Mesa llvmpipe with a
 * udmabuf-backed source buffer. It proves that the copy lands in a buffer the
 * helper owns (a different DMA-BUF) with the same pixels. Exit 77 (skip)
 * where /dev/udmabuf is not available.
 */
#define _GNU_SOURCE
#include "frames.h"

#include <fcntl.h>
#include <linux/udmabuf.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wpe/headless/wpe-headless.h>

#define WIDTH 64
#define HEIGHT 48
#define FOURCC(a, b, c, d) ((guint32) (a) | ((guint32) (b) << 8) | ((guint32) (c) << 16) | ((guint32) (d) << 24))

static int
udmabuf_from_memfd (int memfd, gsize size)
{
  int device = open ("/dev/udmabuf", O_RDWR | O_CLOEXEC);
  if (device < 0)
    return -1;
  struct udmabuf_create create = { .memfd = (guint32) memfd, .flags = UDMABUF_FLAGS_CLOEXEC, .offset = 0, .size = size };
  int fd = ioctl (device, UDMABUF_CREATE, &create);
  close (device);
  return fd;
}

int
main (void)
{
  gsize stride = WIDTH * 4;
  gsize size = (stride * HEIGHT + 4095) & ~(gsize) 4095;
  int memfd = memfd_create ("tc-frames-test", MFD_ALLOW_SEALING | MFD_CLOEXEC);
  g_assert_cmpint (memfd, >=, 0);
  g_assert_cmpint (ftruncate (memfd, (off_t) size), ==, 0);
  g_assert_cmpint (fcntl (memfd, F_ADD_SEALS, F_SEAL_SHRINK), ==, 0);
  guint8 *pixels = mmap (NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, memfd, 0);
  g_assert_true (pixels != MAP_FAILED);
  /* XRGB8888 little-endian: bytes B, G, R, X. */
  for (int y = 0; y < HEIGHT; y++) {
    for (int x = 0; x < WIDTH; x++) {
      guint8 *p = pixels + y * stride + x * 4;
      p[0] = 0x80;
      p[1] = (guint8) (y * 5);
      p[2] = (guint8) (x * 3);
      p[3] = 0xff;
    }
  }
  int source = udmabuf_from_memfd (memfd, size);
  if (source < 0) {
    g_print ("rw-frames: /dev/udmabuf is not available; skipped\n");
    return 77;
  }

  WPEDisplay *display = wpe_display_headless_new ();
  g_assert_true (wpe_display_connect (display, NULL));
  g_autoptr (GError) error = NULL;
  gpointer egl = wpe_display_get_egl_display (display, &error);
  g_assert_nonnull (egl);
  int fds[1] = { source };
  guint32 offsets[1] = { 0 };
  guint32 strides[1] = { (guint32) stride };
  WPEBufferDMABuf *buffer = wpe_buffer_dma_buf_new (display, WIDTH, HEIGHT, FOURCC ('X', 'R', '2', '4'), 1, fds,
                                                    offsets, strides, 0 /* DRM_FORMAT_MOD_LINEAR */);
  guint32 fourcc = 0, out_stride = 0;
  guint64 modifier = 0;
  int copy = tc_frames_test_gpu_copy (egl, WPE_BUFFER (buffer), &fourcc, &modifier, &out_stride);
  if (copy < 0)
    g_error ("rw-frames: the GPU copy failed on this EGL implementation");
  g_assert_cmpint (copy, !=, source);
  g_assert_cmpuint (modifier, ==, 0); /* llvmpipe exports linear buffers */
  guint8 *out = mmap (NULL, (gsize) out_stride * HEIGHT, PROT_READ, MAP_SHARED, copy, 0);
  g_assert_true (out != MAP_FAILED);
  gboolean rgba_order = fourcc == FOURCC ('A', 'B', '2', '4') || fourcc == FOURCC ('X', 'B', '2', '4');
  gboolean bgra_order = fourcc == FOURCC ('A', 'R', '2', '4') || fourcc == FOURCC ('X', 'R', '2', '4');
  g_assert_true (rgba_order || bgra_order);
  for (int y = 0; y < HEIGHT; y++) {
    for (int x = 0; x < WIDTH; x++) {
      const guint8 *p = out + y * out_stride + x * 4;
      guint8 r = rgba_order ? p[0] : p[2], g = p[1], b = rgba_order ? p[2] : p[0];
      if (r != (guint8) (x * 3) || g != (guint8) (y * 5) || b != 0x80)
        g_error ("rw-frames: pixel %d,%d is %02x%02x%02x", x, y, r, g, b);
    }
  }
  /* Changing the source after the copy does not change the copy: the helper
   * owns the exported buffer. */
  memset (pixels, 0, size);
  const guint8 *p = out + 5 * out_stride + 7 * 4;
  g_assert_cmpuint (rgba_order ? p[0] : p[2], ==, 21);
  munmap (out, (gsize) out_stride * HEIGHT);
  close (copy);
  g_object_unref (buffer);
  g_print ("rw-frames: GPU copy ok (fourcc %08x, stride %u)\n", fourcc, out_stride);
  return 0;
}
