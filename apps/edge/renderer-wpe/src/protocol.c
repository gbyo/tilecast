/*
 * Renderer side of IPC protocol v1: daemon events in, renderer events out.
 *
 * Inbound events are checked for the fields this host itself acts on (the
 * CAS root, content lists, activation identity) and then handed to the
 * trusted runtime as JSON. Unknown event names close nothing here: tilecastd
 * never sends an event the negotiated version does not define, and the host
 * ignores anything it does not recognize rather than guessing.
 */
#include "host.h"
#include "validate.h"

#include <gst/gst.h>
#include <string.h>

/* Presentation features the trusted DOM runtime implements under WPE.
 * Websites and YouTube need an isolation design first (docs/tilecast-edge.md §10.5), so they
 * are not advertised and tilecastd will not send them. */
static const char *const RENDERER_FEATURES[] = {
  "status-surfaces-v1", "image",           "video",           "render-tree-v1", "layout-v1", "synchronized-playback-v1",
  "span-viewport-v1",   "plugin.brand_bug",   "plugin.countdown_bar", "plugin.alert_ticker", NULL,
};

static const char *
platform_name (TcPlatform platform)
{
  switch (platform) {
  case TC_PLATFORM_DRM:
    return "drm";
  case TC_PLATFORM_WAYLAND:
    return "wayland";
  case TC_PLATFORM_HEADLESS:
  default:
    return "headless";
  }
}

void
tc_protocol_send_ready (TcHost *host)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "renderer");
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "kind");
  json_builder_add_string_value (builder, "wpe");
  json_builder_set_member_name (builder, "version");
  json_builder_add_string_value (builder, TC_RENDERER_VERSION);
  json_builder_set_member_name (builder, "engineVersion");
  g_autofree char *engine = g_strdup_printf ("%u.%u.%u", webkit_get_major_version (), webkit_get_minor_version (),
                                             webkit_get_micro_version ());
  json_builder_add_string_value (builder, engine);
  guint gst_major, gst_minor, gst_micro, gst_nano;
  gst_version (&gst_major, &gst_minor, &gst_micro, &gst_nano);
  json_builder_set_member_name (builder, "gstreamerVersion");
  g_autofree char *gstreamer = g_strdup_printf ("%u.%u.%u", gst_major, gst_minor, gst_micro);
  json_builder_add_string_value (builder, gstreamer);
  json_builder_set_member_name (builder, "platform");
  json_builder_add_string_value (builder, platform_name (host->platform));
  json_builder_end_object (builder);
  json_builder_set_member_name (builder, "features");
  json_builder_begin_array (builder);
  for (guint i = 0; RENDERER_FEATURES[i] != NULL; i++)
    json_builder_add_string_value (builder, RENDERER_FEATURES[i]);
  json_builder_end_array (builder);
  WPEView *view = webkit_web_view_get_wpe_view (host->view);
  if (view != NULL && wpe_view_get_width (view) > 0) {
    json_builder_set_member_name (builder, "display");
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "connected");
    json_builder_add_boolean_value (builder, TRUE);
    json_builder_set_member_name (builder, "width");
    json_builder_add_int_value (builder, wpe_view_get_width (view));
    json_builder_set_member_name (builder, "height");
    json_builder_add_int_value (builder, wpe_view_get_height (view));
    json_builder_end_object (builder);
  }
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.ready", json_builder_get_root (builder));
}

void
tc_protocol_send_health (TcHost *host, const char *state, const char *reason)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "state");
  json_builder_add_string_value (builder, state);
  if (reason != NULL) {
    json_builder_set_member_name (builder, "reasonCode");
    json_builder_add_string_value (builder, reason);
  }
  json_builder_set_member_name (builder, "webProcessTerminations");
  json_builder_add_int_value (builder, host->web_process_terminations);
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.health", json_builder_get_root (builder));
}

/* Parses a content list, rejecting any entry that is not a capability URI. */
static GPtrArray *
parse_content (JsonObject *data, const char *member, gboolean *ok)
{
  GPtrArray *refs = g_ptr_array_new_with_free_func (tc_content_ref_free);
  *ok = TRUE;
  if (!json_object_has_member (data, member))
    return refs;
  JsonArray *array = json_object_get_array_member (data, member);
  if (array == NULL || json_array_get_length (array) > TC_MAX_CONTENT_REFS) {
    *ok = FALSE;
    return refs;
  }
  for (guint i = 0; i < json_array_get_length (array); i++) {
    JsonObject *entry = json_array_get_object_element (array, i);
    const char *uri = entry ? json_object_get_string_member_with_default (entry, "uri", NULL) : NULL;
    const char *mime = entry ? json_object_get_string_member_with_default (entry, "mimeType", NULL) : NULL;
    gint64 size = entry ? json_object_get_int_member_with_default (entry, "sizeBytes", -1) : -1;
    if (!tc_is_media_capability_uri (uri) || mime == NULL || size < 0) {
      *ok = FALSE;
      return refs;
    }
    TcContentRef *ref = g_new0 (TcContentRef, 1);
    g_strlcpy (ref->uri, uri, sizeof ref->uri);
    ref->size_bytes = (guint64) size;
    ref->mime_type = g_strdup (mime);
    g_ptr_array_add (refs, ref);
  }
  return refs;
}

static void
rebuild_allowed_content (TcHost *host, GPtrArray *activation_content)
{
  g_ptr_array_set_size (host->content, 0);
  for (guint i = 0; i < activation_content->len; i++) {
    TcContentRef *source = g_ptr_array_index (activation_content, i);
    TcContentRef *copy = g_new0 (TcContentRef, 1);
    *copy = *source;
    copy->mime_type = g_strdup (source->mime_type);
    g_ptr_array_add (host->content, copy);
  }
  for (guint i = 0; i < host->plugin_content->len; i++) {
    TcContentRef *source = g_ptr_array_index (host->plugin_content, i);
    TcContentRef *copy = g_new0 (TcContentRef, 1);
    *copy = *source;
    copy->mime_type = g_strdup (source->mime_type);
    g_ptr_array_add (host->content, copy);
  }
}

static char *
node_to_json (JsonNode *node)
{
  return json_to_string (node, FALSE);
}

static void
handle_configure (TcHost *host, JsonObject *data)
{
  JsonObject *channel = json_object_get_object_member (data, "mediaChannel");
  const char *protocol = channel ? json_object_get_string_member_with_default (channel, "protocol", "") : "";
  const char *socket = channel ? json_object_get_string_member_with_default (channel, "socket", NULL) : NULL;
  if (g_strcmp0 (protocol, "daemon-cap-v1") != 0 || !tc_is_clean_absolute_path (socket)) {
    g_warning ("protocol: ignoring renderer.configure with an unusable media channel");
    return;
  }
  if (g_strcmp0 (socket, host->media_socket) != 0) {
    g_warning ("protocol: daemon media socket differs from --media-socket; media disabled");
    tc_protocol_send_health (host, "degraded", "media_socket_mismatch");
    return;
  }
}

static void
handle_activate (TcHost *host, JsonObject *data, JsonNode *data_node)
{
  const char *activation_id = json_object_get_string_member_with_default (data, "activationId", NULL);
  gint64 generation = json_object_get_int_member_with_default (data, "generation", -1);
  gboolean ok = FALSE;
  g_autoptr (GPtrArray) content = parse_content (data, "content", &ok);
  if (activation_id == NULL || generation < 0 || !ok || !json_object_has_member (data, "presentation")) {
    g_warning ("protocol: ignoring malformed presentation.activate");
    return;
  }
  rebuild_allowed_content (host, content);
  g_free (host->current_activation_id);
  host->current_activation_id = g_strdup (activation_id);
  host->current_generation = generation;
  g_free (host->current_activation_json);
  host->current_activation_json = node_to_json (data_node);
  if (host->runtime_ready)
    tc_view_deliver (host, "presentation.activate", host->current_activation_json);
}

static gboolean
content_has_uri (GPtrArray *content, const char *uri)
{
  for (guint i = 0; i < content->len; i++) {
    const TcContentRef *ref = g_ptr_array_index (content, i);
    if (strcmp (ref->uri, uri) == 0)
      return TRUE;
  }
  return FALSE;
}

/* Aliases map an asset/variant identity the reference runtime builds itself
 * (the Brand Bug logo) to a capability this plugin state grants. Anything
 * else makes the whole plugin state malformed. */
static GHashTable *
parse_aliases (JsonObject *data, GPtrArray *content, gboolean *ok)
{
  GHashTable *aliases = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, g_free);
  *ok = TRUE;
  if (!json_object_has_member (data, "aliases"))
    return aliases;
  JsonArray *array = json_object_get_array_member (data, "aliases");
  if (array == NULL || json_array_get_length (array) > TC_MAX_CONTENT_REFS) {
    *ok = FALSE;
    return aliases;
  }
  for (guint i = 0; i < json_array_get_length (array); i++) {
    JsonObject *entry = json_array_get_object_element (array, i);
    const char *asset = entry ? json_object_get_string_member_with_default (entry, "assetId", NULL) : NULL;
    const char *variant = entry ? json_object_get_string_member_with_default (entry, "variantId", NULL) : NULL;
    const char *uri = entry ? json_object_get_string_member_with_default (entry, "uri", NULL) : NULL;
    if (!tc_is_canonical_uuid (asset) || !tc_is_canonical_uuid (variant) || !tc_is_media_capability_uri (uri)
        || !content_has_uri (content, uri)) {
      *ok = FALSE;
      return aliases;
    }
    g_hash_table_replace (aliases, g_strdup_printf ("%s/%s", asset, variant), g_strdup (uri));
  }
  return aliases;
}

static void
handle_plugins (TcHost *host, JsonObject *data, JsonNode *data_node)
{
  gboolean ok = FALSE;
  GPtrArray *content = parse_content (data, "content", &ok);
  gboolean aliases_ok = FALSE;
  GHashTable *aliases = ok ? parse_aliases (data, content, &aliases_ok) : NULL;
  if (!ok || !aliases_ok) {
    g_ptr_array_unref (content);
    if (aliases != NULL)
      g_hash_table_unref (aliases);
    g_warning ("protocol: ignoring malformed plugin.state");
    return;
  }
  g_hash_table_unref (host->media_aliases);
  host->media_aliases = aliases;
  g_ptr_array_unref (host->plugin_content);
  host->plugin_content = content;
  /* Keep the activation's own content allowed alongside the new plugins. */
  g_autoptr (GPtrArray) activation = g_ptr_array_new_with_free_func (tc_content_ref_free);
  if (host->current_activation_json != NULL) {
    g_autoptr (JsonParser) parser = json_parser_new_immutable ();
    if (json_parser_load_from_data (parser, host->current_activation_json, -1, NULL)) {
      gboolean parsed = FALSE;
      g_ptr_array_unref (activation);
      activation = parse_content (json_node_get_object (json_parser_get_root (parser)), "content", &parsed);
    }
  }
  rebuild_allowed_content (host, activation);
  g_free (host->current_plugins_json);
  host->current_plugins_json = node_to_json (data_node);
  if (host->runtime_ready)
    tc_view_deliver (host, "plugin.state", host->current_plugins_json);
}

static void
send_preview_unavailable (TcHost *host, JsonObject *data)
{
  const char *request_id = json_object_get_string_member_with_default (data, "requestId", NULL);
  if (request_id == NULL)
    return;
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "requestId");
  json_builder_add_string_value (builder, request_id);
  json_builder_set_member_name (builder, "result");
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "outcome");
  json_builder_add_string_value (builder, "unavailable");
  json_builder_set_member_name (builder, "code");
  json_builder_add_string_value (builder, "preview_not_implemented");
  json_builder_end_object (builder);
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.preview", json_builder_get_root (builder));
}

static void
handle_event (TcHost *host, const char *name, JsonNode *data_node)
{
  if (data_node == NULL || !JSON_NODE_HOLDS_OBJECT (data_node))
    return;
  JsonObject *data = json_node_get_object (data_node);
  if (g_strcmp0 (name, "renderer.configure") == 0) {
    handle_configure (host, data);
  } else if (g_strcmp0 (name, "presentation.activate") == 0) {
    handle_activate (host, data, data_node);
  } else if (g_strcmp0 (name, "plugin.state") == 0) {
    handle_plugins (host, data, data_node);
  } else if (g_strcmp0 (name, "presentation.clear") == 0 || g_strcmp0 (name, "presentation.identify") == 0
             || g_strcmp0 (name, "renderer.command") == 0 || g_strcmp0 (name, "sync.position") == 0) {
    if (g_strcmp0 (name, "renderer.command") == 0
        && g_strcmp0 (json_object_get_string_member_with_default (data, "command", ""), "reload") == 0) {
      tc_view_reload_runtime (host);
      return;
    }
    if (host->runtime_ready) {
      g_autofree char *json = node_to_json (data_node);
      tc_view_deliver (host, name, json);
    }
  } else if (g_strcmp0 (name, "preview.request") == 0) {
    send_preview_unavailable (host, data);
  } else if (g_strcmp0 (name, "renderer.shutdown") == 0) {
    g_message ("protocol: tilecastd requested renderer shutdown (%s)",
               json_object_get_string_member_with_default (data, "reason", "unspecified"));
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_end_object (builder);
    tc_ipc_send_event (host, "renderer.shutdown_ack", json_builder_get_root (builder));
    /* Exit non-zero so Restart=always brings up a fresh renderer. */
    host->exit_code = 3;
    g_main_loop_quit (host->loop);
  }
}

void
tc_protocol_handle_frame (TcHost *host, JsonObject *frame)
{
  const char *type = json_object_get_string_member_with_default (frame, "type", "");
  if (g_strcmp0 (type, "event") == 0) {
    const char *name = json_object_get_string_member_with_default (frame, "event", "");
    handle_event (host, name, json_object_get_member (frame, "data"));
  } else if (g_strcmp0 (type, "response") == 0) {
    const char *id = json_object_get_string_member_with_default (frame, "id", NULL);
    if (id == NULL)
      return;
    if (json_object_has_member (frame, "result")) {
      g_autofree char *result = node_to_json (json_object_get_member (frame, "result"));
      tc_view_resolve_reply (host, id, result, NULL);
    } else {
      JsonObject *error = json_object_get_object_member (frame, "error");
      tc_view_resolve_reply (host, id, NULL,
                             error ? json_object_get_string_member_with_default (error, "message", "error") : "error");
    }
  }
}
