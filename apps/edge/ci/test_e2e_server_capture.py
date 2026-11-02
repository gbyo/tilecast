"""The capture-content checks of e2e_server.py must tell the Beta 6 field
failure from a correct frame. The real-server run needs Docker and WPE; these
tests use synthetic frames, so a weak check cannot pass unnoticed."""

import importlib.util
from pathlib import Path
import struct
import unittest
import zlib


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


e2e = load("e2e_server")

WIDTH, HEIGHT = 640, 360
ORANGE, SKY, WHITE, BLACK = (255, 106, 0), (0, 160, 253), (255, 255, 255), (0, 0, 0)


def frame(video=SKY, box_x=None, overlay=ORANGE):
    """The field Layout as a Studio frame: an opaque strip over the left
    quarter, the video elsewhere, and optionally the video's moving box."""
    rows = []
    for y in range(HEIGHT):
        row = bytearray()
        for x in range(WIDTH):
            if x < WIDTH // 4:
                color = overlay
            elif box_x is not None and box_x <= x < box_x + 40 and 150 <= y < 210:
                color = WHITE
            else:
                color = video
            row += bytes(color)
        rows.append(bytes(row))
    return e2e.Frame(WIDTH, HEIGHT, b"".join(rows))


class CaptureContentTest(unittest.TestCase):
    def test_a_correct_frame_passes(self):
        result = e2e.assert_video_under_overlay(frame(box_x=250), "frame")
        self.assertGreaterEqual(result["overlay"], 0.9)
        self.assertAlmostEqual(result["box_x"], 250 + 20, delta=4)

    def test_the_beta_6_failure_is_rejected(self):
        # The overlay is composited, the video region is black.
        with self.assertRaisesRegex(AssertionError, "black"):
            e2e.assert_video_under_overlay(frame(video=BLACK, box_x=250), "frame")

    def test_a_missing_overlay_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "overlay is missing"):
            e2e.assert_video_under_overlay(frame(box_x=250, overlay=BLACK), "frame")

    def test_a_video_background_without_the_moving_box_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "moving box"):
            e2e.assert_video_under_overlay(frame(box_x=None), "frame")

    def test_a_different_picture_in_the_video_region_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, "not the video"):
            e2e.assert_video_under_overlay(frame(video=(120, 120, 120), box_x=250), "frame")

    def test_box_position_follows_the_video(self):
        left = e2e.composition(frame(box_x=200))["box_x"]
        right = e2e.composition(frame(box_x=420))["box_x"]
        self.assertGreater(right - left, 200)

    def test_the_overlay_png_is_a_valid_transparent_image(self):
        png = e2e.png_with_alpha(16, 4, 4, (255, 106, 0))
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        index, chunks = 8, {}
        while index < len(png):
            length, kind = struct.unpack(">I4s", png[index:index + 8])
            body = png[index + 8:index + 8 + length]
            self.assertEqual(zlib.crc32(kind + body) & 0xFFFFFFFF,
                             struct.unpack(">I", png[index + 8 + length:index + 12 + length])[0])
            chunks[kind] = body
            index += 12 + length
        self.assertEqual(struct.unpack(">IIBBBBB", chunks[b"IHDR"]), (16, 4, 8, 6, 0, 0, 0))
        raw = zlib.decompress(chunks[b"IDAT"])
        self.assertEqual(len(raw), 4 * (1 + 16 * 4))
        row = raw[:1 + 16 * 4]
        self.assertEqual(row[1:5], bytes((255, 106, 0, 255)))  # opaque overlay column
        self.assertEqual(row[1 + 4 * 4:1 + 5 * 4], bytes((0, 0, 0, 0)))  # transparent elsewhere

    def test_jpeg_size_reads_the_frame_header(self):
        # SOI, APP0 (length 4), SOF0 for 640x360, EOI.
        jpeg = (b"\xff\xd8" + b"\xff\xe0\x00\x04\x00\x00"
                + b"\xff\xc0\x00\x11\x08" + struct.pack(">HH", 360, 640) + b"\x03" + b"\x00" * 9 + b"\xff\xd9")
        self.assertEqual(e2e.jpeg_size(jpeg), (640, 360))

    def test_the_presented_buffer_log_check(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".log") as log:
            log.write("old line\n")
            log.flush()
            since = Path(log.name).stat().st_size
            log.write("preview: using presented WPE buffer 1280x720 shm ARGB8888 modifier 0x0\n")
            log.flush()
            e2e.assert_presented_buffer_capture(log.name, since, "preview")
            log.write("preview: WPE buffer import unavailable (import_failed); falling back to WebKit snapshot\n")
            log.flush()
            with self.assertRaisesRegex(AssertionError, "fell back"):
                e2e.assert_presented_buffer_capture(log.name, since, "preview")
            with self.assertRaisesRegex(AssertionError, "no presented-buffer capture"):
                e2e.assert_presented_buffer_capture(log.name, Path(log.name).stat().st_size, "preview")


if __name__ == "__main__":
    unittest.main()
