/*
 * tcmediasrc: GStreamer source for tcmedia://cap/<opaque capability>, and
 * tcwebsrc: GStreamer source for tcweb://cap/<opaque capability> (below).
 *
 * WPE's media pipeline uses this URI handler for seekable Tilecast media.
 * The source makes bounded reads from tilecastd's media socket. It never
 * receives a digest or opens a CAS path.
 */
#include "media-client.h"
#include "validate.h"

#include <gst/base/gstbasesrc.h>
#include <gst/gst.h>
#include <string.h>

#define TC_TYPE_MEDIA_SRC (tc_media_src_get_type ())
G_DECLARE_FINAL_TYPE (TcMediaSrc, tc_media_src, TC, MEDIA_SRC, GstBaseSrc)

struct _TcMediaSrc {
  GstBaseSrc parent_instance;
  char *uri;
  char *socket_path;
  char capability[65];
  guint64 size;
};

static void tc_media_src_uri_handler_init (gpointer iface, gpointer data);

G_DEFINE_FINAL_TYPE_WITH_CODE (TcMediaSrc, tc_media_src, GST_TYPE_BASE_SRC,
                               G_IMPLEMENT_INTERFACE (GST_TYPE_URI_HANDLER, tc_media_src_uri_handler_init))

static GstStaticPadTemplate src_template = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static gboolean
parse_uri (const char *uri, char out[65])
{
  static const char prefix[] = "tcmedia://cap/";
  if (!tc_is_media_capability_uri (uri))
    return FALSE;
  memcpy (out, uri + sizeof prefix - 1, 65);
  return TRUE;
}

static gboolean
tc_media_src_start (GstBaseSrc *base)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  const char *socket_path = g_getenv ("TILECAST_MEDIA_SOCKET");
  if (!tc_is_clean_absolute_path (socket_path) || self->capability[0] == '\0') {
    GST_ELEMENT_ERROR (self, RESOURCE, NOT_FOUND, ("media capability channel unavailable"), (NULL));
    return FALSE;
  }
  g_free (self->socket_path);
  self->socket_path = g_strdup (socket_path);
  g_autoptr (GError) error = NULL;
  g_autofree char *mime_type = NULL;
  if (!tc_media_head (self->socket_path, self->capability, &self->size, &mime_type, &error)) {
    GST_ELEMENT_ERROR (self, RESOURCE, NOT_FOUND, ("media capability was denied"), (NULL));
    return FALSE;
  }
  return TRUE;
}

static gboolean
tc_media_src_stop (GstBaseSrc *base)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  g_clear_pointer (&self->socket_path, g_free);
  self->size = 0;
  return TRUE;
}

static gboolean
tc_media_src_get_size (GstBaseSrc *base, guint64 *size)
{
  TcMediaSrc *self = TC_MEDIA_SRC (base);
  if (self->socket_path == NULL)
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
  g_autoptr (GError) error = NULL;
  while (done < want) {
    guint32 chunk = (guint32) MIN (want - done, (gsize) TC_MEDIA_MAX_READ);
    if (!tc_media_read (self->socket_path, self->capability, offset + done, map.data + done, chunk, &error)) {
      gst_buffer_unmap (buffer, &map);
      GST_ELEMENT_ERROR (self, RESOURCE, READ, ("daemon media read failed"), (NULL));
      return GST_FLOW_ERROR;
    }
    done += chunk;
  }
  gst_buffer_unmap (buffer, &map);
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
  g_free (self->socket_path);
  G_OBJECT_CLASS (tc_media_src_parent_class)->finalize (object);
}

static void
tc_media_src_class_init (TcMediaSrcClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  GstElementClass *element_class = GST_ELEMENT_CLASS (klass);
  GstBaseSrcClass *base_class = GST_BASE_SRC_CLASS (klass);
  object_class->finalize = tc_media_src_finalize;
  gst_element_class_set_static_metadata (element_class, "Tilecast media source", "Source/File",
                                         "Reads capability-authorized Tilecast media through tilecastd", "Tilecast");
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
  char capability[65];
  if (!parse_uri (uri, capability)) {
    g_set_error (error, GST_URI_ERROR, GST_URI_ERROR_BAD_URI, "not a Tilecast media capability URI");
    return FALSE;
  }
  g_free (self->uri);
  self->uri = g_strdup (uri);
  memcpy (self->capability, capability, sizeof capability);
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

/* ------------------------------------------------------------------ tcwebsrc
 *
 * tcweb://cap/<capability>: the frames of one remote web surface, received
 * from the isolated helper through unixfdsrc (docs/tilecast-edge-remote-web-
 * threat-review.md §7). The capability is the only input: the socket path is
 * <TILECAST_WEB_FRAMES_DIR>/<capability>.sock, built like a CAS path from a
 * digest. A capability the helper did not issue, or revoked, names no
 * socket, and the element fails like a missing file. */

#define TC_TYPE_WEB_SRC (tc_web_src_get_type ())
G_DECLARE_FINAL_TYPE (TcWebSrc, tc_web_src, TC, WEB_SRC, GstBin)

struct _TcWebSrc {
  GstBin parent_instance;
  GstElement *frames;
  char *uri;
};

static void tc_web_src_uri_handler_init (gpointer iface, gpointer data);

G_DEFINE_FINAL_TYPE_WITH_CODE (TcWebSrc, tc_web_src, GST_TYPE_BIN,
                               G_IMPLEMENT_INTERFACE (GST_TYPE_URI_HANDLER, tc_web_src_uri_handler_init))

static void
tc_web_src_init (TcWebSrc *self)
{
  self->frames = gst_element_factory_make ("unixfdsrc", "frames");
  if (self->frames == NULL)
    return; /* set_uri refuses; the pipeline reports a missing plugin */
  gst_bin_add (GST_BIN (self), self->frames);
  GstPad *target = gst_element_get_static_pad (self->frames, "src");
  GstPad *ghost = gst_ghost_pad_new_from_template ("src", target, gst_static_pad_template_get (&src_template));
  gst_object_unref (target);
  gst_element_add_pad (GST_ELEMENT (self), ghost);
  GST_OBJECT_FLAG_SET (self, GST_ELEMENT_FLAG_SOURCE);
}

static void
tc_web_src_finalize (GObject *object)
{
  g_free (TC_WEB_SRC (object)->uri);
  G_OBJECT_CLASS (tc_web_src_parent_class)->finalize (object);
}

static void
tc_web_src_class_init (TcWebSrcClass *klass)
{
  G_OBJECT_CLASS (klass)->finalize = tc_web_src_finalize;
  gst_element_class_set_static_metadata (GST_ELEMENT_CLASS (klass), "Tilecast remote web source", "Source/Video",
                                         "Frames of an isolated remote web surface", "Tilecast");
  gst_element_class_add_static_pad_template (GST_ELEMENT_CLASS (klass), &src_template);
}

static const gchar *const *
web_uri_get_protocols (GType type)
{
  (void) type;
  static const gchar *const protocols[] = { "tcweb", NULL };
  return protocols;
}

static gchar *
web_uri_get_uri (GstURIHandler *handler)
{
  return g_strdup (TC_WEB_SRC (handler)->uri);
}

static gboolean
web_uri_set_uri (GstURIHandler *handler, const gchar *uri, GError **error)
{
  TcWebSrc *self = TC_WEB_SRC (handler);
  static const char prefix[] = "tcweb://cap/";
  const char *dir = g_getenv ("TILECAST_WEB_FRAMES_DIR");
  if (self->frames == NULL || !tc_is_web_capability_uri (uri) || !tc_is_clean_absolute_path (dir)) {
    g_set_error (error, GST_URI_ERROR, GST_URI_ERROR_BAD_URI, "not a remote web capability URI");
    return FALSE;
  }
  g_autofree char *name = g_strdup_printf ("%s.sock", uri + sizeof prefix - 1);
  g_autofree char *path = g_build_filename (dir, name, NULL);
  g_object_set (self->frames, "socket-path", path, NULL);
  g_free (self->uri);
  self->uri = g_strdup (uri);
  return TRUE;
}

static void
tc_web_src_uri_handler_init (gpointer iface, gpointer data)
{
  (void) data;
  GstURIHandlerInterface *uri = iface;
  uri->get_type = uri_get_type;
  uri->get_protocols = web_uri_get_protocols;
  uri->get_uri = web_uri_get_uri;
  uri->set_uri = web_uri_set_uri;
}

static gboolean
plugin_init (GstPlugin *plugin)
{
  return gst_element_register (plugin, "tcmediasrc", GST_RANK_PRIMARY, TC_TYPE_MEDIA_SRC)
         && gst_element_register (plugin, "tcwebsrc", GST_RANK_PRIMARY, TC_TYPE_WEB_SRC);
}

#define PACKAGE "tilecast"
/* GStreamer accepts only a fixed list of license identifiers; "GPL" is the
 * closest identifier it knows for this AGPL-3.0-only project. */
GST_PLUGIN_DEFINE (GST_VERSION_MAJOR, GST_VERSION_MINOR, tcmedia, "Tilecast daemon-backed media source", plugin_init,
                   "0.1.0", "GPL", "tilecast", "https://github.com/gbyo/tilecast")
