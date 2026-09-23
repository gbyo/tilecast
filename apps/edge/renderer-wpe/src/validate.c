#include "validate.h"

#include <string.h>

gboolean
tc_is_sha256_hex (const char *value)
{
  if (value == NULL || strlen (value) != 64)
    return FALSE;
  for (const char *p = value; *p; p++) {
    if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f')))
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_is_media_capability_uri (const char *value)
{
  static const char prefix[] = "tcmedia://cap/";
  return value != NULL && g_str_has_prefix (value, prefix) && tc_is_sha256_hex (value + sizeof prefix - 1);
}

gboolean
tc_is_canonical_uuid (const char *value)
{
  if (value == NULL || strlen (value) != 36)
    return FALSE;
  for (guint i = 0; i < 36; i++) {
    gboolean hyphen = i == 8 || i == 13 || i == 18 || i == 23;
    char c = value[i];
    if (hyphen ? c != '-' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_parse_variant_path (const char *path, char key[74])
{
  if (path == NULL || strlen (path) != 74 || path[0] != '/' || path[37] != '/')
    return FALSE;
  char asset[37], variant[37];
  memcpy (asset, path + 1, 36);
  asset[36] = '\0';
  memcpy (variant, path + 38, 36);
  variant[36] = '\0';
  if (!tc_is_canonical_uuid (asset) || !tc_is_canonical_uuid (variant))
    return FALSE;
  memcpy (key, path + 1, 73);
  key[73] = '\0';
  return TRUE;
}

static gboolean
name_is_allowed (const char *name)
{
  if (name[0] == '\0' || strcmp (name, ".") == 0 || strcmp (name, "..") == 0)
    return FALSE;
  if (strlen (name) > 128)
    return FALSE;
  for (const char *p = name; *p; p++) {
    gboolean ok = g_ascii_isalnum (*p) || *p == '.' || *p == '_' || *p == '-';
    if (!ok)
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_runtime_path_is_allowed (const char *path)
{
  /* The shared Player Runtime artifact: top-level files, plus one fixed
   * subdirectory for its bundled fonts. */
  static const char *const subdirectories[] = { "/fonts/", NULL };
  if (path == NULL || path[0] != '/')
    return FALSE;
  for (guint i = 0; subdirectories[i] != NULL; i++) {
    gsize length = strlen (subdirectories[i]);
    if (strncmp (path, subdirectories[i], length) == 0)
      return name_is_allowed (path + length);
  }
  return name_is_allowed (path + 1);
}

const char *
tc_runtime_content_type (const char *path)
{
  static const struct {
    const char *suffix;
    const char *type;
  } types[] = {
    { ".html", "text/html; charset=utf-8" },
    { ".js", "text/javascript; charset=utf-8" },
    { ".css", "text/css; charset=utf-8" },
    { ".svg", "image/svg+xml" },
    { ".png", "image/png" },
    { ".woff2", "font/woff2" },
    { ".json", "application/json" },
    { ".txt", "text/plain; charset=utf-8" },
  };
  if (path == NULL)
    return NULL;
  for (guint i = 0; i < G_N_ELEMENTS (types); i++) {
    if (g_str_has_suffix (path, types[i].suffix))
      return types[i].type;
  }
  return NULL;
}

static gboolean
parse_u64 (const char *start, const char *end, guint64 *out)
{
  if (start == end || end - start > 19)
    return FALSE;
  guint64 value = 0;
  for (const char *p = start; p < end; p++) {
    if (*p < '0' || *p > '9')
      return FALSE;
    value = value * 10 + (guint64) (*p - '0');
  }
  *out = value;
  return TRUE;
}

TcRangeResult
tc_parse_range (const char *header, guint64 size, guint64 *start, guint64 *end)
{
  if (header == NULL || *header == '\0')
    return TC_RANGE_NONE;
  if (strncmp (header, "bytes=", 6) != 0)
    return TC_RANGE_INVALID;
  const char *spec = header + 6;
  if (strchr (spec, ',') != NULL)
    return TC_RANGE_INVALID;
  const char *dash = strchr (spec, '-');
  if (dash == NULL)
    return TC_RANGE_INVALID;
  const char *tail = dash + 1;
  const char *finish = tail + strlen (tail);
  guint64 first = 0, last = 0;
  if (dash == spec) {
    /* Suffix range: last n bytes. */
    guint64 count;
    if (!parse_u64 (tail, finish, &count) || count == 0)
      return TC_RANGE_INVALID;
    if (size == 0)
      return TC_RANGE_UNSATISFIABLE;
    first = count >= size ? 0 : size - count;
    last = size - 1;
  } else {
    if (!parse_u64 (spec, dash, &first))
      return TC_RANGE_INVALID;
    if (tail == finish) {
      last = size == 0 ? 0 : size - 1;
    } else if (!parse_u64 (tail, finish, &last) || last < first) {
      return TC_RANGE_INVALID;
    }
    if (first >= size)
      return TC_RANGE_UNSATISFIABLE;
    if (last >= size)
      last = size - 1;
  }
  *start = first;
  *end = last;
  return TC_RANGE_OK;
}

gboolean
tc_is_clean_absolute_path (const char *path)
{
  if (path == NULL || path[0] != '/' || strlen (path) > 512)
    return FALSE;
  g_auto (GStrv) segments = g_strsplit (path + 1, "/", -1);
  for (guint i = 0; segments[i] != NULL; i++) {
    const char *segment = segments[i];
    if (segment[0] == '\0' && segments[i + 1] != NULL)
      return FALSE;
    if (strcmp (segment, ".") == 0 || strcmp (segment, "..") == 0)
      return FALSE;
    for (const char *p = segment; *p; p++) {
      if ((unsigned char) *p < 0x20)
        return FALSE;
    }
  }
  return TRUE;
}
