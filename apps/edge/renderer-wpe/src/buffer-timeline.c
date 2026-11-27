#include "buffer-timeline.h"
#include "visual-trace-format.h"

#include <sys/stat.h>

struct _TcBufferTimeline {
  GQuark quark;
  guint next_buffer;
  guint next_memory;
  guint64 presented;
  GHashTable *memory; /* "dev:ino" -> ordinal */
};

TcBufferTimeline *
tc_buffer_timeline_new (void)
{
  static guint instances;
  TcBufferTimeline *timeline = g_new0 (TcBufferTimeline, 1);
  g_autofree char *name = g_strdup_printf ("tilecast-buffer-timeline-%u", ++instances);
  timeline->quark = g_quark_from_string (name);
  timeline->memory = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, NULL);
  return timeline;
}

void
tc_buffer_timeline_free (TcBufferTimeline *timeline)
{
  if (timeline == NULL)
    return;
  g_hash_table_unref (timeline->memory);
  g_free (timeline);
}

guint
tc_buffer_timeline_buffer_id (TcBufferTimeline *timeline, WPEBuffer *buffer)
{
  guint id = GPOINTER_TO_UINT (g_object_get_qdata (G_OBJECT (buffer), timeline->quark));
  if (id == 0) {
    id = ++timeline->next_buffer;
    g_object_set_qdata (G_OBJECT (buffer), timeline->quark, GUINT_TO_POINTER (id));
  }
  return id;
}

static guint
memory_id (TcBufferTimeline *timeline, WPEBuffer *buffer)
{
  if (!WPE_IS_BUFFER_DMA_BUF (buffer))
    return 0;
  int fd = wpe_buffer_dma_buf_get_fd (WPE_BUFFER_DMA_BUF (buffer), 0);
  struct stat st;
  if (fd < 0 || fstat (fd, &st) != 0)
    return 0;
  g_autofree char *key = g_strdup_printf ("%" G_GUINT64_FORMAT ":%" G_GUINT64_FORMAT, (guint64) st.st_dev,
                                          (guint64) st.st_ino);
  guint id = GPOINTER_TO_UINT (g_hash_table_lookup (timeline->memory, key));
  if (id == 0) {
    id = ++timeline->next_memory;
    g_hash_table_insert (timeline->memory, g_steal_pointer (&key), GUINT_TO_POINTER (id));
  }
  return id;
}

guint64
tc_buffer_timeline_rendered (TcBufferTimeline *timeline, WPEBuffer *buffer, gint64 mono_us, GString *line)
{
  guint64 seq = ++timeline->presented;
  guint id = tc_buffer_timeline_buffer_id (timeline, buffer);
  g_string_append_printf (line,
                          "{\"type\":\"frame\",\"ev\":\"rendered\",\"mono\":%" G_GINT64_FORMAT ",\"seq\":%" G_GUINT64_FORMAT
                          ",\"buf\":%u,\"w\":%d,\"h\":%d",
                          mono_us, seq, id, wpe_buffer_get_width (buffer), wpe_buffer_get_height (buffer));
  if (WPE_IS_BUFFER_DMA_BUF (buffer)) {
    WPEBufferDMABuf *dma = WPE_BUFFER_DMA_BUF (buffer);
    char fourcc[5];
    tc_trace_fourcc (wpe_buffer_dma_buf_get_format (dma), fourcc);
    guint32 planes = wpe_buffer_dma_buf_get_n_planes (dma);
    g_string_append_printf (line,
                            ",\"kind\":\"dmabuf\",\"mem\":%u,\"fourcc\":\"%s\",\"modifier\":\"0x%016" G_GINT64_MODIFIER
                            "x\",\"planes\":%u,\"strides\":[",
                            memory_id (timeline, buffer), fourcc, wpe_buffer_dma_buf_get_modifier (dma), planes);
    for (guint32 plane = 0; plane < planes && plane < 4; plane++)
      g_string_append_printf (line, "%s%u", plane ? "," : "", wpe_buffer_dma_buf_get_stride (dma, plane));
    g_string_append (line, "],\"offsets\":[");
    for (guint32 plane = 0; plane < planes && plane < 4; plane++)
      g_string_append_printf (line, "%s%u", plane ? "," : "", wpe_buffer_dma_buf_get_offset (dma, plane));
    g_string_append (line, "]");
  } else if (WPE_IS_BUFFER_SHM (buffer)) {
    WPEBufferSHM *shm = WPE_BUFFER_SHM (buffer);
    g_string_append_printf (line, ",\"kind\":\"shm\",\"format\":\"%s\",\"stride\":%u",
                            wpe_buffer_shm_get_format (shm) == WPE_PIXEL_FORMAT_ARGB8888 ? "ARGB8888" : "other",
                            wpe_buffer_shm_get_stride (shm));
  } else {
    g_string_append (line, ",\"kind\":\"other\"");
  }
  g_string_append_printf (line, ",\"renderFence\":%s,\"releaseFence\":%s}",
                          wpe_buffer_get_rendering_fence (buffer) >= 0 ? "true" : "false",
                          wpe_buffer_get_release_fence (buffer) >= 0 ? "true" : "false");
  return seq;
}

void
tc_buffer_timeline_released (TcBufferTimeline *timeline, WPEBuffer *buffer, gint64 mono_us, GString *line)
{
  g_string_append_printf (line, "{\"type\":\"frame\",\"ev\":\"released\",\"mono\":%" G_GINT64_FORMAT ",\"buf\":%u}",
                          mono_us, tc_buffer_timeline_buffer_id (timeline, buffer));
}

void
tc_buffer_timeline_pool (TcBufferTimeline *timeline, WPEBuffer **buffers, guint n, gint64 mono_us, GString *line)
{
  g_string_append_printf (line, "{\"type\":\"buffers\",\"mono\":%" G_GINT64_FORMAT ",\"count\":%u,\"bufs\":[", mono_us,
                          n);
  guint written = 0;
  for (guint i = 0; i < n && i < 16; i++) {
    if (buffers[i] != NULL && WPE_IS_BUFFER (buffers[i]))
      g_string_append_printf (line, "%s%u", written++ ? "," : "", tc_buffer_timeline_buffer_id (timeline, buffers[i]));
  }
  g_string_append (line, "]}");
}

guint
tc_buffer_timeline_distinct_buffers (TcBufferTimeline *timeline)
{
  return timeline->next_buffer;
}

guint
tc_buffer_timeline_distinct_memory (TcBufferTimeline *timeline)
{
  return timeline->next_memory;
}
