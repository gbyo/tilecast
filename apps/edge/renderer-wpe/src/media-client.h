#pragma once

#include <gio/gio.h>

G_BEGIN_DECLS

#define TC_MEDIA_MAX_READ (1024u * 1024u)

/* The socket is daemon-owned. Each call makes one bounded request. */
gboolean tc_media_head (const char *socket_path, const char *capability, guint64 *size, char **mime_type, GError **error);
gboolean tc_media_read (const char *socket_path, const char *capability, guint64 offset, void *buffer, guint32 length,
                        GError **error);

/*
 * Frame reads: identical framing with `"expect":"frame"` appended, so the
 * daemon resolves a frame grant instead of a media grant. Media reads never
 * send the field, keeping their bytes identical for older daemons.
 */
gboolean tc_media_head_frame (const char *socket_path, const char *capability, guint64 *size, char **mime_type,
                              GError **error);
gboolean tc_media_read_frame (const char *socket_path, const char *capability, guint64 offset, void *buffer,
                              guint32 length, GError **error);

G_END_DECLS
