/*
 * The Noise Meter's page → host report (TilecastRuntimeHostV1
 * noiseMeter.report), checked field by field before it becomes the IPC
 * event `noise.report` (edge_protocol NoiseReport). Tested against the IPC
 * fixtures in tests/test_noise.c.
 */
#pragma once

#include <json-glib/json-glib.h>

G_BEGIN_DECLS

/*
 * Copies `status`, an optional `level` in [0, 100] and an optional `bucket`
 * from a page message into `builder` (an open object). `type` is the only
 * other member allowed. Returns FALSE, having copied nothing useful, for
 * anything else: an unknown member, a wrong type or an out-of-range number.
 */
gboolean tc_noise_report_copy (JsonObject *message, JsonBuilder *builder);

G_END_DECLS
