"""Sanitizes renderer log lines for a public graphics bug report, and checks
the result (docs/tilecast-edge-wpe-compositor-lab.md, "Field bundle").

Two steps, both required:
  1. sanitize() replaces every value that can identify a screen, a server or
     content: device credentials and authorization headers, URLs of any
     scheme (Server addresses, tcmedia capabilities), UUIDs (screen, player,
     activation, manifest IDs), long hex strings (digests, capabilities), IP
     addresses, e-mail addresses and host names.
  2. find_private() scans the sanitized text again for the same patterns and
     for values the caller knows are private on this screen (its host name,
     machine ID and addresses). A bundle includes a log only when it finds
     nothing.

    python3 sanitize_log.py < journal.txt > clean.txt   exits 1 if anything is left
"""
import re
import sys

REDACTIONS = [
    ("credential", re.compile(r"tc_device_[A-Za-z0-9._~+/=-]+"), "tc_device_<redacted>"),
    ("authorization", re.compile(r"\b(Bearer|Pairing|Basic)\s+[^\s\"',;]+", re.I), r"\1 <redacted>"),
    ("url", re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]{1,15}://[^\s\"'<>)]*"), "<url>"),
    ("uuid", re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    ("hex", re.compile(r"\b[0-9a-fA-F]{24,}\b"), "<hex>"),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "<email>"),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"), "<ip>"),
    ("ipv6", re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b|::(?:[0-9a-fA-F]{1,4}:?){1,7}"), "<ip>"),
]

# File names are kept: they say which library or source logged the line.
FILE_SUFFIXES = {
    "so", "js", "mjs", "css", "html", "c", "h", "cc", "cpp", "rs", "json", "jsonl", "png", "jpg", "jpeg",
    "webp", "svg", "mp4", "webm", "conf", "service", "socket", "sock", "ppm", "txt", "log", "md", "py", "sh",
    "xml", "wasm", "ts", "target", "timer", "path", "mount", "slice", "scope", "device", "gz", "xz", "tar",
}
HOST = re.compile(r"\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,24})\b")


def _host(match):
    if match.group(1).lower() in FILE_SUFFIXES:
        return match.group(0)
    return "<host>"


def sanitize(text):
    for _, pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return HOST.sub(_host, text)


def find_private(text, known=()):
    """Names of every pattern still present, and of every known value found."""
    found = []
    for name, pattern, _ in REDACTIONS:
        for match in pattern.finditer(text):
            if "<redacted>" not in match.group(0):
                found.append(name)
                break
    for match in HOST.finditer(text):
        if match.group(1).lower() not in FILE_SUFFIXES:
            found.append("host")
            break
    lowered = text.lower()
    for value in known:
        if value and len(value) >= 4 and value.lower() in lowered:
            found.append("known-private-value")
            break
    return found


if __name__ == "__main__":
    cleaned = sanitize(sys.stdin.read())
    left = find_private(cleaned)
    sys.stdout.write(cleaned)
    if left:
        print(f"sanitize_log: still present after sanitizing: {', '.join(left)}", file=sys.stderr)
        sys.exit(1)
