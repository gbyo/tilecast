/*
 * The trusted renderer's side of remote web (threat review §5-§7, §15-§16):
 * a client of tilecast-web-renderer-wpe's control socket that serves the
 * runtime's `host-view` members.
 *
 * Page requests are rebuilt as remote web protocol v1 frames and validated
 * with the same parser the helper uses before they are sent, so nothing the
 * page adds reaches the helper. The helper's replies and events are
 * validated again before the runtime sees them. The runtime receives only
 * `tcweb://cap/<capability>`; the frame socket's path never leaves C.
 */
#pragma once

#include "host.h"

G_BEGIN_DECLS

void tc_remote_web_start (TcHost *host);
void tc_remote_web_stop (TcHost *host);
gboolean tc_remote_web_available (TcHost *host);
gboolean tc_remote_web_accelerated (TcHost *host);
/* Why remote web is not available, as a stable token, or NULL. */
const char *tc_remote_web_reason (TcHost *host);

/* runtime → host */
void tc_remote_web_create (TcHost *host, JsonObject *message, WebKitScriptMessageReply *reply);
void tc_remote_web_page_message (TcHost *host, const char *type, JsonObject *message);
/* The trusted runtime document went away (reload or web process exit): every
 * surface it owned is destroyed in the helper. */
void tc_remote_web_reset (TcHost *host);

/* daemon renderer.command clear_website_data */
void tc_remote_web_clear (TcHost *host, const char *command_id);

G_END_DECLS
