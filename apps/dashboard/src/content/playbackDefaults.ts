/** Map Studio's settings document to the PlayerConfig playback shape. */
export function playbackDefaultsFromSettings(
  values: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!values) return {};
  return {
    defaultFitMode: values["player.playback.default_fit_mode"],
    defaultVolume: values["player.playback.default_volume"],
    defaultImageDurationSeconds:
      values["player.playback.default_image_duration_seconds"],
    defaultTransition: values["player.playback.default_transition"],
    defaultAudioEnabled: values["player.playback.default_audio_enabled"],
  };
}
