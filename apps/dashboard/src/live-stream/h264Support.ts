import { H264_CODEC, MJPEG_PROFILE_IDS, WATCH_LIVE_PROFILES } from "./protocol";

/** The decoder configuration for one H.264 stream. */
export function h264DecoderConfig(
  width: number,
  height: number,
): VideoDecoderConfig {
  return {
    codec: H264_CODEC,
    codedWidth: width,
    codedHeight: height,
    optimizeForLatency: true,
    hardwareAcceleration: "no-preference",
  };
}

interface DecoderEnvironment {
  isSecureContext: boolean;
  VideoDecoder?: {
    isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
  };
}

/**
 * The Watch Live profiles this browser can consume, best first. H.264 needs
 * a secure context and a WebCodecs `VideoDecoder` that accepts the exact
 * codec, profile, and size; this is feature detection, never user-agent
 * sniffing. MJPEG is always available.
 */
export async function detectAcceptedProfiles(
  environment: DecoderEnvironment = globalThis,
): Promise<string[]> {
  const accepted: string[] = [];
  const decoder = environment.VideoDecoder;
  if (
    environment.isSecureContext &&
    typeof decoder?.isConfigSupported === "function"
  ) {
    // The decoder configuration has no frame rate: 720p30 and 720p15 ask the
    // same question, so each distinct size is asked once and answers every
    // profile that shares it.
    const answers = new Map<string, Promise<boolean>>();
    const supports = (width: number, height: number) => {
      const key = `${H264_CODEC}/${width}x${height}`;
      let answer = answers.get(key);
      if (!answer) {
        answer = decoder
          .isConfigSupported(h264DecoderConfig(width, height))
          .then((support) => support.supported === true)
          // An engine that rejects the question cannot decode the stream.
          .catch(() => false);
        answers.set(key, answer);
      }
      return answer;
    };
    for (const profile of WATCH_LIVE_PROFILES) {
      if (profile.transport !== "h264") continue;
      if (await supports(profile.maxWidth, profile.maxHeight)) {
        accepted.push(profile.id);
      }
    }
  }
  return [...accepted, ...MJPEG_PROFILE_IDS];
}

let cached: Promise<string[]> | null = null;

/** One detection per page: the answer does not change while it is open. */
export function acceptedProfiles(): Promise<string[]> {
  cached ??= detectAcceptedProfiles().catch(() => [...MJPEG_PROFILE_IDS]);
  return cached;
}

export function resetAcceptedProfilesForTests() {
  cached = null;
}
