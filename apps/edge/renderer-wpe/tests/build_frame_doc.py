#!/usr/bin/env python3
"""Build the exact sandbox frame document production serves for a bundle.

The template is parsed from the checked-in generated Server template
(apps/server/internal/extensions/sandbox/frame.gen.go), which widgetctl
generates from the SDK's frame builder, so this output is byte-identical
to production frames without needing a TypeScript runtime. Usage:

    build_frame_doc.py <bundle.js > frame.html
"""

import os
import re
import sys

PLACEHOLDER = "__TILECAST_SANDBOX_BUNDLE__"
CLOSER = re.compile(r"</script", re.IGNORECASE)


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "..", ".."))


def load_template():
    path = os.path.join(repo_root(), "apps", "server", "internal", "extensions", "sandbox", "frame.gen.go")
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    match = re.search(r'const Template = "(.*)"\n', source, re.DOTALL)
    if not match:
        raise AssertionError("frame template literal not found")
    literal = match.group(1)
    # The generator emits only \" and \n escapes; anything else is a
    # template change this parser must learn explicitly.
    if re.search(r"\\[^n\"]", literal):
        raise AssertionError("frame template uses an unexpected escape")
    return literal.replace("\\n", "\n").replace('\\"', '"')


def assemble(bundle):
    template = load_template()
    if template.count(PLACEHOLDER) != 1:
        raise AssertionError("frame template must hold exactly one bundle slot")
    return template.replace(PLACEHOLDER, CLOSER.sub(r"<\\/script", bundle), 1)


def main():
    bundle = sys.stdin.read()
    sys.stdout.write(assemble(bundle))


if __name__ == "__main__":
    main()
