/*
 * Pure validation helpers for tilecast-renderer-wpe. Everything that turns
 * outside input (IPC data, page messages, URIs, HTTP headers) into a file
 * access decision goes through one of these functions, and all of them are
 * unit tested in tests/test_validate.c.
 */
#pragma once

#include <glib.h>

G_BEGIN_DECLS

/* Exactly 64 lowercase hexadecimal characters. */
gboolean tc_is_sha256_hex (const char *value);

/*
 * A path under the trusted runtime directory, as requested through
 * tilecast://runtime/<path>. Accepts only "/static/<name>" and
 * "/dist/renderer/<name>" where <name> is [A-Za-z0-9._-]+ and not "." or
 * "..". Everything else, including encoded characters, is rejected.
 */
gboolean tc_runtime_path_is_allowed (const char *path);

/* Content type for a runtime asset by extension, or NULL when not served. */
const char *tc_runtime_content_type (const char *path);

typedef enum {
  TC_RANGE_NONE,          /* no Range header: serve the whole object      */
  TC_RANGE_OK,            /* single satisfiable range in start..end        */
  TC_RANGE_UNSATISFIABLE, /* well formed but outside the object (416)      */
  TC_RANGE_INVALID,       /* malformed or multi-range: serve whole object  */
} TcRangeResult;

/*
 * Parses a single "bytes=a-b", "bytes=a-" or "bytes=-n" range against an
 * object of `size` bytes. Multi-range and malformed headers are reported as
 * TC_RANGE_INVALID; callers then answer 200 with the full object, which is
 * always correct for a range-capable client.
 */
TcRangeResult tc_parse_range (const char *header, guint64 size, guint64 *start, guint64 *end);

/*
 * An absolute path with no "." or ".." segments and no empty segments,
 * used for the CAS root the daemon configures.
 */
gboolean tc_is_clean_absolute_path (const char *path);

G_END_DECLS
