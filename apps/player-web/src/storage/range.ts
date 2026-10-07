export interface ByteRange {
  start: number;
  end: number;
}

/** Single byte ranges only. Invalid and unsatisfiable ranges produce 416. */
export function parseRange(header: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Called only after the media layer validates a current activation grant. */
export function mediaResponse(
  request: Request,
  file: Blob,
  mimeType: string,
): Response {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": mimeType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; sandbox; frame-ancestors 'none'",
  });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  // RFC 9110 defines Range for GET. HEAD reports the complete representation.
  const header = request.method === "GET" ? request.headers.get("Range") : null;
  if (header !== null) {
    const range = parseRange(header, file.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${file.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${file.size}`,
    );
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, {
    status: 200,
    headers,
  });
}
