#pragma once

#include <gio/gio.h>

G_BEGIN_DECLS

#define TC_MEDIA_MAX_READ (1024u * 1024u)

/* The socket is daemon-owned. Each call makes one bounded request. */
gboolean tc_media_head (const char *socket_path, const char *capability, guint64 *size, char **mime_type, GError **error);
gboolean tc_media_read (const char *socket_path, const char *capability, guint64 offset, void *buffer, guint32 length,
                        GError **error);

G_END_DECLS
