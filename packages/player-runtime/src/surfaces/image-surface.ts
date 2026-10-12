/** A still image: shown once it has loaded, optionally cropped to a viewport. */
import type { RuntimeItem } from "../host/contract";
import { objectFit } from "../engine/model";
import type { MediaSurface } from "./surface";

export class ImageSurface implements MediaSurface {
  readonly element: HTMLElement;
  private readonly img: HTMLImageElement;
  private disposed = false;

  constructor(private readonly item: RuntimeItem) {
    const img = document.createElement("img");
    img.alt = "";
    img.style.objectFit = objectFit(item.fitMode);
    this.img = img;
    const viewport = item.viewport;
    if (!viewport) {
      this.element = img;
      return;
    }
    // A Span wall shows this screen's slice of one larger canvas.
    const frame = document.createElement("div");
    frame.style.position = "relative";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.overflow = "hidden";
    img.style.position = "absolute";
    img.style.left = `${(-viewport.x / viewport.width) * 100}%`;
    img.style.top = `${(-viewport.y / viewport.height) * 100}%`;
    img.style.width = `${(viewport.canvasWidth / viewport.width) * 100}%`;
    img.style.height = `${(viewport.canvasHeight / viewport.height) * 100}%`;
    if (viewport.rotation) {
      img.style.transformOrigin = "top left";
      img.style.transform = `rotate(${viewport.rotation}deg)`;
    }
    frame.appendChild(img);
    this.element = frame;
  }

  prepare(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.img.onload = () => {
        if (this.disposed) return;
        // Loaded is not painted: a large image decodes lazily on first paint,
        // and a layer swapped in before then dissolves in as blank black. A
        // failed decode is not a failed image, so the swap goes ahead.
        const ready = () => {
          if (!this.disposed) resolve();
        };
        if (typeof this.img.decode === "function") {
          this.img.decode().then(ready, ready);
        } else {
          ready();
        }
      };
      this.img.onerror = () => {
        if (!this.disposed) reject(new Error("image failed to load"));
      };
      this.img.src = this.item.src;
    });
  }

  activate(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {}

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.img.onload = null;
    this.img.onerror = null;
  }
}
