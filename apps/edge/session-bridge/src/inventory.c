/*
 * Audio inventory from WirePlumber (libwireplumber 0.5).
 *
 * WirePlumber owns the session's PipeWire object graph and its policy; the
 * bridge only counts what it offers:
 *
 *   - `Audio/Source` and `Audio/Sink` nodes, from an object manager;
 *   - whether the default source and sink exist, from WirePlumber's
 *     `default-nodes-api` plugin (the same one `wpctl` uses).
 *
 * PipeWire object IDs and node names stay here. tilecastd receives counts
 * and two flags (`audio.inventory`), sent whenever they change.
 *
 * When PipeWire is not reachable, or the connection drops, the inventory
 * says `pipewire: unavailable` and the bridge tries again every
 * TB_RECONNECT_SECONDS.
 */
#include "bridge.h"

#include <pipewire/keys.h>
#include <spa/utils/defs.h>
#include <wp/wp.h>

#define TB_RECONNECT_SECONDS 5

static void connect_core (TbBridge *bridge);

static gboolean
same (const TbInventory *a, const TbInventory *b)
{
  return a->pipewire == b->pipewire && a->sources == b->sources && a->sinks == b->sinks
         && a->default_source == b->default_source && a->default_sink == b->default_sink;
}

void
tb_inventory_send (TbBridge *bridge)
{
  tb_ipc_send_event (bridge, "audio.inventory", tb_inventory_data (&bridge->inventory));
}

/* Counts the nodes of one class and says whether `default_id` is one of them. */
static guint
count_nodes (TbBridge *bridge, const char *media_class, guint32 default_id, gboolean *default_present)
{
  guint count = 0;
  *default_present = FALSE;
  g_autoptr (WpIterator) nodes = wp_object_manager_new_filtered_iterator (
    bridge->nodes, WP_TYPE_NODE, WP_CONSTRAINT_TYPE_PW_GLOBAL_PROPERTY, "media.class", "=s", media_class, NULL);
  g_auto (GValue) item = G_VALUE_INIT;
  for (; wp_iterator_next (nodes, &item); g_value_unset (&item)) {
    WpProxy *node = g_value_get_object (&item);
    count++;
    if (default_id != SPA_ID_INVALID && wp_proxy_get_bound_id (node) == default_id)
      *default_present = TRUE;
  }
  return count;
}

static guint32
default_node (TbBridge *bridge, const char *media_class)
{
  guint32 id = SPA_ID_INVALID;
  if (bridge->default_nodes != NULL)
    g_signal_emit_by_name (bridge->default_nodes, "get-default-node", media_class, &id);
  return id;
}

static void
refresh (TbBridge *bridge)
{
  TbInventory next = { 0 };
  if (bridge->core != NULL && wp_core_is_connected (bridge->core) && bridge->nodes != NULL) {
    next.pipewire = TRUE;
    next.sources = count_nodes (bridge, "Audio/Source", default_node (bridge, "Audio/Source"), &next.default_source);
    next.sinks = count_nodes (bridge, "Audio/Sink", default_node (bridge, "Audio/Sink"), &next.default_sink);
  }
  if (same (&next, &bridge->inventory))
    return;
  g_message ("inventory: pipewire=%s sources=%u sinks=%u default source=%s default sink=%s",
             next.pipewire ? "yes" : "no", next.sources, next.sinks, next.default_source ? "yes" : "no",
             next.default_sink ? "yes" : "no");
  bridge->inventory = next;
  tb_inventory_send (bridge);
}

static void
on_changed (gpointer data)
{
  refresh (data);
}

static void
on_plugin_activated (GObject *source, GAsyncResult *result, gpointer data)
{
  TbBridge *bridge = data;
  g_autoptr (GError) error = NULL;
  if (!wp_object_activate_finish (WP_OBJECT (source), result, &error)) {
    /* The inventory still counts nodes; only the default flags stay false. */
    g_warning ("inventory: default-nodes-api did not start: %s", error->message);
    g_clear_object (&bridge->default_nodes);
  }
  refresh (bridge);
}

static void
on_component_loaded (GObject *source, GAsyncResult *result, gpointer data)
{
  TbBridge *bridge = data;
  g_autoptr (GError) error = NULL;
  if (!wp_core_load_component_finish (WP_CORE (source), result, &error)) {
    g_warning ("inventory: WirePlumber's default-nodes-api is unavailable: %s", error->message);
    refresh (bridge);
    return;
  }
  bridge->default_nodes = wp_plugin_find (bridge->core, "default-nodes-api");
  if (bridge->default_nodes == NULL) {
    refresh (bridge);
    return;
  }
  g_signal_connect_swapped (bridge->default_nodes, "changed", G_CALLBACK (on_changed), bridge);
  wp_object_activate (WP_OBJECT (bridge->default_nodes), WP_PLUGIN_FEATURE_ENABLED, NULL, on_plugin_activated,
                      bridge);
}

static void
drop_core (TbBridge *bridge)
{
  if (bridge->default_nodes != NULL)
    g_signal_handlers_disconnect_by_data (bridge->default_nodes, bridge);
  g_clear_object (&bridge->default_nodes);
  if (bridge->nodes != NULL)
    g_signal_handlers_disconnect_by_data (bridge->nodes, bridge);
  g_clear_object (&bridge->nodes);
  if (bridge->core != NULL) {
    g_signal_handlers_disconnect_by_data (bridge->core, bridge);
    wp_core_disconnect (bridge->core);
  }
  g_clear_object (&bridge->core);
}

static void
retry_connect (gpointer data)
{
  TbBridge *bridge = data;
  bridge->inventory_retry_source = 0;
  connect_core (bridge);
}

static void
schedule_retry (TbBridge *bridge)
{
  if (bridge->inventory_retry_source == 0)
    bridge->inventory_retry_source = g_timeout_add_seconds_once (TB_RECONNECT_SECONDS, retry_connect, bridge);
}

static void
after_disconnect (gpointer data)
{
  TbBridge *bridge = data;
  drop_core (bridge);
  refresh (bridge);
  schedule_retry (bridge);
}

static void
on_disconnected (gpointer data)
{
  g_warning ("inventory: the PipeWire connection closed");
  /* Not from inside the core's own signal emission. */
  g_idle_add_once (after_disconnect, data);
}

static void
connect_core (TbBridge *bridge)
{
  g_autoptr (WpProperties) properties =
    wp_properties_new (PW_KEY_APP_NAME, "tilecast-session-bridge", PW_KEY_MEDIA_CATEGORY, "Monitor", NULL);
  bridge->core = wp_core_new (NULL, NULL, g_steal_pointer (&properties));
  if (!wp_core_connect (bridge->core)) {
    g_debug ("inventory: PipeWire is not reachable");
    drop_core (bridge);
    refresh (bridge);
    schedule_retry (bridge);
    return;
  }
  g_signal_connect_swapped (bridge->core, "disconnected", G_CALLBACK (on_disconnected), bridge);
  bridge->nodes = wp_object_manager_new ();
  wp_object_manager_add_interest (bridge->nodes, WP_TYPE_NODE, WP_CONSTRAINT_TYPE_PW_GLOBAL_PROPERTY, "media.class",
                                  "#s", "Audio/*", NULL);
  wp_object_manager_request_object_features (bridge->nodes, WP_TYPE_NODE, WP_PROXY_FEATURE_BOUND);
  g_signal_connect_swapped (bridge->nodes, "objects-changed", G_CALLBACK (on_changed), bridge);
  g_signal_connect_swapped (bridge->nodes, "installed", G_CALLBACK (on_changed), bridge);
  wp_core_install_object_manager (bridge->core, bridge->nodes);
  wp_core_load_component (bridge->core, "libwireplumber-module-default-nodes-api", "module", NULL, NULL, NULL,
                          on_component_loaded, bridge);
}

void
tb_inventory_start (TbBridge *bridge)
{
  wp_init (WP_INIT_PIPEWIRE | WP_INIT_SPA_TYPES);
  connect_core (bridge);
}

void
tb_inventory_stop (TbBridge *bridge)
{
  if (bridge->inventory_retry_source != 0) {
    g_source_remove (bridge->inventory_retry_source);
    bridge->inventory_retry_source = 0;
  }
  drop_core (bridge);
}
