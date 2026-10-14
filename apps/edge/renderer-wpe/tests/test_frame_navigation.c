/* Real-engine document filtering. The scheme counters prove refusal before
 * another Runtime or capability document is served, including shared frames. */
#include "frame-navigation.h"

#include <libsoup/soup.h>
#include <string.h>
#include <wpe/headless/wpe-headless.h>

typedef struct {
  GMainLoop *loop;
  guint runtime_reads;
  guint frame_reads;
  gboolean finished;
} Probe;

static void
serve (WebKitURISchemeRequest *request, const char *html, gboolean sandbox)
{
  gsize length = strlen (html);
  g_autoptr (GInputStream) stream = g_memory_input_stream_new_from_data (g_strdup (html), length, g_free);
  g_autoptr (WebKitURISchemeResponse) response = webkit_uri_scheme_response_new (stream, length);
  webkit_uri_scheme_response_set_content_type (response, "text/html");
  webkit_uri_scheme_response_set_status (response, 200, NULL);
  SoupMessageHeaders *headers = soup_message_headers_new (SOUP_MESSAGE_HEADERS_RESPONSE);
  if (sandbox)
    soup_message_headers_append (headers, "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'");
  webkit_uri_scheme_response_set_http_headers (response, headers);
  webkit_uri_scheme_request_finish_with_response (request, response);
}

static void
runtime (WebKitURISchemeRequest *request, gpointer data)
{
  Probe *probe = data;
  probe->runtime_reads++;
  if (probe->runtime_reads > 1) {
    serve (request, "<!doctype html>unexpected Runtime navigation", FALSE);
    return;
  }
  serve (request,
    "<!doctype html><script>"
    "var n=0;addEventListener('message',function(e){if(e.data==='ready'&&++n===4)"
    "setTimeout(function(){webkit.messageHandlers.probe.postMessage('done')},1500)});"
    "['a','a','b','c'].forEach(function(id){var f=document.createElement('iframe');"
    "f.sandbox='allow-scripts';f.src='tcwidget://cap/'+id.repeat(64);"
    "document.documentElement.appendChild(f)});</script>", FALSE);
}

static void
frame (WebKitURISchemeRequest *request, gpointer data)
{
  Probe *probe = data;
  probe->frame_reads++;
  if (probe->frame_reads > 4) {
    serve (request, "<!doctype html>unexpected frame navigation", TRUE);
    return;
  }
  const char *uri = webkit_uri_scheme_request_get_uri (request);
  const char *action = strstr (uri, "/aaaa") ? "location.href='tilecast://runtime/index.html'"
    : strstr (uri, "/bbbb") ? "location.reload()"
    : "location.href='tcwidget://cap/'+'a'.repeat(64)";
  g_autofree char *html = g_strdup_printf (
    "<!doctype html><script>parent.postMessage('ready','*');setTimeout(function(){%s},200)</script>", action);
  serve (request, html, TRUE);
}

static void
done (WebKitUserContentManager *manager, JSCValue *value, gpointer data)
{
  (void) manager;
  Probe *probe = data;
  g_autofree char *text = jsc_value_to_string (value);
  probe->finished = g_strcmp0 (text, "done") == 0;
  g_main_loop_quit (probe->loop);
}

static gboolean
timeout (gpointer data)
{
  g_main_loop_quit (((Probe *) data)->loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  g_autoptr (GError) error = NULL;
  Probe probe = { .loop = g_main_loop_new (NULL, FALSE) };
  g_autoptr (WPEDisplay) display = wpe_display_headless_new ();
  if (!wpe_display_connect (display, &error))
    g_error ("headless display: %s", error->message);
  wpe_display_set_primary (display);
  g_autoptr (WebKitWebContext) context = webkit_web_context_new ();
  WebKitSecurityManager *security = webkit_web_context_get_security_manager (context);
  webkit_security_manager_register_uri_scheme_as_secure (security, "tilecast");
  webkit_security_manager_register_uri_scheme_as_secure (security, "tcwidget");
  webkit_web_context_register_uri_scheme (context, "tilecast", runtime, &probe, NULL);
  webkit_web_context_register_uri_scheme (context, "tcwidget", frame, &probe, NULL);
  g_autoptr (WebKitUserContentManager) manager = webkit_user_content_manager_new ();
  gboolean filter = !(argc == 2 && g_strcmp0 (argv[1], "--without-filter") == 0);
  if (filter && !tc_frame_navigation_install (manager, &error))
    g_error ("frame filter: %s", error->message);
  g_signal_connect (manager, "script-message-received::probe", G_CALLBACK (done), &probe);
  if (!webkit_user_content_manager_register_script_message_handler (manager, "probe", NULL))
    return 1;
  WebKitWebView *view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", display, "web-context", context,
    "user-content-manager", manager, NULL);
  g_object_ref_sink (view);
  guint timer = g_timeout_add_seconds (15, timeout, &probe);
  webkit_web_view_load_uri (view, "tilecast://runtime/index.html");
  g_main_loop_run (probe.loop);
  if (probe.finished)
    g_source_remove (timer);
  gboolean passed = probe.finished && probe.runtime_reads == 1 && probe.frame_reads == 4;
  g_print ("frame navigation: finished=%d runtime=%u frames=%u\n",
           probe.finished, probe.runtime_reads, probe.frame_reads);
  g_object_unref (view);
  g_main_loop_unref (probe.loop);
  return passed ? 0 : 1;
}
