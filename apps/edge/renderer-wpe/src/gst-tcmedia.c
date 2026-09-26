/*
 * tcmediasrc: GStreamer source for tcmedia://sha256/<64 hex>.
 *
 * WebKit's media pipeline accepts only http, https and blob sources, so a
 * WebKit URI scheme handler cannot feed <video>. This element, loaded into
 * the web process through GST_PLUGIN_PATH, gives the pipeline direct,
 * seekable, read-only access to one verified CAS object.
 *
 * Rules:
 *   - The only accepted URI form is tcmedia://sha256/<64 lowercase hex>.
 *   - The CAS root comes from TILECAST_CAS_ROOT, set by the renderer host
 *     at startup (never from the page or the URI).
 *   - Files are opened with O_NOFOLLOW and must be regular files.
 *   - Integrity was established by tilecastd before the object entered the
 *     CAS; this element never writes.
 * The CAS holds only verified media, Edge objects and release artifacts. It
 * never holds credentials or keys, so read access to it grants nothing more
 * than the content this screen already has.
 */
#include "validate.h"

#include <errno.h>
#include <fcntl.h>
#include <gst/base/gstbasesrc.h>
#include <gst/gst.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define TC_TYPE_MEDIA_SRC (tc_media_src_get_type ())
G_DECLARE_FINAL_TYPE (TcMediaSrc, tc_media_src, TC, MEDIA_SRC, GstBaseSrc)

struct _TcMediaSrc {
  GstBaseSrc parent_instance;
  char *uri;
  char hex[65];
  int fd;
  guint64 size;
};

static void tc_media_src_uri_handler_init (gpointer iface, gpointer data);

G_DEFINE_FINAL_TYPE_WITH_CODE (TcMediaSrc, tc_media_src, GST_TYPE_BASE_SRC,
                               G_IMPLEMENT_INTERFACE (GST_TYPE_URI_HANDLER, tc_media_src_uri_handler_init))

static GstStaticPadTemplate src_template = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static gboolean
parse_uri (const char *uri, char out[65])
{
  static const char prefix[] = "tcmedia://sha256/";
  if (uri == NULL || strncmp (uri, prefix, sizeof prefix - 1) != 0)
    return FALSE;
  const char *hex = uri + sizeof prefix - 1;
  if (!tc_is_sha256_hex (hex))
    return FALSE;
  memcpy (out, hex, 65);
  return TRUE;
}

static gboolean
tc_media_src_start (GstBaseSrc *base)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  const char *root = g_getenv ("TILECAST_CAS_ROOT");
  if (!tc_is_clean_absolute_path (root) || self->hex[0] == '\0') {
    GST_ELEMENT_ERROR (self, RESOURCE, NOT_FOUND, ("content store unavailable"), (NULL));
    return FALSE;
  }
  char fanout[3] = { self->hex[0], self->hex[1], '\0' };
  g_autofree char *path = g_build_filename (root, "sha256", fanout, self->hex, NULL);
  int fd = open (path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (fd < 0 || fstat (fd, &st) != 0 || !S_ISREG (st.st_mode)) {
    if (fd >= 0)
      close (fd);
    GST_ELEMENT_ERROR (self, RESOURCE, NOT_FOUND, ("content %.12s is not available", self->hex), (NULL));
    return FALSE;
  }
  self->fd = fd;
  self->size = (guint64) st.st_size;
  return TRUE;
}

static gboolean
tc_media_src_stop (GstBaseSrc *base)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  if (self->fd >= 0) {
    close (self->fd);
    self->fd = -1;
  }
  return TRUE;
}

static gboolean
tc_media_src_get_size (GstBaseSrc *base, guint64 *size)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  if (self->fd < 0)
    return FALSE;
  *size = self->size;
  return TRUE;
}

static gboolean
tc_media_src_is_seekable (GstBaseSrc *base)
{
  (void) base;
  return TRUE;
}

static GstFlowReturn
tc_media_src_fill (GstBaseSrc *base, guint64 offset, guint length, GstBuffer *buffer)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  if (offset >= self->size)
    return GST_FLOW_EOS;
  GstMapInfo map;
  if (!gst_buffer_map (buffer, &map, GST_MAP_WRITE))
    return GST_FLOW_ERROR;
  gsize want = (gsize) MIN ((guint64) length, self->size - offset);
  gsize done = 0;
  while (done < want) {
    ssize_t got = pread (self->fd, map.data + done, want - done, (off_t) (offset + done));
    if (got < 0 && errno == EINTR)
      continue;
    if (got <= 0)
      break;
    done += (gsize) got;
  }
  gst_buffer_unmap (buffer, &map);
  if (done == 0) {
    GST_ELEMENT_ERROR (self, RESOURCE, READ, ("read failed"), (NULL));
    return GST_FLOW_ERROR;
  }
  gst_buffer_set_size (buffer, done);
  GST_BUFFER_OFFSET (buffer) = offset;
  GST_BUFFER_OFFSET_END (buffer) = offset + done;
  return GST_FLOW_OK;
}

static void
tc_media_src_finalize (GObject *object)
{
  TcMediaSrc *self = TC_MEDIA_SRC (object);
  g_free (self->uri);
  if (self->fd >= 0)
    close (self->fd);
  G_OBJECT_CLASS (tc_media_src_parent_class)->finalize (object);
}

static void
tc_media_src_class_init (TcMediaSrcClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  GstElementClass *element_class = GST_ELEMENT_CLASS (klass);
  GstBaseSrcClass *base_class = GST_BASE_SRC_CLASS (klass);
  object_class->finalize = tc_media_src_finalize;
  gst_element_class_set_static_metadata (element_class, "Tilecast CAS source", "Source/File",
                                         "Reads verified Tilecast content-addressed objects", "Tilecast");
  gst_element_class_add_static_pad_template (element_class, &src_template);
  base_class->start = tc_media_src_start;
  base_class->stop = tc_media_src_stop;
  base_class->get_size = tc_media_src_get_size;
  base_class->is_seekable = tc_media_src_is_seekable;
  base_class->fill = tc_media_src_fill;
}

static void
tc_media_src_init (TcMediaSrc *self)
{
  self->fd = -1;
  gst_base_src_set_format (GST_BASE_SRC (self), GST_FORMAT_BYTES);
}

static GstURIType
uri_get_type (GType type)
{
  (void) type;
  return GST_URI_SRC;
}

static const gchar *const *
uri_get_protocols (GType type)
{
  (void) type;
  static const gchar *const protocols[] = { "tcmedia", NULL };
  return protocols;
}

static gchar *
uri_get_uri (GstURIHandler *handler)
{
  return g_strdup (TC_MEDIA_SRC (handler)->uri);
}

static gboolean
uri_set_uri (GstURIHandler *handler, const gchar *uri, GError **error)
{
  TcMediaSrc *self = TC_MEDIA_SRC (handler);
  char hex[65];
  if (!parse_uri (uri, hex)) {
    g_set_error (error, GST_URI_ERROR, GST_URI_ERROR_BAD_URI, "not a Tilecast content URI");
    return FALSE;
  }
  g_free (self->uri);
  self->uri = g_strdup (uri);
  memcpy (self->hex, hex, sizeof hex);
  return TRUE;
}

static void
tc_media_src_uri_handler_init (gpointer iface, gpointer data)
{
  (void) data;
  GstURIHandlerInterface *uri = iface;
  uri->get_type = uri_get_type;
  uri->get_protocols = uri_get_protocols;
  uri->get_uri = uri_get_uri;
  uri->set_uri = uri_set_uri;
}

static gboolean
plugin_init (GstPlugin *plugin)
{
  return gst_element_register (plugin, "tcmediasrc", GST_RANK_PRIMARY, TC_TYPE_MEDIA_SRC);
}

#define PACKAGE "tilecast"
/* The code is AGPL-3.0-only. GStreamer accepts only a fixed list of license
 * identifiers; "GPL" is the closest one it knows. */
GST_PLUGIN_DEFINE (GST_VERSION_MAJOR, GST_VERSION_MINOR, tcmedia, "Tilecast content-addressed media source", plugin_init,
                   "0.1.0", "GPL", "tilecast", "https://github.com/gbyo/tilecast")
