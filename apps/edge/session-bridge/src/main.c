/*
 * tilecast-session-bridge entry point. See bridge.h.
 *
 *   tilecast-session-bridge --socket=/run/tilecast-edge/edge.sock
 */
#include "bridge.h"

#include <glib-unix.h>

static gboolean
on_signal (gpointer data)
{
  TbBridge *bridge = data;
  g_main_loop_quit (bridge->loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  g_autofree char *socket_path = NULL;
  const GOptionEntry entries[] = {
    { "socket", 0, 0, G_OPTION_ARG_FILENAME, &socket_path, "tilecastd's IPC socket", "PATH" },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new ("- Tilecast Edge session bridge");
  g_option_context_add_main_entries (options, entries, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_option_context_parse (options, &argc, &argv, &error)) {
    g_printerr ("tilecast-session-bridge: %s\n", error->message);
    return 2;
  }
  if (socket_path == NULL || !g_path_is_absolute (socket_path)) {
    g_printerr ("tilecast-session-bridge: --socket must be an absolute path\n");
    return 2;
  }

  TbBridge bridge = { 0 };
  bridge.socket_path = socket_path;
  bridge.loop = g_main_loop_new (NULL, FALSE);
  g_unix_signal_add (SIGTERM, on_signal, &bridge);
  g_unix_signal_add (SIGINT, on_signal, &bridge);

  tb_ipc_start (&bridge);
  g_message ("session bridge %s started", TB_VERSION);
  g_main_loop_run (bridge.loop);

  tb_ipc_stop (&bridge, "bridge_stopping");
  g_main_loop_unref (bridge.loop);
  return bridge.exit_code;
}
