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

/* Exact opaque tcmedia URI form accepted from a daemon activation. */
gboolean tc_is_media_capability_uri (const char *value);

/* A canonical lowercase hyphenated UUID (8-4-4-4-12). */
gboolean tc_is_canonical_uuid (const char *value);

/*
 * The path of a tcmedia://variant/<asset>/<variant> request ("/<uuid>/<uuid>"
 * with canonical UUIDs). On success writes "<asset>/<variant>" (73 bytes plus
 * NUL) into `key`. The reference runtime addresses a few media objects this
 * way; the host resolves them only through daemon-provided aliases.
 */
gboolean tc_parse_variant_path (const char *path, char key[74]);

/*
 * A path under the trusted runtime directory, as requested through
 * tilecast://runtime/<path>. Accepts only "/<name>" and "/fonts/<name>"
 * where <name> is [A-Za-z0-9._-]+ and not "." or "..". Everything else,
 * including encoded characters and deeper paths, is rejected.
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
