/* The remote web protocol v1 against packages/edge-protocol/fixtures/remote-web. */
#include "rw-protocol.h"

#include <string.h>

static JsonObject *
load (const char *path, JsonParser *parser)
{
  g_autoptr (GError) error = NULL;
  if (!json_parser_load_from_file (parser, path, &error))
    g_error ("%s: %s", path, error->message);
  return json_node_get_object (json_parser_get_root (parser));
}

static void
each (const char *dir, void (*check) (const char *name, JsonObject *object))
{
  g_autofree char *path = g_build_filename (TC_RW_FIXTURE_DIR, dir, NULL);
  g_autoptr (GDir) listing = g_dir_open (path, 0, NULL);
  g_assert_nonnull (listing);
  guint count = 0;
  const char *name;
  while ((name = g_dir_read_name (listing)) != NULL) {
    g_autofree char *file = g_build_filename (path, name, NULL);
    g_autoptr (JsonParser) parser = json_parser_new ();
    check (name, load (file, parser));
    count++;
  }
  g_assert_cmpuint (count, >, 5);
}

static void
valid_request (const char *name, JsonObject *object)
{
  TcRwRequest request;
  const char *reason = NULL;
  if (!tc_rw_parse_request (object, &request, &reason))
    g_error ("valid request %s refused (%s)", name, reason);
  if (request.type == TC_RW_REQ_CREATE && request.create.kind == TC_RW_CONTENT_PAGE) {
    for (guint i = 0; i < request.create.allowed_hosts->len; i++) {
      const char *host = g_ptr_array_index (request.create.allowed_hosts, i);
      g_assert_false (g_str_has_suffix (host, "."));
    }
  }
  tc_rw_create_clear (&request.create);
}

static void
invalid_request (const char *name, JsonObject *object)
{
  TcRwRequest request;
  const char *reason = NULL;
  if (tc_rw_parse_request (object, &request, &reason))
    g_error ("invalid request %s accepted", name);
  g_assert_null (request.create.url);
  g_assert_null (request.create.allowed_hosts);
}

static void
valid_message (const char *name, JsonObject *object)
{
  TcRwMessage message;
  const char *reason = NULL;
  if (!tc_rw_parse_message (object, &message, &reason))
    g_error ("valid message %s refused", name);
}

static void
invalid_message (const char *name, JsonObject *object)
{
  TcRwMessage message;
  const char *reason = NULL;
  if (tc_rw_parse_message (object, &message, &reason))
    g_error ("invalid message %s accepted", name);
}

static void
round_trip (char *json)
{
  g_autofree char *owned = json;
  g_autoptr (JsonParser) parser = json_parser_new ();
  g_assert_true (json_parser_load_from_data (parser, json, -1, NULL));
  TcRwMessage message;
  const char *reason = NULL;
  if (!tc_rw_parse_message (json_node_get_object (json_parser_get_root (parser)), &message, &reason))
    g_error ("builder output refused: %s", json);
}

int
main (void)
{
  each ("requests/valid", valid_request);
  each ("requests/invalid", invalid_request);
  each ("messages/valid", valid_message);
  each ("messages/invalid", invalid_message);
  round_trip (tc_rw_build_welcome (TRUE));
  round_trip (tc_rw_build_created ("s-1", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"));
  round_trip (tc_rw_build_rejected ("s-1", "unavailable"));
  round_trip (tc_rw_build_event ("s-1", TC_RW_EVENT_FAILED, "renderer_crash"));
  round_trip (tc_rw_build_event ("s-1", TC_RW_EVENT_MEDIA_ENDED, NULL));
  round_trip (tc_rw_build_cleared ("c-1", FALSE));
  char host[TC_RW_MAX_HOST + 1];
  g_assert_true (tc_rw_normalize_host ("Signage.Example.ORG.", host));
  g_assert_cmpstr (host, ==, "signage.example.org");
  g_assert_false (tc_rw_normalize_host ("[::1]", host));
  g_assert_false (tc_rw_normalize_host ("", host));
  g_assert_false (tc_rw_normalize_host ("exa mple.org", host));
  g_assert_true (tc_rw_is_language_code ("pt-BR"));
  g_assert_false (tc_rw_is_language_code ("pt-BRA"));
  g_assert_false (tc_rw_is_youtube_id ("short"));
  g_print ("rw-protocol: ok\n");
  return 0;
}
