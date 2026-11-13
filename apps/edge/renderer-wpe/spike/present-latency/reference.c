/*
 * Stage 4 latency spike: the reference side. Runs a GStreamer decode
 * pipeline that ends in an appsink named "sink" and prints the wall-clock
 * time of each black/white change of the decoded frames' center pixel:
 *
 *   glass white <unix microseconds>
 *
 * The pipeline is the argument, so the run script can measure the Electron
 * receiver pipeline (apps/player-linux/src/main/airplay.ts buildReceiverArgs)
 * and a minimal decode on the same machine. The appsink is the frame that
 * a display sink would show; it adds no compositor, so the comparison
 * favors the reference.
 *
 *   reference SECONDS 'udpsrc ... ! appsink name=sink'
 */
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <stdio.h>
#include <stdlib.h>

static int last_phase = -1;

static GstFlowReturn
on_sample (GstAppSink *sink, gpointer data)
{
  (void) data;
  gint64 now = g_get_real_time ();
  GstSample *sample = gst_app_sink_pull_sample (sink);
  if (sample == NULL)
    return GST_FLOW_EOS;
  GstVideoInfo info;
  GstMapInfo map;
  GstBuffer *buffer = gst_sample_get_buffer (sample);
  if (gst_video_info_from_caps (&info, gst_sample_get_caps (sample)) && gst_buffer_map (buffer, &map, GST_MAP_READ)) {
    gsize offset = (gsize) (GST_VIDEO_INFO_HEIGHT (&info) / 2) * GST_VIDEO_INFO_PLANE_STRIDE (&info, 0)
                   + GST_VIDEO_INFO_WIDTH (&info) / 2;
    int luma = offset < map.size ? map.data[offset] : -1;
    int phase = luma > 200 ? 1 : luma >= 0 && luma < 50 ? 0 : -1;
    if (phase >= 0 && phase != last_phase) {
      printf ("glass %s %" G_GINT64_FORMAT "\n", phase ? "white" : "black", now);
      fflush (stdout);
      last_phase = phase;
    }
    gst_buffer_unmap (buffer, &map);
  }
  gst_sample_unref (sample);
  return GST_FLOW_OK;
}

static gboolean
quit (gpointer loop)
{
  g_main_loop_quit (loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  gst_init (&argc, &argv);
  if (argc != 3)
    return 2;
  g_autoptr (GError) error = NULL;
  GstElement *pipeline = gst_parse_launch (argv[2], &error);
  if (pipeline == NULL) {
    fprintf (stderr, "pipeline: %s\n", error->message);
    return 1;
  }
  GstElement *sink = gst_bin_get_by_name (GST_BIN (pipeline), "sink");
  GstAppSinkCallbacks callbacks = { .new_sample = on_sample };
  gst_app_sink_set_callbacks (GST_APP_SINK (sink), &callbacks, NULL, NULL);
  gst_element_set_state (pipeline, GST_STATE_PLAYING);
  GMainLoop *loop = g_main_loop_new (NULL, FALSE);
  g_timeout_add_seconds ((guint) atoi (argv[1]), quit, loop);
  g_main_loop_run (loop);
  gst_element_set_state (pipeline, GST_STATE_NULL);
  return 0;
}
