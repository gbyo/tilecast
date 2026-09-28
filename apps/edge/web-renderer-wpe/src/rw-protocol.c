#include "rw-protocol.h"

#include <string.h>

/* ---------------------------------------------------------- primitives */

gboolean
tc_rw_is_surface_id (const char *value)
{
  if (value == NULL)
    return FALSE;
  gsize length = strlen (value);
  if (length == 0 || length > 48)
    return FALSE;
  for (const char *c = value; *c; c++) {
    if (!((*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-'))
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_rw_is_capability (const char *value)
{
  if (value == NULL || strlen (value) != TC_RW_CAPABILITY_HEX)
    return FALSE;
  for (const char *c = value; *c; c++) {
    if (!((*c >= 'a' && *c <= 'f') || (*c >= '0' && *c <= '9')))
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_rw_is_youtube_id (const char *value)
{
  if (value == NULL)
    return FALSE;
  gsize length = strlen (value);
  if (length < 6 || length > 128)
    return FALSE;
  for (const char *c = value; *c; c++) {
    if (!(g_ascii_isalnum (*c) || *c == '_' || *c == '-'))
      return FALSE;
  }
  return TRUE;
}

/* ^[A-Za-z]{2,3}(-[A-Za-z]{2})?$, the server's caption language rule. */
gboolean
tc_rw_is_language_code (const char *value)
{
  if (value == NULL)
    return FALSE;
  gsize length = strlen (value);
  gsize letters = 0;
  while (letters < length && g_ascii_isalpha (value[letters]))
    letters++;
  if (letters < 2 || letters > 3)
    return FALSE;
  if (letters == length)
    return TRUE;
  return length == letters + 3 && value[letters] == '-' && g_ascii_isalpha (value[letters + 1])
         && g_ascii_isalpha (value[letters + 2]);
}

gboolean
tc_rw_is_color (const char *value)
{
  if (value == NULL || value[0] != '#')
    return FALSE;
  gsize length = strlen (value);
  if (length != 7 && length != 9)
    return FALSE;
  for (gsize i = 1; i < length; i++) {
    if (!g_ascii_isxdigit (value[i]))
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_rw_is_printable_ascii (const char *value, gsize max)
{
  if (value == NULL || strlen (value) > max)
    return FALSE;
  for (const char *c = value; *c; c++) {
    if (*c < 0x20 || *c > 0x7e)
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_rw_normalize_host (const char *value, char out[TC_RW_MAX_HOST + 1])
{
  if (value == NULL)
    return FALSE;
  gsize length = strlen (value);
  if (length > 0 && value[length - 1] == '.')
    length--;
  if (length == 0 || length > TC_RW_MAX_HOST)
    return FALSE;
  for (gsize i = 0; i < length; i++) {
    char c = g_ascii_tolower (value[i]);
    /* DNS names and IPv4 literals; IPv6 literals are not allowlist entries. */
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.'))
      return FALSE;
    out[i] = c;
  }
  out[length] = '\0';
  return TRUE;
}

/* ---------------------------------------------------------- JSON helpers */

/* Every member of `object` is in `allowed`, and every one of `required` is
 * present. */
static gboolean
members_are (JsonObject *object, const char *const *allowed, const char *const *required)
{
  g_autoptr (GList) names = json_object_get_members (object);
  for (GList *name = names; name != NULL; name = name->next) {
    gboolean known = FALSE;
    for (guint i = 0; allowed[i] != NULL; i++) {
      if (strcmp (name->data, allowed[i]) == 0) {
        known = TRUE;
        break;
      }
    }
    if (!known)
      return FALSE;
  }
  for (guint i = 0; required[i] != NULL; i++) {
    if (!json_object_has_member (object, required[i]))
      return FALSE;
  }
  return TRUE;
}

static gboolean
get_string (JsonObject *object, const char *name, const char **out)
{
  JsonNode *node = json_object_get_member (object, name);
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node) || json_node_get_value_type (node) != G_TYPE_STRING)
    return FALSE;
  *out = json_node_get_string (node);
  return g_utf8_validate (*out, -1, NULL);
}

static gboolean
get_bool (JsonObject *object, const char *name, gboolean *out)
{
  JsonNode *node = json_object_get_member (object, name);
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node) || json_node_get_value_type (node) != G_TYPE_BOOLEAN)
    return FALSE;
  *out = json_node_get_boolean (node);
  return TRUE;
}

static gboolean
get_uint (JsonObject *object, const char *name, guint min, guint max, guint *out)
{
  JsonNode *node = json_object_get_member (object, name);
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node) || json_node_get_value_type (node) != G_TYPE_INT64)
    return FALSE;
  gint64 value = json_node_get_int (node);
  if (value < (gint64) min || value > (gint64) max)
    return FALSE;
  *out = (guint) value;
  return TRUE;
}

static gboolean
is_null (JsonObject *object, const char *name)
{
  JsonNode *node = json_object_get_member (object, name);
  return node != NULL && JSON_NODE_HOLDS_NULL (node);
}

static gboolean
copy_token (JsonObject *object, const char *name, gboolean (*check) (const char *), char *out, gsize size)
{
  const char *value = NULL;
  if (!get_string (object, name, &value) || !check (value) || strlen (value) >= size)
    return FALSE;
  g_strlcpy (out, value, size);
  return TRUE;
}

static gboolean
is_request_id (const char *value)
{
  return tc_rw_is_surface_id (value);
}

/* ---------------------------------------------------------- URL shape */

/* The create URL: http or https, a host, no user information, at most
 * TC_RW_MAX_URL bytes, printable ASCII (IRIs arrive percent-encoded). */
static gboolean
valid_url (const char *url)
{
  if (!tc_rw_is_printable_ascii (url, TC_RW_MAX_URL) || strchr (url, ' ') != NULL)
    return FALSE;
  g_autoptr (GUri) uri = g_uri_parse (url, G_URI_FLAGS_ENCODED | G_URI_FLAGS_PARSE_RELAXED, NULL);
  if (uri == NULL)
    return FALSE;
  const char *scheme = g_uri_get_scheme (uri);
  if (g_strcmp0 (scheme, "https") != 0 && g_strcmp0 (scheme, "http") != 0)
    return FALSE;
  const char *host = g_uri_get_host (uri);
  return host != NULL && *host != '\0' && g_uri_get_userinfo (uri) == NULL;
}

/* ---------------------------------------------------------- create */

void
tc_rw_create_clear (TcRwCreate *create)
{
  g_clear_pointer (&create->url, g_free);
  g_clear_pointer (&create->allowed_hosts, g_ptr_array_unref);
  g_clear_pointer (&create->user_agent, g_free);
}

static gboolean
parse_page (JsonObject *content, TcRwCreate *out)
{
  static const char *const allowed[] = { "kind", "url", "allowedHosts", "javascriptEnabled", "domStorageEnabled",
                                         "cookiePolicy", "userAgent", "zoomPercent", "scrollX", "scrollY",
                                         "backgroundColor", NULL };
  if (!members_are (content, allowed, allowed))
    return FALSE;
  const char *url = NULL, *cookies = NULL, *user_agent = NULL, *background = NULL;
  if (!get_string (content, "url", &url) || !valid_url (url) || !get_bool (content, "javascriptEnabled", &out->javascript)
      || !get_bool (content, "domStorageEnabled", &out->dom_storage) || !get_string (content, "cookiePolicy", &cookies)
      || !get_string (content, "userAgent", &user_agent) || !tc_rw_is_printable_ascii (user_agent, TC_RW_MAX_USER_AGENT)
      || !get_uint (content, "zoomPercent", 25, 500, &out->zoom_percent)
      || !get_uint (content, "scrollX", 0, TC_RW_MAX_SCROLL, &out->scroll_x)
      || !get_uint (content, "scrollY", 0, TC_RW_MAX_SCROLL, &out->scroll_y)
      || !get_string (content, "backgroundColor", &background) || !tc_rw_is_color (background))
    return FALSE;
  if (strcmp (cookies, "disabled") == 0)
    out->cookies = TC_RW_COOKIES_DISABLED;
  else if (strcmp (cookies, "first_party") == 0)
    out->cookies = TC_RW_COOKIES_FIRST_PARTY;
  else if (strcmp (cookies, "first_and_third_party") == 0)
    out->cookies = TC_RW_COOKIES_ALL;
  else
    return FALSE;
  JsonNode *hosts_node = json_object_get_member (content, "allowedHosts");
  if (!JSON_NODE_HOLDS_ARRAY (hosts_node))
    return FALSE;
  JsonArray *hosts = json_node_get_array (hosts_node);
  guint count = json_array_get_length (hosts);
  if (count == 0 || count > TC_RW_MAX_HOSTS)
    return FALSE;
  out->allowed_hosts = g_ptr_array_new_with_free_func (g_free);
  for (guint i = 0; i < count; i++) {
    JsonNode *entry = json_array_get_element (hosts, i);
    char host[TC_RW_MAX_HOST + 1];
    if (!JSON_NODE_HOLDS_VALUE (entry) || json_node_get_value_type (entry) != G_TYPE_STRING
        || !tc_rw_normalize_host (json_node_get_string (entry), host))
      return FALSE;
    g_ptr_array_add (out->allowed_hosts, g_strdup (host));
  }
  out->url = g_strdup (url);
  out->user_agent = g_strdup (user_agent);
  g_strlcpy (out->background, background, sizeof out->background);
  out->kind = TC_RW_CONTENT_PAGE;
  return TRUE;
}

static gboolean
parse_youtube (JsonObject *content, TcRwCreate *out)
{
  static const char *const allowed[] = { "kind",     "videoId", "playlistId",      "startSeconds", "endSeconds",
                                         "loop",     "muted",   "volume",          "captions",     "captionLanguage",
                                         "controls", NULL };
  if (!members_are (content, allowed, allowed))
    return FALSE;
  gboolean video = !is_null (content, "videoId");
  gboolean playlist = !is_null (content, "playlistId");
  if (video == playlist)
    return FALSE;
  if (video && !copy_token (content, "videoId", tc_rw_is_youtube_id, out->video_id, sizeof out->video_id))
    return FALSE;
  if (playlist && !copy_token (content, "playlistId", tc_rw_is_youtube_id, out->playlist_id, sizeof out->playlist_id))
    return FALSE;
  const char *language = NULL;
  if (!get_uint (content, "startSeconds", 0, 86400, &out->start_seconds) || !get_bool (content, "loop", &out->loop)
      || !get_bool (content, "muted", &out->author_muted) || !get_uint (content, "volume", 0, 100, &out->volume)
      || !get_bool (content, "captions", &out->captions) || !get_bool (content, "controls", &out->controls)
      || !get_string (content, "captionLanguage", &language)
      || (*language != '\0' && !tc_rw_is_language_code (language)))
    return FALSE;
  g_strlcpy (out->caption_language, language, sizeof out->caption_language);
  out->end_seconds = -1;
  if (!is_null (content, "endSeconds")) {
    guint end = 0;
    if (!get_uint (content, "endSeconds", 1, 86400 * 2, &end) || end <= out->start_seconds)
      return FALSE;
    out->end_seconds = (gint) end;
  }
  out->kind = TC_RW_CONTENT_YOUTUBE;
  return TRUE;
}

static gboolean
parse_create (JsonObject *object, TcRwCreate *out)
{
  static const char *const allowed[] = { "type", "surfaceId", "width", "height", "muted", "visible", "content", NULL };
  if (!members_are (object, allowed, allowed))
    return FALSE;
  if (!copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
      || !get_uint (object, "width", TC_RW_MIN_EDGE, TC_RW_MAX_EDGE, &out->width)
      || !get_uint (object, "height", TC_RW_MIN_EDGE, TC_RW_MAX_EDGE, &out->height)
      || (guint64) out->width * out->height > TC_RW_MAX_PIXELS || !get_bool (object, "muted", &out->muted)
      || !get_bool (object, "visible", &out->visible))
    return FALSE;
  JsonNode *content_node = json_object_get_member (object, "content");
  if (!JSON_NODE_HOLDS_OBJECT (content_node))
    return FALSE;
  JsonObject *content = json_node_get_object (content_node);
  const char *kind = NULL;
  if (!get_string (content, "kind", &kind))
    return FALSE;
  if (strcmp (kind, "page") == 0)
    return parse_page (content, out);
  if (strcmp (kind, "youtube") == 0)
    return parse_youtube (content, out);
  return FALSE;
}

/* ---------------------------------------------------------- requests */

gboolean
tc_rw_parse_request (JsonObject *object, TcRwRequest *out, const char **reason)
{
  memset (out, 0, sizeof *out);
  out->create.end_seconds = -1;
  const char *type = NULL;
  *reason = "invalid_request";
  if (object == NULL || !get_string (object, "type", &type))
    return FALSE;
  static const char *const hello[] = { "type", "version", NULL };
  static const char *const surface_only[] = { "type", "surfaceId", NULL };
  static const char *const resize[] = { "type", "surfaceId", "width", "height", NULL };
  static const char *const visible[] = { "type", "surfaceId", "visible", NULL };
  static const char *const mute[] = { "type", "surfaceId", "muted", NULL };
  static const char *const clear[] = { "type", "requestId", NULL };
  gboolean ok = FALSE;
  if (strcmp (type, "hello") == 0) {
    out->type = TC_RW_REQ_HELLO;
    ok = members_are (object, hello, hello) && get_uint (object, "version", 1, 65535, &out->version);
  } else if (strcmp (type, "create") == 0) {
    out->type = TC_RW_REQ_CREATE;
    ok = parse_create (object, &out->create);
    if (ok)
      g_strlcpy (out->surface_id, out->create.surface_id, sizeof out->surface_id);
    else
      tc_rw_create_clear (&out->create);
  } else if (strcmp (type, "resize") == 0) {
    out->type = TC_RW_REQ_RESIZE;
    ok = members_are (object, resize, resize)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && get_uint (object, "width", TC_RW_MIN_EDGE, TC_RW_MAX_EDGE, &out->width)
         && get_uint (object, "height", TC_RW_MIN_EDGE, TC_RW_MAX_EDGE, &out->height)
         && (guint64) out->width * out->height <= TC_RW_MAX_PIXELS;
  } else if (strcmp (type, "visible") == 0) {
    out->type = TC_RW_REQ_VISIBLE;
    ok = members_are (object, visible, visible)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && get_bool (object, "visible", &out->flag);
  } else if (strcmp (type, "mute") == 0) {
    out->type = TC_RW_REQ_MUTE;
    ok = members_are (object, mute, mute)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && get_bool (object, "muted", &out->flag);
  } else if (strcmp (type, "reload") == 0 || strcmp (type, "destroy") == 0) {
    out->type = type[0] == 'r' ? TC_RW_REQ_RELOAD : TC_RW_REQ_DESTROY;
    ok = members_are (object, surface_only, surface_only)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id);
  } else if (strcmp (type, "clear-data") == 0) {
    out->type = TC_RW_REQ_CLEAR_DATA;
    ok = members_are (object, clear, clear)
         && copy_token (object, "requestId", is_request_id, out->request_id, sizeof out->request_id);
  } else {
    *reason = "unknown_request";
  }
  if (!ok)
    out->type = TC_RW_REQ_INVALID;
  return ok;
}

/* ---------------------------------------------------------- events */

static const char *const EVENT_NAMES[] = {
  [TC_RW_EVENT_STREAM_READY] = "stream-ready",
  [TC_RW_EVENT_LOADED] = "loaded",
  [TC_RW_EVENT_NAVIGATION_BLOCKED] = "navigation-blocked",
  [TC_RW_EVENT_FAILED] = "failed",
  [TC_RW_EVENT_PROCESS_TERMINATED] = "process-terminated",
  [TC_RW_EVENT_MEDIA_ENDED] = "media-ended",
};

const char *
tc_rw_event_kind_name (TcRwEventKind kind)
{
  return EVENT_NAMES[kind];
}

gboolean
tc_rw_event_kind_parse (const char *name, TcRwEventKind *kind)
{
  for (guint i = 0; i < G_N_ELEMENTS (EVENT_NAMES); i++) {
    if (g_strcmp0 (name, EVENT_NAMES[i]) == 0) {
      *kind = (TcRwEventKind) i;
      return TRUE;
    }
  }
  return FALSE;
}

static const char *const FAILURE_CODES[] = {
  "unavailable", "limit_exceeded",  "invalid_request", "load_failed",   "http_error",     "tls_failure",
  "offline",     "blocked_navigation", "renderer_crash", "helper_terminated", "youtube_error", "stream_failed",
  "unsupported_content", NULL,
};

gboolean
tc_rw_is_failure_code (const char *code)
{
  for (guint i = 0; FAILURE_CODES[i] != NULL; i++) {
    if (g_strcmp0 (code, FAILURE_CODES[i]) == 0)
      return TRUE;
  }
  return FALSE;
}

/* ---------------------------------------------------------- messages */

gboolean
tc_rw_parse_message (JsonObject *object, TcRwMessage *out, const char **reason)
{
  memset (out, 0, sizeof *out);
  *reason = "invalid_message";
  const char *type = NULL;
  if (object == NULL || !get_string (object, "type", &type))
    return FALSE;
  static const char *const welcome[] = { "type", "version", "accelerated", NULL };
  static const char *const created[] = { "type", "surfaceId", "capability", NULL };
  static const char *const rejected[] = { "type", "surfaceId", "code", NULL };
  static const char *const event_all[] = { "type", "surfaceId", "kind", "code", NULL };
  static const char *const event_required[] = { "type", "surfaceId", "kind", NULL };
  static const char *const cleared[] = { "type", "requestId", "ok", NULL };
  gboolean ok = FALSE;
  if (strcmp (type, "welcome") == 0) {
    out->type = TC_RW_MSG_WELCOME;
    ok = members_are (object, welcome, welcome) && get_uint (object, "version", 1, 65535, &out->version)
         && get_bool (object, "accelerated", &out->accelerated);
  } else if (strcmp (type, "created") == 0) {
    out->type = TC_RW_MSG_CREATED;
    ok = members_are (object, created, created)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && copy_token (object, "capability", tc_rw_is_capability, out->capability, sizeof out->capability);
  } else if (strcmp (type, "rejected") == 0) {
    out->type = TC_RW_MSG_REJECTED;
    ok = members_are (object, rejected, rejected)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && copy_token (object, "code", tc_rw_is_failure_code, out->code, sizeof out->code);
  } else if (strcmp (type, "event") == 0) {
    out->type = TC_RW_MSG_EVENT;
    const char *kind = NULL;
    ok = members_are (object, event_all, event_required)
         && copy_token (object, "surfaceId", tc_rw_is_surface_id, out->surface_id, sizeof out->surface_id)
         && get_string (object, "kind", &kind) && tc_rw_event_kind_parse (kind, &out->event)
         && (!json_object_has_member (object, "code")
             || copy_token (object, "code", tc_rw_is_failure_code, out->code, sizeof out->code));
  } else if (strcmp (type, "cleared") == 0) {
    out->type = TC_RW_MSG_CLEARED;
    ok = members_are (object, cleared, cleared)
         && copy_token (object, "requestId", is_request_id, out->request_id, sizeof out->request_id)
         && get_bool (object, "ok", &out->ok);
  }
  if (!ok)
    out->type = TC_RW_MSG_INVALID;
  return ok;
}

static char *
finish (JsonBuilder *builder)
{
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  return json_to_string (root, FALSE);
}

static JsonBuilder *
begin (const char *type)
{
  JsonBuilder *builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, type);
  return builder;
}

static void
add_string (JsonBuilder *builder, const char *name, const char *value)
{
  json_builder_set_member_name (builder, name);
  json_builder_add_string_value (builder, value);
}

char *
tc_rw_build_welcome (gboolean accelerated)
{
  g_autoptr (JsonBuilder) builder = begin ("welcome");
  json_builder_set_member_name (builder, "version");
  json_builder_add_int_value (builder, TC_RW_PROTOCOL_VERSION);
  json_builder_set_member_name (builder, "accelerated");
  json_builder_add_boolean_value (builder, accelerated);
  return finish (builder);
}

char *
tc_rw_build_created (const char *surface_id, const char *capability)
{
  g_autoptr (JsonBuilder) builder = begin ("created");
  add_string (builder, "surfaceId", surface_id);
  add_string (builder, "capability", capability);
  return finish (builder);
}

char *
tc_rw_build_rejected (const char *surface_id, const char *code)
{
  g_autoptr (JsonBuilder) builder = begin ("rejected");
  add_string (builder, "surfaceId", surface_id);
  add_string (builder, "code", code);
  return finish (builder);
}

char *
tc_rw_build_event (const char *surface_id, TcRwEventKind kind, const char *code)
{
  g_autoptr (JsonBuilder) builder = begin ("event");
  add_string (builder, "surfaceId", surface_id);
  add_string (builder, "kind", tc_rw_event_kind_name (kind));
  if (code != NULL)
    add_string (builder, "code", code);
  return finish (builder);
}

char *
tc_rw_build_cleared (const char *request_id, gboolean ok)
{
  g_autoptr (JsonBuilder) builder = begin ("cleared");
  add_string (builder, "requestId", request_id);
  json_builder_set_member_name (builder, "ok");
  json_builder_add_boolean_value (builder, ok);
  return finish (builder);
}
