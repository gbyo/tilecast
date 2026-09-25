/*
 * --probe-drm: what the migrator needs to know about the DRM/KMS output
 * before the cutover, while the legacy player's display session may still
 * hold DRM master.
 *
 * The probe only reads: it opens each /dev/dri/cardN, reads the driver name
 * and the connectors' current state (drmModeGetConnectorCurrent, which never
 * forces a new probe of the outputs), and prints one JSON object. It does not
 * become DRM master, set a mode or draw. The on-screen proof on DRM is the
 * migration's settlement, after the display session has stopped.
 *
 * Exit status: 0 when at least one card is readable and has a connected
 * connector with a mode, 5 when none has.
 */
#include "host.h"

#include <errno.h>
#include <fcntl.h>
#include <json-glib/json-glib.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define TC_DRM_MAX_CARDS 16
#define TC_DRM_MAX_CONNECTORS 32

/* Driver and connector names come from the kernel; keep only a bounded,
 * plain token so the output stays a safe diagnostic. */
static char *
plain_token (const char *value)
{
  GString *out = g_string_new (NULL);
  for (const char *p = value; p != NULL && *p != '\0' && out->len < 32; p++) {
    if (g_ascii_isalnum (*p) || *p == '-' || *p == '_')
      g_string_append_c (out, g_ascii_tolower (*p));
  }
  return g_string_free (out, FALSE);
}

static const char *
open_error_code (int error)
{
  switch (error) {
  case EACCES:
  case EPERM:
    return "permission_denied";
  case ENOENT:
  case ENODEV:
  case ENXIO:
    return "no_device";
  default:
    return "open_failed";
  }
}

static gboolean
probe_card (JsonBuilder *builder, const char *path)
{
  gboolean usable = FALSE;
  int fd = open (path, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "path");
  json_builder_add_string_value (builder, path);
  if (fd < 0) {
    json_builder_set_member_name (builder, "error");
    json_builder_add_string_value (builder, open_error_code (errno));
    json_builder_end_object (builder);
    return FALSE;
  }
  drmVersionPtr version = drmGetVersion (fd);
  if (version != NULL) {
    g_autofree char *driver = plain_token (version->name);
    json_builder_set_member_name (builder, "driver");
    json_builder_add_string_value (builder, driver);
    drmFreeVersion (version);
  }
  json_builder_set_member_name (builder, "master");
  json_builder_add_boolean_value (builder, drmIsMaster (fd));
  drmModeResPtr resources = drmModeGetResources (fd);
  json_builder_set_member_name (builder, "kms");
  json_builder_add_boolean_value (builder, resources != NULL);
  json_builder_set_member_name (builder, "connectors");
  json_builder_begin_array (builder);
  for (int i = 0; resources != NULL && i < resources->count_connectors && i < TC_DRM_MAX_CONNECTORS; i++) {
    drmModeConnectorPtr connector = drmModeGetConnectorCurrent (fd, resources->connectors[i]);
    if (connector == NULL)
      continue;
    gboolean connected = connector->connection == DRM_MODE_CONNECTED;
    g_autofree char *type = plain_token (drmModeGetConnectorTypeName (connector->connector_type));
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "name");
    g_autofree char *name = g_strdup_printf ("%s-%u", type[0] ? type : "unknown", connector->connector_type_id);
    json_builder_add_string_value (builder, name);
    json_builder_set_member_name (builder, "connected");
    json_builder_add_boolean_value (builder, connected);
    json_builder_set_member_name (builder, "modes");
    json_builder_add_int_value (builder, connector->count_modes);
    for (int m = 0; m < connector->count_modes; m++) {
      const drmModeModeInfo *mode = &connector->modes[m];
      if ((mode->type & DRM_MODE_TYPE_PREFERRED) || m == connector->count_modes - 1) {
        json_builder_set_member_name (builder, "preferredWidth");
        json_builder_add_int_value (builder, mode->hdisplay);
        json_builder_set_member_name (builder, "preferredHeight");
        json_builder_add_int_value (builder, mode->vdisplay);
        json_builder_set_member_name (builder, "preferredRefreshHz");
        json_builder_add_int_value (builder, mode->vrefresh);
        break;
      }
    }
    json_builder_end_object (builder);
    usable |= connected && connector->count_modes > 0;
    drmModeFreeConnector (connector);
  }
  json_builder_end_array (builder);
  if (resources != NULL)
    drmModeFreeResources (resources);
  json_builder_set_member_name (builder, "usable");
  json_builder_add_boolean_value (builder, usable);
  json_builder_end_object (builder);
  close (fd);
  return usable;
}

int
tc_drm_probe (const char *dri_dir)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  gboolean usable = FALSE;
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "cards");
  json_builder_begin_array (builder);
  for (int i = 0; i < TC_DRM_MAX_CARDS; i++) {
    g_autofree char *path = g_strdup_printf ("%s/card%d", dri_dir, i);
    if (!g_file_test (path, G_FILE_TEST_EXISTS))
      continue;
    usable |= probe_card (builder, path);
  }
  json_builder_end_array (builder);
  json_builder_set_member_name (builder, "usable");
  json_builder_add_boolean_value (builder, usable);
  json_builder_end_object (builder);
  g_autoptr (JsonGenerator) generator = json_generator_new ();
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  json_generator_set_root (generator, root);
  g_autofree char *text = json_generator_to_data (generator, NULL);
  g_print ("%s\n", text);
  return usable ? 0 : 5;
}
