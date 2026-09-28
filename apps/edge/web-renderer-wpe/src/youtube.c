/*
 * The Tilecast-owned YouTube wrapper (threat review §12).
 *
 * The wrapper is loaded with the fixed base URI TC_YOUTUBE_BASE_URI, so the
 * embed request carries the HTTPS reverse-DNS Referer YouTube requires. It
 * creates the privacy-enhanced embed iframe with documented parameters only
 * and attaches the IFrame Player API to it. Its state is one token in an
 * attribute of its own document, read by the helper from a private script
 * world; it has no message handler and no way to call the helper.
 *
 * The configuration arrives as a JSON document whose values were validated
 * as tokens, integers and booleans (rw-protocol.c); nothing is built into
 * script source.
 */
#include "helper.h"

#include <string.h>

static const char TEMPLATE_HEAD[] =
  "<!doctype html><html data-tc-state=\"loading\"><head><meta charset=\"utf-8\">"
  "<meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">"
  "<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}"
  "iframe{border:0;width:100%;height:100%;display:block}</style></head><body>"
  "<script type=\"application/json\" id=\"tc-config\">";

static const char TEMPLATE_TAIL[] =
  "</script><script>\n"
  "(function () {\n"
  "  var root = document.documentElement;\n"
  "  var config = JSON.parse(document.getElementById('tc-config').textContent);\n"
  "  var origin = 'https://org.tilecast.player';\n"
  "  var state = function (value) { root.setAttribute('data-tc-state', value); };\n"
  "  var p = new URLSearchParams();\n"
  "  p.set('enablejsapi', '1'); p.set('origin', origin); p.set('autoplay', '0');\n"
  "  p.set('playsinline', '1'); p.set('controls', config.controls ? '1' : '0');\n"
  "  p.set('rel', '0'); p.set('disablekb', '1'); p.set('fs', '0');\n"
  "  p.set('cc_load_policy', config.captions ? '1' : '0');\n"
  "  if (config.captions && config.captionLanguage) p.set('cc_lang_pref', config.captionLanguage);\n"
  "  if (config.startSeconds > 0) p.set('start', String(config.startSeconds));\n"
  "  if (config.endSeconds !== null) p.set('end', String(config.endSeconds));\n"
  "  var src;\n"
  "  if (config.playlistId) {\n"
  "    p.set('listType', 'playlist'); p.set('list', config.playlistId);\n"
  "    if (config.loop) p.set('loop', '1');\n"
  "    src = 'https://www.youtube-nocookie.com/embed?' + p.toString();\n"
  "  } else {\n"
  "    if (config.loop) { p.set('loop', '1'); p.set('playlist', config.videoId); }\n"
  "    src = 'https://www.youtube-nocookie.com/embed/' + config.videoId + '?' + p.toString();\n"
  "  }\n"
  "  var frame = document.createElement('iframe');\n"
  "  frame.id = 'tc-player'; frame.allow = 'autoplay; encrypted-media'; frame.src = src;\n"
  "  document.body.appendChild(frame);\n"
  "  var player = null, ready = false;\n"
  "  var apply = function () {\n"
  "    if (!ready) return;\n"
  "    if (root.getAttribute('data-tc-command') === 'play') player.playVideo(); else player.pauseVideo();\n"
  "  };\n"
  "  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-tc-command'] });\n"
  "  window.onYouTubeIframeAPIReady = function () {\n"
  "    player = new YT.Player('tc-player', { events: {\n"
  "      onReady: function (e) {\n"
  "        if (config.muted) e.target.mute(); else { e.target.unMute(); e.target.setVolume(config.volume); }\n"
  "        ready = true; state('ready'); apply();\n"
  "      },\n"
  "      onStateChange: function (e) {\n"
  "        var names = { '0': 'ended', '1': 'playing', '2': 'paused', '3': 'buffering', '5': 'ready' };\n"
  "        if (names[String(e.data)]) state(names[String(e.data)]);\n"
  "      },\n"
  "      onError: function (e) { state('error:' + (Number(e.data) | 0)); }\n"
  "    } });\n"
  "  };\n"
  "  var api = document.createElement('script');\n"
  "  api.src = 'https://www.youtube.com/iframe_api';\n"
  "  document.body.appendChild(api);\n"
  "})();\n"
  "</script></body></html>";

char *
tc_youtube_wrapper (const TcRwCreate *create)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "videoId");
  if (create->video_id[0] != '\0')
    json_builder_add_string_value (builder, create->video_id);
  else
    json_builder_add_null_value (builder);
  json_builder_set_member_name (builder, "playlistId");
  if (create->playlist_id[0] != '\0')
    json_builder_add_string_value (builder, create->playlist_id);
  else
    json_builder_add_null_value (builder);
  json_builder_set_member_name (builder, "startSeconds");
  json_builder_add_int_value (builder, create->start_seconds);
  json_builder_set_member_name (builder, "endSeconds");
  if (create->end_seconds >= 0)
    json_builder_add_int_value (builder, create->end_seconds);
  else
    json_builder_add_null_value (builder);
  json_builder_set_member_name (builder, "loop");
  json_builder_add_boolean_value (builder, create->loop);
  json_builder_set_member_name (builder, "muted");
  json_builder_add_boolean_value (builder, create->author_muted);
  json_builder_set_member_name (builder, "volume");
  json_builder_add_int_value (builder, create->volume);
  json_builder_set_member_name (builder, "captions");
  json_builder_add_boolean_value (builder, create->captions);
  json_builder_set_member_name (builder, "captionLanguage");
  json_builder_add_string_value (builder, create->caption_language);
  json_builder_set_member_name (builder, "controls");
  json_builder_add_boolean_value (builder, create->controls);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  g_autofree char *config = json_to_string (root, FALSE);
  /* Validated tokens cannot contain '<'; refuse rather than escape. */
  g_return_val_if_fail (strchr (config, '<') == NULL, NULL);
  return g_strconcat (TEMPLATE_HEAD, config, TEMPLATE_TAIL, NULL);
}

gboolean
tc_youtube_subframe_allowed (const char *uri)
{
  if (g_strcmp0 (uri, "about:blank") == 0)
    return TRUE;
  g_autoptr (GUri) parsed = uri ? g_uri_parse (uri, G_URI_FLAGS_ENCODED, NULL) : NULL;
  if (parsed == NULL || g_strcmp0 (g_uri_get_scheme (parsed), "https") != 0 || g_uri_get_port (parsed) != -1
      || g_uri_get_userinfo (parsed) != NULL)
    return FALSE;
  const char *host = g_uri_get_host (parsed);
  return g_strcmp0 (host, "www.youtube-nocookie.com") == 0 || g_strcmp0 (host, "www.youtube.com") == 0;
}
