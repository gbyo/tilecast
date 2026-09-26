#include "frames.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <errno.h>
#include <gst/allocators/allocators.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SOFTWARE_MAX_FPS 30
#define IDLE_REPEAT_US G_USEC_PER_SEC
#define POOL_SLOTS 3
#define FENCE_TIMEOUT_NS (100 * 1000 * 1000)

/* ------------------------------------------------------------ minimal GL
 * The helper links EGL only and loads the few GLES 3 entry points it needs
 * with eglGetProcAddress. These are the Khronos values. */
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef unsigned int GLbitfield;
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_NEAREST 0x2600
#define GL_RGBA 0x1908
#define GL_RGBA8 0x8058
#define GL_UNSIGNED_BYTE 0x1401
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_COLOR_BUFFER_BIT 0x00004000

typedef struct {
  void (*GenTextures) (GLsizei, GLuint *);
  void (*DeleteTextures) (GLsizei, const GLuint *);
  void (*BindTexture) (GLenum, GLuint);
  void (*TexParameteri) (GLenum, GLenum, GLint);
  void (*TexStorage2D) (GLenum, GLsizei, GLenum, GLsizei, GLsizei);
  void (*EGLImageTargetTexture2DOES) (GLenum, void *);
  void (*GenFramebuffers) (GLsizei, GLuint *);
  void (*DeleteFramebuffers) (GLsizei, const GLuint *);
  void (*BindFramebuffer) (GLenum, GLuint);
  void (*FramebufferTexture2D) (GLenum, GLenum, GLenum, GLuint, GLint);
  GLenum (*CheckFramebufferStatus) (GLenum);
  void (*BlitFramebuffer) (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum);
  void (*Flush) (void);
  PFNEGLCREATEIMAGEKHRPROC CreateImage;
  PFNEGLDESTROYIMAGEKHRPROC DestroyImage;
  PFNEGLEXPORTDMABUFIMAGEQUERYMESAPROC ExportQuery;
  PFNEGLEXPORTDMABUFIMAGEMESAPROC Export;
  PFNEGLCREATESYNCKHRPROC CreateSync;
  PFNEGLWAITSYNCKHRPROC WaitSync;
  PFNEGLCLIENTWAITSYNCKHRPROC ClientWaitSync;
  PFNEGLDESTROYSYNCKHRPROC DestroySync;
} GlApi;

typedef struct {
  GLuint texture;
  EGLImageKHR image;
  int fd;
  guint32 fourcc;
  guint64 modifier;
  guint32 stride;
  guint32 offset;
  /* Atomic, refcounted (g_atomic_rc_box): how many live GstBuffers use the
   * slot (the retained last frame, a repeat, one in flight). A consumer can release a buffer after the pool is gone,
   * so the flag outlives the slot. */
  gint *busy;
} Slot;

typedef struct {
  EGLDisplay display;
  EGLContext context;
  GlApi gl;
  gboolean native_fences;
  GLuint read_fbo;
  GLuint draw_fbo;
  int width;
  int height;
  Slot slots[POOL_SLOTS];
} GpuCopier;

struct _TcFrames {
  GstElement *pipeline;
  GstElement *appsrc;
  GstAllocator *shm;
  GstAllocator *dmabuf;
  char *socket_path;
  GpuCopier *gpu;
  gpointer egl_display;
  GstBuffer *last;
  char caps_key[96];
  gint64 last_push_us;
  gint64 last_frame_us;
  WPEBuffer *pending; /* software path: the newest frame not sent yet */
  guint pending_source;
  guint idle_source;
  guint64 sent;
  gboolean failed;
  TcFramesFirstFrame first_frame;
  gpointer user_data;
};

/* ------------------------------------------------------------ GPU copier */

static gboolean
load_gl (GlApi *gl)
{
#define LOAD(field, name)                                                                                              \
  if ((*(void **) &gl->field = (void *) eglGetProcAddress (name)) == NULL)                                            \
    return FALSE;
  LOAD (GenTextures, "glGenTextures");
  LOAD (DeleteTextures, "glDeleteTextures");
  LOAD (BindTexture, "glBindTexture");
  LOAD (TexParameteri, "glTexParameteri");
  LOAD (TexStorage2D, "glTexStorage2D");
  LOAD (EGLImageTargetTexture2DOES, "glEGLImageTargetTexture2DOES");
  LOAD (GenFramebuffers, "glGenFramebuffers");
  LOAD (DeleteFramebuffers, "glDeleteFramebuffers");
  LOAD (BindFramebuffer, "glBindFramebuffer");
  LOAD (FramebufferTexture2D, "glFramebufferTexture2D");
  LOAD (CheckFramebufferStatus, "glCheckFramebufferStatus");
  LOAD (BlitFramebuffer, "glBlitFramebuffer");
  LOAD (Flush, "glFlush");
  LOAD (CreateImage, "eglCreateImageKHR");
  LOAD (DestroyImage, "eglDestroyImageKHR");
  LOAD (ExportQuery, "eglExportDMABUFImageQueryMESA");
  LOAD (Export, "eglExportDMABUFImageMESA");
  LOAD (CreateSync, "eglCreateSyncKHR");
  LOAD (WaitSync, "eglWaitSyncKHR");
  LOAD (ClientWaitSync, "eglClientWaitSyncKHR");
  LOAD (DestroySync, "eglDestroySyncKHR");
#undef LOAD
  return TRUE;
}

static gboolean
has_extension (EGLDisplay display, const char *name)
{
  const char *extensions = eglQueryString (display, EGL_EXTENSIONS);
  if (extensions == NULL)
    return FALSE;
  gsize length = strlen (name);
  for (const char *at = strstr (extensions, name); at != NULL; at = strstr (at + 1, name)) {
    if ((at == extensions || at[-1] == ' ') && (at[length] == ' ' || at[length] == '\0'))
      return TRUE;
  }
  return FALSE;
}

typedef struct {
  EGLDisplay display;
  EGLSurface draw;
  EGLSurface read;
  EGLContext context;
} SavedContext;

static gboolean
make_current (GpuCopier *gpu, SavedContext *saved)
{
  saved->display = eglGetCurrentDisplay ();
  saved->draw = eglGetCurrentSurface (EGL_DRAW);
  saved->read = eglGetCurrentSurface (EGL_READ);
  saved->context = eglGetCurrentContext ();
  return eglMakeCurrent (gpu->display, EGL_NO_SURFACE, EGL_NO_SURFACE, gpu->context);
}

static void
restore_current (SavedContext *saved)
{
  if (saved->display != EGL_NO_DISPLAY)
    eglMakeCurrent (saved->display, saved->draw, saved->read, saved->context);
  else
    eglMakeCurrent (eglGetCurrentDisplay (), EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
}

static void
release_slot (GpuCopier *gpu, Slot *slot)
{
  if (slot->fd >= 0)
    close (slot->fd);
  if (slot->image != EGL_NO_IMAGE_KHR)
    gpu->gl.DestroyImage (gpu->display, slot->image);
  if (slot->texture != 0)
    gpu->gl.DeleteTextures (1, &slot->texture);
  g_clear_pointer (&slot->busy, g_atomic_rc_box_release);
  slot->fd = -1;
  slot->image = EGL_NO_IMAGE_KHR;
  slot->texture = 0;
}

static void
gpu_free (GpuCopier *gpu)
{
  if (gpu == NULL)
    return;
  SavedContext saved;
  if (make_current (gpu, &saved)) {
    for (guint i = 0; i < POOL_SLOTS; i++)
      release_slot (gpu, &gpu->slots[i]);
    if (gpu->read_fbo != 0)
      gpu->gl.DeleteFramebuffers (1, &gpu->read_fbo);
    if (gpu->draw_fbo != 0)
      gpu->gl.DeleteFramebuffers (1, &gpu->draw_fbo);
    restore_current (&saved);
  }
  eglDestroyContext (gpu->display, gpu->context);
  g_free (gpu);
}

static GpuCopier *
gpu_new (EGLDisplay display)
{
  if (display == EGL_NO_DISPLAY || !eglInitialize (display, NULL, NULL))
    return NULL;
  if (!has_extension (display, "EGL_EXT_image_dma_buf_import")
      || !has_extension (display, "EGL_MESA_image_dma_buf_export")
      || !has_extension (display, "EGL_KHR_surfaceless_context")
      || !has_extension (display, "EGL_KHR_no_config_context"))
    return NULL;
  GpuCopier *gpu = g_new0 (GpuCopier, 1);
  gpu->display = display;
  for (guint i = 0; i < POOL_SLOTS; i++)
    gpu->slots[i].fd = -1;
  if (!load_gl (&gpu->gl) || !eglBindAPI (EGL_OPENGL_ES_API)) {
    g_free (gpu);
    return NULL;
  }
  static const EGLint attributes[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
  gpu->context = eglCreateContext (display, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attributes);
  if (gpu->context == EGL_NO_CONTEXT) {
    g_free (gpu);
    return NULL;
  }
  gpu->native_fences = has_extension (display, "EGL_ANDROID_native_fence_sync");
  SavedContext saved;
  if (!make_current (gpu, &saved)) {
    eglDestroyContext (display, gpu->context);
    g_free (gpu);
    return NULL;
  }
  gpu->gl.GenFramebuffers (1, &gpu->read_fbo);
  gpu->gl.GenFramebuffers (1, &gpu->draw_fbo);
  restore_current (&saved);
  return gpu;
}

/* (Re)creates the pool for a new size. Called with the context current. */
static gboolean
gpu_configure (GpuCopier *gpu, int width, int height)
{
  if (gpu->width == width && gpu->height == height)
    return TRUE;
  for (guint i = 0; i < POOL_SLOTS; i++) {
    /* A slot a consumer still holds keeps its fd open through the GstBuffer's
     * own dup; closing ours here is safe. */
    release_slot (gpu, &gpu->slots[i]);
  }
  gpu->width = width;
  gpu->height = height;
  for (guint i = 0; i < POOL_SLOTS; i++) {
    Slot *slot = &gpu->slots[i];
    slot->busy = g_atomic_rc_box_new0 (gint);
    gpu->gl.GenTextures (1, &slot->texture);
    gpu->gl.BindTexture (GL_TEXTURE_2D, slot->texture);
    gpu->gl.TexParameteri (GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    gpu->gl.TexParameteri (GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    gpu->gl.TexStorage2D (GL_TEXTURE_2D, 1, GL_RGBA8, width, height);
    slot->image = gpu->gl.CreateImage (gpu->display, eglGetCurrentContext (), EGL_GL_TEXTURE_2D_KHR,
                                       (EGLClientBuffer) (guintptr) slot->texture, NULL);
    int planes = 0;
    EGLint stride = 0, offset = 0;
    int fourcc = 0;
    EGLuint64KHR modifier = 0;
    if (slot->image == EGL_NO_IMAGE_KHR
        || !gpu->gl.ExportQuery (gpu->display, slot->image, &fourcc, &planes, &modifier) || planes != 1
        || !gpu->gl.Export (gpu->display, slot->image, &slot->fd, &stride, &offset)) {
      gpu->width = gpu->height = 0;
      return FALSE;
    }
    slot->fourcc = (guint32) fourcc;
    slot->modifier = modifier;
    slot->stride = (guint32) stride;
    slot->offset = (guint32) offset;
  }
  return TRUE;
}

static EGLImageKHR
import_source (GpuCopier *gpu, WPEBufferDMABuf *source, int width, int height)
{
  guint planes = wpe_buffer_dma_buf_get_n_planes (source);
  if (planes == 0 || planes > 4)
    return EGL_NO_IMAGE_KHR;
  guint64 modifier = wpe_buffer_dma_buf_get_modifier (source);
  EGLint attributes[64];
  guint n = 0;
  attributes[n++] = EGL_WIDTH;
  attributes[n++] = width;
  attributes[n++] = EGL_HEIGHT;
  attributes[n++] = height;
  attributes[n++] = EGL_LINUX_DRM_FOURCC_EXT;
  attributes[n++] = (EGLint) wpe_buffer_dma_buf_get_format (source);
  static const EGLint plane_keys[4][5] = {
    { EGL_DMA_BUF_PLANE0_FD_EXT, EGL_DMA_BUF_PLANE0_OFFSET_EXT, EGL_DMA_BUF_PLANE0_PITCH_EXT,
      EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT },
    { EGL_DMA_BUF_PLANE1_FD_EXT, EGL_DMA_BUF_PLANE1_OFFSET_EXT, EGL_DMA_BUF_PLANE1_PITCH_EXT,
      EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT },
    { EGL_DMA_BUF_PLANE2_FD_EXT, EGL_DMA_BUF_PLANE2_OFFSET_EXT, EGL_DMA_BUF_PLANE2_PITCH_EXT,
      EGL_DMA_BUF_PLANE2_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE2_MODIFIER_HI_EXT },
    { EGL_DMA_BUF_PLANE3_FD_EXT, EGL_DMA_BUF_PLANE3_OFFSET_EXT, EGL_DMA_BUF_PLANE3_PITCH_EXT,
      EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT },
  };
  /* DRM_FORMAT_MOD_INVALID means "implicit": no modifier attributes. */
  gboolean explicit_modifier = modifier != G_GUINT64_CONSTANT (0x00ffffffffffffff);
  for (guint i = 0; i < planes; i++) {
    attributes[n++] = plane_keys[i][0];
    attributes[n++] = wpe_buffer_dma_buf_get_fd (source, i);
    attributes[n++] = plane_keys[i][1];
    attributes[n++] = (EGLint) wpe_buffer_dma_buf_get_offset (source, i);
    attributes[n++] = plane_keys[i][2];
    attributes[n++] = (EGLint) wpe_buffer_dma_buf_get_stride (source, i);
    if (explicit_modifier) {
      attributes[n++] = plane_keys[i][3];
      attributes[n++] = (EGLint) (modifier & 0xffffffff);
      attributes[n++] = plane_keys[i][4];
      attributes[n++] = (EGLint) (modifier >> 32);
    }
  }
  attributes[n++] = EGL_NONE;
  return gpu->gl.CreateImage (gpu->display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, NULL, attributes);
}

/* Waits (on the GPU) for WebKit's rendering fence of `buffer`, if any. */
static void
wait_rendering_fence (GpuCopier *gpu, WPEBuffer *buffer)
{
  int fence = wpe_buffer_get_rendering_fence (buffer);
  if (fence < 0 || !gpu->native_fences)
    return;
  int copy = dup (fence);
  if (copy < 0)
    return;
  EGLint attributes[] = { EGL_SYNC_NATIVE_FENCE_FD_ANDROID, copy, EGL_NONE };
  EGLSyncKHR sync = gpu->gl.CreateSync (gpu->display, EGL_SYNC_NATIVE_FENCE_ANDROID, attributes);
  if (sync == EGL_NO_SYNC_KHR) {
    close (copy);
    return;
  }
  gpu->gl.WaitSync (gpu->display, sync, 0);
  gpu->gl.DestroySync (gpu->display, sync);
}

/* Copies `buffer` into a free slot and waits until the copy is complete.
 * Returns the slot, or NULL when every slot is still held by the consumer
 * (the frame is dropped; the next one will find a slot). */
static Slot *
gpu_copy (GpuCopier *gpu, WPEBuffer *buffer, gboolean *error)
{
  *error = FALSE;
  int width = wpe_buffer_get_width (buffer);
  int height = wpe_buffer_get_height (buffer);
  SavedContext saved;
  if (!make_current (gpu, &saved)) {
    *error = TRUE;
    return NULL;
  }
  Slot *slot = NULL;
  if (!gpu_configure (gpu, width, height)) {
    *error = TRUE;
    goto out;
  }
  for (guint i = 0; i < POOL_SLOTS; i++) {
    if (g_atomic_int_get (gpu->slots[i].busy) == 0) {
      slot = &gpu->slots[i];
      break;
    }
  }
  if (slot == NULL)
    goto out;
  EGLImageKHR source = import_source (gpu, WPE_BUFFER_DMA_BUF (buffer), width, height);
  if (source == EGL_NO_IMAGE_KHR) {
    *error = TRUE;
    slot = NULL;
    goto out;
  }
  GLuint source_texture = 0;
  gpu->gl.GenTextures (1, &source_texture);
  gpu->gl.BindTexture (GL_TEXTURE_2D, source_texture);
  gpu->gl.EGLImageTargetTexture2DOES (GL_TEXTURE_2D, source);
  wait_rendering_fence (gpu, buffer);
  gpu->gl.BindFramebuffer (GL_READ_FRAMEBUFFER, gpu->read_fbo);
  gpu->gl.FramebufferTexture2D (GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, source_texture, 0);
  gpu->gl.BindFramebuffer (GL_DRAW_FRAMEBUFFER, gpu->draw_fbo);
  gpu->gl.FramebufferTexture2D (GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, slot->texture, 0);
  if (gpu->gl.CheckFramebufferStatus (GL_READ_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE
      || gpu->gl.CheckFramebufferStatus (GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
    *error = TRUE;
    slot = NULL;
  } else {
    gpu->gl.BlitFramebuffer (0, 0, width, height, 0, 0, width, height, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    /* The consumer receives no fence: wait here until the copy is done. */
    EGLSyncKHR done = gpu->gl.CreateSync (gpu->display, EGL_SYNC_FENCE_KHR, NULL);
    gpu->gl.Flush ();
    if (done != EGL_NO_SYNC_KHR) {
      EGLint result =
        gpu->gl.ClientWaitSync (gpu->display, done, EGL_SYNC_FLUSH_COMMANDS_BIT_KHR, FENCE_TIMEOUT_NS);
      gpu->gl.DestroySync (gpu->display, done);
      if (result != EGL_CONDITION_SATISFIED_KHR) {
        *error = TRUE;
        slot = NULL;
      }
    } else {
      *error = TRUE;
      slot = NULL;
    }
  }
  gpu->gl.FramebufferTexture2D (GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  gpu->gl.FramebufferTexture2D (GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
  gpu->gl.BindFramebuffer (GL_READ_FRAMEBUFFER, 0);
  gpu->gl.BindFramebuffer (GL_DRAW_FRAMEBUFFER, 0);
  gpu->gl.DeleteTextures (1, &source_texture);
  gpu->gl.DestroyImage (gpu->display, source);
out:
  restore_current (&saved);
  return slot;
}

int
tc_frames_test_gpu_copy (gpointer egl_display, WPEBuffer *buffer, guint32 *fourcc, guint64 *modifier,
                         guint32 *stride)
{
  GpuCopier *gpu = gpu_new (egl_display);
  if (gpu == NULL)
    return -1;
  gboolean error = FALSE;
  Slot *slot = gpu_copy (gpu, buffer, &error);
  int fd = -1;
  if (slot != NULL && !error) {
    fd = dup (slot->fd);
    *fourcc = slot->fourcc;
    *modifier = slot->modifier;
    *stride = slot->stride;
  }
  gpu_free (gpu);
  return fd;
}

/* ------------------------------------------------------------ pipeline */

static const GQuark *
slot_quark (void)
{
  static GQuark quark;
  if (quark == 0)
    quark = g_quark_from_static_string ("tc-frames-slot");
  return &quark;
}

static void
slot_released (gpointer busy)
{
  g_atomic_int_dec_and_test ((gint *) busy);
  g_atomic_rc_box_release (busy);
}

static void
hold_slot (GstBuffer *buffer, gint *busy)
{
  g_atomic_int_inc (busy);
  gst_mini_object_set_qdata (GST_MINI_OBJECT (buffer), *slot_quark (), g_atomic_rc_box_acquire (busy),
                             slot_released);
}

static void
set_caps (TcFrames *frames, const char *format, guint32 fourcc, guint64 modifier, int width, int height)
{
  char key[96];
  g_snprintf (key, sizeof key, "%s/%08x/%016" G_GINT64_MODIFIER "x/%dx%d", format, fourcc, modifier, width, height);
  if (strcmp (key, frames->caps_key) == 0)
    return;
  g_strlcpy (frames->caps_key, key, sizeof frames->caps_key);
  g_autoptr (GstCaps) caps = NULL;
  if (fourcc != 0) {
    g_autofree char *drm = gst_video_dma_drm_fourcc_to_string (fourcc, modifier);
    caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "DMA_DRM", "drm-format", G_TYPE_STRING, drm,
                                "width", G_TYPE_INT, width, "height", G_TYPE_INT, height, "framerate",
                                GST_TYPE_FRACTION, 0, 1, NULL);
    gst_caps_set_features (caps, 0, gst_caps_features_new_single_static_str (GST_CAPS_FEATURE_MEMORY_DMABUF));
  } else {
    caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, format, "width", G_TYPE_INT, width, "height",
                                G_TYPE_INT, height, "framerate", GST_TYPE_FRACTION, 0, 1, NULL);
  }
  gst_app_src_set_caps (GST_APP_SRC (frames->appsrc), caps);
}

static void
send (TcFrames *frames, GstBuffer *buffer)
{
  frames->last_push_us = g_get_monotonic_time ();
  gst_buffer_replace (&frames->last, buffer);
  gst_app_src_push_buffer (GST_APP_SRC (frames->appsrc), buffer);
  if (frames->sent++ == 0 && frames->first_frame != NULL)
    frames->first_frame (frames->user_data);
}

static GstBuffer *
export_shm (TcFrames *frames, WPEBufferSHM *shm)
{
  WPEBuffer *buffer = WPE_BUFFER (shm);
  int width = wpe_buffer_get_width (buffer);
  int height = wpe_buffer_get_height (buffer);
  gsize size = 0;
  const guint8 *pixels = g_bytes_get_data (wpe_buffer_shm_get_data (shm), &size);
  guint stride = wpe_buffer_shm_get_stride (shm);
  gsize row = (gsize) width * 4u;
  if (width <= 0 || height <= 0 || stride < row || size < (gsize) stride * (gsize) (height - 1) + row)
    return NULL;
  GstMemory *memory = gst_allocator_alloc (frames->shm, row * (gsize) height, NULL);
  if (memory == NULL)
    return NULL;
  GstMapInfo map;
  if (!gst_memory_map (memory, &map, GST_MAP_WRITE)) {
    gst_memory_unref (memory);
    return NULL;
  }
  if (stride == row) {
    memcpy (map.data, pixels, row * (gsize) height);
  } else {
    for (int y = 0; y < height; y++)
      memcpy (map.data + (gsize) y * row, pixels + (gsize) y * stride, row);
  }
  gst_memory_unmap (memory, &map);
  /* WPE_PIXEL_FORMAT_ARGB8888 is little-endian ARGB, GStreamer's BGRA. */
  set_caps (frames, "BGRA", 0, 0, width, height);
  GstBuffer *out = gst_buffer_new ();
  gst_buffer_append_memory (out, memory);
  return out;
}

static GstBuffer *
export_dmabuf (TcFrames *frames, WPEBuffer *buffer)
{
  if (frames->gpu == NULL)
    frames->gpu = gpu_new (frames->egl_display);
  if (frames->gpu == NULL) {
    frames->failed = TRUE;
    return NULL;
  }
  gboolean error = FALSE;
  Slot *slot = gpu_copy (frames->gpu, buffer, &error);
  if (error) {
    frames->failed = TRUE;
    return NULL;
  }
  if (slot == NULL)
    return NULL;
  int width = wpe_buffer_get_width (buffer);
  int height = wpe_buffer_get_height (buffer);
  int fd = dup (slot->fd);
  if (fd < 0)
    return NULL;
  GstBuffer *out = gst_buffer_new ();
  GstMemory *memory =
    gst_dmabuf_allocator_alloc (frames->dmabuf, fd, (gsize) slot->offset + (gsize) slot->stride * (gsize) height);
  gst_buffer_append_memory (out, memory);
  gsize offsets[GST_VIDEO_MAX_PLANES] = { slot->offset };
  gint strides[GST_VIDEO_MAX_PLANES] = { (gint) slot->stride };
  gst_buffer_add_video_meta_full (out, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_DMA_DRM, width, height, 1, offsets,
                                  strides);
  hold_slot (out, slot->busy);
  set_caps (frames, "DMA_DRM", slot->fourcc, slot->modifier, width, height);
  return out;
}

static void
export_and_send (TcFrames *frames, WPEBuffer *buffer)
{
  GstBuffer *out = WPE_IS_BUFFER_DMA_BUF (buffer) ? export_dmabuf (frames, buffer)
                                                  : WPE_IS_BUFFER_SHM (buffer) ? export_shm (frames, WPE_BUFFER_SHM (buffer))
                                                                               : NULL;
  if (out != NULL)
    send (frames, out);
  else if (!WPE_IS_BUFFER_DMA_BUF (buffer) && !WPE_IS_BUFFER_SHM (buffer))
    frames->failed = TRUE;
}

static gboolean
on_pending_due (gpointer data)
{
  TcFrames *frames = data;
  frames->pending_source = 0;
  if (frames->pending != NULL) {
    g_autoptr (WPEBuffer) pending = g_steal_pointer (&frames->pending);
    export_and_send (frames, pending);
  }
  return G_SOURCE_REMOVE;
}

void
tc_frames_push (TcFrames *frames, WPEBuffer *buffer)
{
  gint64 now = g_get_monotonic_time ();
  frames->last_frame_us = now;
  if (WPE_IS_BUFFER_SHM (buffer)) {
    /* The newest committed SHM buffer stays untouched until the next frame
     * commits, which replaces `pending`; copying it later is safe. */
    gint64 interval = G_USEC_PER_SEC / SOFTWARE_MAX_FPS;
    gint64 due = frames->last_push_us + interval;
    if (frames->sent > 0 && now < due) {
      g_set_object (&frames->pending, buffer);
      if (frames->pending_source == 0)
        frames->pending_source = g_timeout_add ((guint) ((due - now + 999) / 1000), on_pending_due, frames);
      return;
    }
  }
  g_clear_object (&frames->pending);
  export_and_send (frames, buffer);
}

static gboolean
on_idle_check (gpointer data)
{
  TcFrames *frames = data;
  if (frames->last != NULL && g_get_monotonic_time () - frames->last_push_us >= IDLE_REPEAT_US) {
    frames->last_push_us = g_get_monotonic_time ();
    /* A new buffer object on the same memory; do-timestamp stamps it now. The
     * copy holds the same pool slot and keeps it busy. */
    GstBuffer *repeat = gst_buffer_copy (frames->last);
    gint *busy = gst_mini_object_get_qdata (GST_MINI_OBJECT (frames->last), *slot_quark ());
    if (busy != NULL)
      hold_slot (repeat, busy);
    gst_app_src_push_buffer (GST_APP_SRC (frames->appsrc), repeat);
  }
  return G_SOURCE_CONTINUE;
}

TcFrames *
tc_frames_new (const char *socket_path, gpointer egl_display, TcFramesFirstFrame first_frame, gpointer user_data,
               GError **error)
{
  TcFrames *frames = g_new0 (TcFrames, 1);
  frames->socket_path = g_strdup (socket_path);
  frames->egl_display = egl_display;
  frames->first_frame = first_frame;
  frames->user_data = user_data;
  frames->shm = gst_shm_allocator_get ();
  frames->dmabuf = gst_dmabuf_allocator_new ();
  frames->pipeline = gst_pipeline_new (NULL);
  frames->appsrc = gst_element_factory_make ("appsrc", NULL);
  GstElement *queue = gst_element_factory_make ("queue", NULL);
  GstElement *sink = gst_element_factory_make ("unixfdsink", NULL);
  if (frames->appsrc == NULL || queue == NULL || sink == NULL) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "GStreamer appsrc, queue or unixfdsink missing");
    g_clear_object (&queue);
    g_clear_object (&sink);
    tc_frames_free (frames);
    return NULL;
  }
  g_object_set (frames->appsrc, "is-live", TRUE, "do-timestamp", TRUE, "format", GST_FORMAT_TIME, "max-buffers",
                (guint64) 1, "leaky-type", 2 /* downstream: drop the oldest */, "block", FALSE, NULL);
  g_object_set (queue, "max-size-buffers", 1, "max-size-bytes", 0, "max-size-time", (guint64) 0, "leaky",
                2 /* downstream */, NULL);
  g_object_set (sink, "socket-path", socket_path, "sync", FALSE, "async", FALSE, NULL);
  gst_bin_add_many (GST_BIN (frames->pipeline), frames->appsrc, queue, sink, NULL);
  if (!gst_element_link_many (frames->appsrc, queue, sink, NULL)
      || gst_element_set_state (frames->pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_FAILED, "the frame pipeline did not start");
    tc_frames_free (frames);
    return NULL;
  }
  /* unixfdsink creates the socket with the process umask (0077); only the
   * renderer's group may connect (threat review §5). */
  if (chmod (socket_path, 0660) != 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "chmod frame socket: %s", g_strerror (errno));
    tc_frames_free (frames);
    return NULL;
  }
  frames->idle_source = g_timeout_add (250, on_idle_check, frames);
  return frames;
}

gboolean
tc_frames_failed (TcFrames *frames)
{
  return frames->failed;
}

guint64
tc_frames_sent (TcFrames *frames)
{
  return frames->sent;
}

void
tc_frames_free (TcFrames *frames)
{
  if (frames == NULL)
    return;
  if (frames->idle_source != 0)
    g_source_remove (frames->idle_source);
  if (frames->pending_source != 0)
    g_source_remove (frames->pending_source);
  g_clear_object (&frames->pending);
  if (frames->pipeline != NULL) {
    gst_element_set_state (frames->pipeline, GST_STATE_NULL);
    gst_object_unref (frames->pipeline);
  }
  gst_buffer_replace (&frames->last, NULL);
  /* The pool's textures belong to the GL context; any buffer a consumer still
   * holds keeps its own dup of the fd, so the memory outlives the texture. */
  gpu_free (frames->gpu);
  if (frames->socket_path != NULL)
    unlink (frames->socket_path);
  g_clear_object (&frames->shm);
  g_clear_object (&frames->dmabuf);
  g_free (frames->socket_path);
  g_free (frames);
}
