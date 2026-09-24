---
title: Build a Playlist
description: Arrange media, Widgets, and published Layouts for fullscreen playback.
---

A **Playlist** defines fullscreen content in playback order. A standard Playlist plays its items from top to bottom, then loops. Create one when you want to choose the sequence yourself, or use a Tag-driven Playlist to include matching Ready media automatically.

## Create a standard Playlist

1. Open **Presentations** > **Playlists**, then select **Create playlist**.
2. Enter a name, choose **Standard playlist**, and select **Create playlist**.
3. Use **Add content** to choose Ready images, videos, or Widgets. Select **Add Layout** to include a published Layout.
4. Reorder items in the timeline. Select an item to change its duration, fit, transition, audio, delivery, or availability settings in the **Inspector**.
5. Select **Preview** to review the sequence, then select **Publish** or **Submit for review**.

Changes to a draft don't change the published Playlist. If your role and the content review policy don't allow direct publication, submit the draft; it becomes live after approval. A Layout added to a Playlist must already be published. It plays fullscreen for 30 seconds by default, which you can change in the item Inspector.

## Create a Tag-driven Playlist

Choose **Tag-driven playlist** when the Playlist should follow media labels instead of a hand-maintained timeline.

1. Create a Playlist and choose **Tag-driven playlist**.
2. Open **Playlist details** and select **Content source**.
3. Select one or more **Media tags** and choose whether the source should match **Any selected tag** or **All selected tags**.
4. Set the **Image duration**, then select **Save content source**.
5. Preview and publish the Playlist, or submit it for review.

The generated timeline contains Ready media that currently matches the selected tags. Its items aren't manually ordered. Add or change Tags on assets to change which media matches; edit the source rule to change the matching behavior.

## Playback details

- An item that isn't Ready is skipped until its media is available.
- Item settings can use Player defaults or override fit, transition, audio, volume, delivery, duration, and availability for that item.
- **Crossfade** blends the visuals. Audio still changes at the normal item boundary.
- Adding the same Playlist to a schedule or Campaign is a separate step. See [Schedules](../schedules/) and [Campaigns](../campaigns/).

Deleting a Playlist can't be undone. Screens assigned to it fall back to their default content.

## Next steps

- Upload and organize [media](../media/).
- Create reusable [Widgets](../widgets/) or [Layouts](../layouts/).
- Put a Playlist on a calendar with [Schedules](../schedules/) or a [Campaign](../campaigns/).
