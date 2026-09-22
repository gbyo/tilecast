/*
 * URI scheme handlers. Both resolve identifiers, never paths:
 *
 *   tilecast://runtime/<allowlisted asset>  → <runtime dir>/<asset>
 *   tcmedia://sha256/<64 hex>               → <CAS root>/sha256/<ab>/<hex>
 *
 * A media request is served only when the digest is listed in the current
 * activation or plugin state, and only when the file's size matches what
 * tilecastd declared (tilecastd verified the digest before activating). Files
 * are opened with O_NOFOLLOW. Single byte ranges are honored so GStreamer can
 * seek; anything else gets the whole object.
 */
#include "host.h"
#include "validate.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gunixinputstream.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* ------------------------------------------------ bounded input stream */

#define TC_TYPE_BOUNDED_STREAM (tc_bounded_stream_get_type ())
G_DECLARE_FINAL_TYPE (TcBoundedStream, tc_bounded_stream, TC, BOUNDED_STREAM, GInputStream)

struct _TcBoundedStream {
  GInputStream parent_instance;
  int fd;
  guint64 offset;
  guint64 remaining;
};

G_DEFINE_FINAL_TYPE (TcBoundedStream, tc_bounded_stream, G_TYPE_INPUT_STREAM)

static gssize
tc_bounded_stream_read (GInputStream *stream, void *buffer, gsize count, GCancellable *cancellable, GError **error)
{
  (void) cancellable;
  TcBoundedStream *self = TC_BOUNDED_STREAM (stream);
  if (self->remaining == 0)
    return 0;
  gsize want = (gsize) MIN ((guint64) count, self->remaining);
  gssize got;
  do {
    got = pread (self->fd, buffer, want, (off_t) self->offset);
  } while (got < 0 && errno == EINTR);
  if (got < 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "read failed: %s", g_strerror (errno));
    return -1;
  }
  self->offset += (guint64) got;
  self->remaining -= (guint64) got;
  return got;
}

static gboolean
tc_bounded_stream_close (GInputStream *stream, GCancellable *cancellable, GError **error)
{
  (void) cancellable;
  (void) error;
  TcBoundedStream *self = TC_BOUNDED_STREAM (stream);
  if (self->fd >= 0) {
    close (self->fd);
    self->fd = -1;
  }
  return TRUE;
}

static void
tc_bounded_stream_finalize (GObject *object)
{
  TcBoundedStream *self = TC_BOUNDED_STREAM (object);
  if (self->fd >= 0)
    close (self->fd);
  G_OBJECT_CLASS (tc_bounded_stream_parent_class)->finalize (object);
}

static void
tc_bounded_stream_class_init (TcBoundedStreamClass *klass)
{
  G_OBJECT_CLASS (klass)->finalize = tc_bounded_stream_finalize;
  G_INPUT_STREAM_CLASS (klass)->read_fn = tc_bounded_stream_read;
  G_INPUT_STREAM_CLASS (klass)->close_fn = tc_bounded_stream_close;
}

static void
tc_bounded_stream_init (TcBoundedStream *self)
{
  self->fd = -1;
}

static GInputStream *
bounded_stream_new (int fd, guint64 offset, guint64 length)
{
  TcBoundedStream *self = g_object_new (TC_TYPE_BOUNDED_STREAM, NULL);
  self->fd = fd;
  self->offset = offset;
  self->remaining = length;
  return G_INPUT_STREAM (self);
}

/* ------------------------------------------------------------ helpers */

void
tc_content_ref_free (gpointer data)
{
  TcContentRef *ref = data;
  g_free (ref->mime_type);
  g_free (ref);
}

const TcContentRef *
tc_host_find_content (TcHost *host, const char *sha256)
{
  for (guint i = 0; i < host->content->len; i++) {
    const TcContentRef *ref = g_ptr_array_index (host->content, i);
    if (strcmp (ref->sha256, sha256) == 0)
      return ref;
  }
  return NULL;
}

static void
fail (WebKitURISchemeRequest *request, int code, const char *message)
{
  g_autoptr (GError) error = g_error_new_literal (G_IO_ERROR, code, message);
  webkit_uri_scheme_request_finish_error (request, error);
}

static void
finish (WebKitURISchemeRequest *request, int fd, guint64 offset, guint64 length, guint status, const char *type,
        SoupMessageHeaders *headers)
{
  g_autoptr (GInputStream) stream = bounded_stream_new (fd, offset, length);
  g_autoptr (WebKitURISchemeResponse) response = webkit_uri_scheme_response_new (stream, (gint64) length);
  webkit_uri_scheme_response_set_status (response, status, NULL);
  webkit_uri_scheme_response_set_content_type (response, type);
  /* (transfer full): the response owns the headers from here on. */
  if (headers != NULL)
    webkit_uri_scheme_response_set_http_headers (response, headers);
  webkit_uri_scheme_request_finish_with_response (request, response);
}

static int
open_regular (const char *path, guint64 *size)
{
  int fd = open (path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    return -1;
  struct stat st;
  if (fstat (fd, &st) != 0 || !S_ISREG (st.st_mode)) {
    close (fd);
    return -1;
  }
  *size = (guint64) st.st_size;
  return fd;
}

/* ------------------------------------------------------ runtime scheme */

static void
handle_runtime (WebKitURISchemeRequest *request, gpointer user_data)
{
  TcHost *host = user_data;
  g_autoptr (GUri) uri = g_uri_parse (webkit_uri_scheme_request_get_uri (request), G_URI_FLAGS_ENCODED, NULL);
  const char *authority = uri ? g_uri_get_host (uri) : NULL;
  const char *path = uri ? g_uri_get_path (uri) : NULL;
  const char *type = tc_runtime_content_type (path);
  if (g_strcmp0 (authority, "runtime") != 0 || !tc_runtime_path_is_allowed (path) || type == NULL
      || g_uri_get_query (uri) != NULL) {
    fail (request, G_IO_ERROR_NOT_FOUND, "not found");
    return;
  }
  g_autofree char *file = g_build_filename (host->runtime_dir, path + 1, NULL);
  guint64 size = 0;
  int fd = open_regular (file, &size);
  if (fd < 0) {
    fail (request, G_IO_ERROR_NOT_FOUND, "not found");
    return;
  }
  finish (request, fd, 0, size, 200, type, NULL);
}

/* -------------------------------------------------------- media scheme */

static void
handle_media (WebKitURISchemeRequest *request, gpointer user_data)
{
  TcHost *host = user_data;
  g_autoptr (GUri) uri = g_uri_parse (webkit_uri_scheme_request_get_uri (request), G_URI_FLAGS_ENCODED, NULL);
  const char *authority = uri ? g_uri_get_host (uri) : NULL;
  const char *path = uri ? g_uri_get_path (uri) : NULL;
  const char *hex = path && path[0] == '/' ? path + 1 : NULL;
  if (g_strcmp0 (authority, "sha256") != 0 || !tc_is_sha256_hex (hex) || g_uri_get_query (uri) != NULL) {
    fail (request, G_IO_ERROR_NOT_FOUND, "not found");
    return;
  }
  const TcContentRef *ref = tc_host_find_content (host, hex);
  if (ref == NULL || host->cas_root == NULL) {
    g_warning ("schemes: refused media %.12s that the current activation does not list", hex);
    fail (request, G_IO_ERROR_PERMISSION_DENIED, "not part of the current presentation");
    return;
  }
  char fanout[3] = { hex[0], hex[1], '\0' };
  g_autofree char *file = g_build_filename (host->cas_root, "sha256", fanout, hex, NULL);
  guint64 size = 0;
  int fd = open_regular (file, &size);
  if (fd < 0 || size != ref->size_bytes) {
    if (fd >= 0)
      close (fd);
    g_warning ("schemes: media %.12s is missing or has the wrong size", hex);
    fail (request, G_IO_ERROR_NOT_FOUND, "not available");
    return;
  }

  SoupMessageHeaders *request_headers = webkit_uri_scheme_request_get_http_headers (request);
  const char *range = request_headers ? soup_message_headers_get_one (request_headers, "Range") : NULL;
  guint64 start = 0, end = size == 0 ? 0 : size - 1;
  SoupMessageHeaders *headers = soup_message_headers_new (SOUP_MESSAGE_HEADERS_RESPONSE);
  soup_message_headers_append (headers, "Accept-Ranges", "bytes");
  g_autofree char *etag = g_strdup_printf ("\"sha256:%s\"", hex);
  soup_message_headers_append (headers, "ETag", etag);
  soup_message_headers_append (headers, "Cache-Control", "no-store");
  switch (tc_parse_range (range, size, &start, &end)) {
  case TC_RANGE_OK: {
    g_autofree char *content_range =
      g_strdup_printf ("bytes %" G_GUINT64_FORMAT "-%" G_GUINT64_FORMAT "/%" G_GUINT64_FORMAT, start, end, size);
    soup_message_headers_append (headers, "Content-Range", content_range);
    finish (request, fd, start, end - start + 1, 206, ref->mime_type, headers);
    break;
  }
  case TC_RANGE_UNSATISFIABLE: {
    g_autofree char *content_range = g_strdup_printf ("bytes */%" G_GUINT64_FORMAT, size);
    soup_message_headers_append (headers, "Content-Range", content_range);
    finish (request, fd, 0, 0, 416, ref->mime_type, headers);
    break;
  }
  case TC_RANGE_NONE:
  case TC_RANGE_INVALID:
  default:
    finish (request, fd, 0, size, 200, ref->mime_type, headers);
    break;
  }
}

void
tc_schemes_register (TcHost *host)
{
  WebKitSecurityManager *security = webkit_web_context_get_security_manager (host->web_context);
  webkit_security_manager_register_uri_scheme_as_secure (security, "tilecast");
  webkit_security_manager_register_uri_scheme_as_secure (security, "tcmedia");
  webkit_security_manager_register_uri_scheme_as_cors_enabled (security, "tcmedia");
  webkit_web_context_register_uri_scheme (host->web_context, "tilecast", handle_runtime, host, NULL);
  webkit_web_context_register_uri_scheme (host->web_context, "tcmedia", handle_media, host, NULL);
}
