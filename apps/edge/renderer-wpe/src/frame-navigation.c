#include "frame-navigation.h"

#include <glib/gstdio.h>

typedef struct {
  GMainLoop *loop;
  WebKitUserContentFilter *filter;
  GError *error;
} FrameFilterCompile;

static void
frame_filter_compiled (GObject *source, GAsyncResult *result, gpointer data)
{
  FrameFilterCompile *compile = data;
  compile->filter = webkit_user_content_filter_store_save_finish (
    WEBKIT_USER_CONTENT_FILTER_STORE (source), result, &compile->error);
  g_main_loop_quit (compile->loop);
}

static gboolean
frame_filter_timeout (gpointer data)
{
  g_cancellable_cancel (G_CANCELLABLE (data));
  return G_SOURCE_REMOVE;
}

static void
remove_filter_store (gpointer data)
{
  char *path = data;
  g_autoptr (GDir) dir = g_dir_open (path, 0, NULL);
  if (dir != NULL) {
    const char *name;
    while ((name = g_dir_read_name (dir)) != NULL) {
      g_autofree char *file = g_build_filename (path, name, NULL);
      g_unlink (file);
    }
  }
  g_rmdir (path);
  g_free (path);
}

gboolean
tc_frame_navigation_install (WebKitUserContentManager *manager, GError **error)
{
  /* Policy decisions expose the destination, not the initiating frame.
   * Content rules use the current document URL before navigation. Thus an
   * about:blank iframe can load its minted frame once, while a loaded frame
   * cannot replace itself with Runtime or another live frame document. */
  static const char rules[] =
    "[{\"trigger\":{\"url-filter\":\"^tilecast://runtime/\","
    "\"resource-type\":[\"document\"],\"load-context\":[\"child-frame\"]},"
    "\"action\":{\"type\":\"block\"}},"
    "{\"trigger\":{\"url-filter\":\".*\",\"resource-type\":[\"document\"],"
    "\"load-context\":[\"child-frame\"],\"if-frame-url\":[\"^tcwidget://cap/\"]},"
    "\"action\":{\"type\":\"block\"}}]";
  g_autofree char *path = g_dir_make_tmp ("tilecast-frame-filter-XXXXXX", error);
  if (path == NULL)
    return FALSE;
  g_object_set_data_full (G_OBJECT (manager), "tc-frame-filter-store", g_steal_pointer (&path), remove_filter_store);
  g_autoptr (WebKitUserContentFilterStore) store = webkit_user_content_filter_store_new (
    g_object_get_data (G_OBJECT (manager), "tc-frame-filter-store"));
  g_autoptr (GBytes) bytes = g_bytes_new_static (rules, sizeof rules - 1);
  g_autoptr (GCancellable) cancel = g_cancellable_new ();
  FrameFilterCompile compile = { .loop = g_main_loop_new (NULL, FALSE) };
  guint timer = g_timeout_add_seconds (5, frame_filter_timeout, cancel);
  webkit_user_content_filter_store_save (store, "frame-navigation", bytes, cancel, frame_filter_compiled, &compile);
  g_main_loop_run (compile.loop);
  if (!g_cancellable_is_cancelled (cancel))
    g_source_remove (timer);
  g_main_loop_unref (compile.loop);
  if (compile.filter == NULL) {
    g_propagate_error (error, compile.error);
    return FALSE;
  }
  webkit_user_content_manager_add_filter (manager, compile.filter);
  webkit_user_content_filter_unref (compile.filter);
  return TRUE;
}
