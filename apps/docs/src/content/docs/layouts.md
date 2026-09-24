---
title: Build a Layout
description: Arrange media, Widgets, playlist zones, and live text on a reusable canvas.
---

A **Layout** places content in fixed areas on a canvas. Use one to combine, for example, a notice, a live schedule, and a Playlist zone on one screen. You can use a published Layout as fullscreen content or add it to a Playlist.

## Create a Layout

1. Open **Presentations** > **Layouts**, then select **Create layout**.
2. Enter a name, choose a canvas size such as **Full HD landscape**, **Full HD portrait**, **4K landscape**, or **4K portrait**, and select **Blank canvas** or **Announcement** as the starting point.
3. Add content from the **Media**, **Widgets**, and **Playlists** sections. Select **Browse media library**, **Browse apps**, or **Browse playlists**, then add an item to the canvas. You can also add text and shapes from **Elements**.
4. Arrange and resize layers on the canvas. Select a layer to edit its settings in the inspector.
5. Select **Preview** to check the current Layout, then select **Publish** or **Submit for review**.

The Media picker can also upload an image or video; it is added to the Media library. A Playlist zone loops its Playlist independently inside the Layout. It needs a Playlist with playable content.

## Show changing values in text

Select a text layer and set **Content mode** to **Dynamic field**. Choose a Data Source and field, then set a format and optional fallback text. The Layout can bind text directly to one field; use a Widget when you need to display a repeating list of records. See [Data Sources](../data-sources/) and [Widgets](../widgets/).

## Limits to plan for

Tilecast allows only one visible video-capable placement or Playlist zone in a Layout, and only one placement or zone that emits audio. A Playlist zone runs independently, so don't add another video or audio source that would exceed those limits.

Layout edits remain a draft until you publish or submit them for review. Playlists can only use a published Layout, so an unpublished Layout edit doesn't change what is available for playback. Publish the Layout when the new version is ready.

## Next steps

- Create a [Playlist](../playlists/) or reuse one as a Layout zone.
- Add a reusable [Widget](../widgets/) or connect a [Data Source](../data-sources/).
- Coordinate Layout playback with a [Campaign](../campaigns/) or [Schedule](../schedules/).
