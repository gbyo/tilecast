/* Spike: tcwebsrc, a bin around unixfdsrc for tcweb://cap/<hex>. The socket
 * is <TILECAST_WEB_FRAMES_DIR>/<hex>.sock; the capability is the only input. */
#include <gst/gst.h>
#include <string.h>

#define TC_TYPE_WEB_SRC (tc_web_src_get_type ())
G_DECLARE_FINAL_TYPE (TcWebSrc, tc_web_src, TC, WEB_SRC, GstBin)

struct _TcWebSrc {
  GstBin parent;
  GstElement *inner;
  GstPad *ghost;
  char *uri;
};

static void uri_init (gpointer iface, gpointer data);
G_DEFINE_FINAL_TYPE_WITH_CODE (TcWebSrc, tc_web_src, GST_TYPE_BIN,
                               G_IMPLEMENT_INTERFACE (GST_TYPE_URI_HANDLER, uri_init))

static GstStaticPadTemplate src_template = GST_STATIC_PAD_TEMPLATE ("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static gboolean
capability_ok (const char *cap)
{
  if (cap == NULL || strlen (cap) != 64)
    return FALSE;
  for (const char *c = cap; *c; c++)
    if (!g_ascii_isxdigit (*c) || g_ascii_isupper (*c))
      return FALSE;
  return TRUE;
}

static void
tc_web_src_init (TcWebSrc *self)
{
  self->inner = gst_element_factory_make ("unixfdsrc", "frames");
  gst_bin_add (GST_BIN (self), self->inner);
  GstPad *target = gst_element_get_static_pad (self->inner, "src");
  self->ghost = gst_ghost_pad_new_from_template ("src", target, gst_static_pad_template_get (&src_template));
  gst_object_unref (target);
  gst_element_add_pad (GST_ELEMENT (self), self->ghost);
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
  gst_element_class_set_static_metadata (GST_ELEMENT_CLASS (klass), "Tilecast remote web frames", "Source/Video",
                                         "spike", "Tilecast");
  gst_element_class_add_static_pad_template (GST_ELEMENT_CLASS (klass), &src_template);
}

static GstURIType get_type (GType t) { return GST_URI_SRC; }
static const gchar *const *
get_protocols (GType t)
{
  static const gchar *const p[] = { "tcweb", NULL };
  return p;
}
static gchar *get_uri (GstURIHandler *h) { return g_strdup (TC_WEB_SRC (h)->uri); }
static gboolean
set_uri (GstURIHandler *h, const gchar *uri, GError **error)
{
  TcWebSrc *self = TC_WEB_SRC (h);
  static const char prefix[] = "tcweb://cap/";
  const char *dir = g_getenv ("TILECAST_WEB_FRAMES_DIR");
  if (uri == NULL || !g_str_has_prefix (uri, prefix) || !capability_ok (uri + sizeof prefix - 1) || dir == NULL) {
    g_set_error (error, GST_URI_ERROR, GST_URI_ERROR_BAD_URI, "not a remote web capability");
    return FALSE;
  }
  g_autofree char *name = g_strdup_printf ("%s.sock", uri + sizeof prefix - 1);
  g_autofree char *path = g_build_filename (dir, name, NULL);
  g_object_set (self->inner, "socket-path", path, NULL);
  g_free (self->uri);
  self->uri = g_strdup (uri);
  return TRUE;
}
static void
uri_init (gpointer iface, gpointer data)
{
  GstURIHandlerInterface *i = iface;
  i->get_type = get_type;
  i->get_protocols = get_protocols;
  i->get_uri = get_uri;
  i->set_uri = set_uri;
}

static gboolean
plugin_init (GstPlugin *plugin)
{
  return gst_element_register (plugin, "tcwebsrc", GST_RANK_PRIMARY, TC_TYPE_WEB_SRC);
}

#define PACKAGE "tilecast"
GST_PLUGIN_DEFINE (GST_VERSION_MAJOR, GST_VERSION_MINOR, tcweb, "spike", plugin_init, "0.1.0", "GPL", "tilecast",
                   "https://github.com/gbyo/tilecast")
