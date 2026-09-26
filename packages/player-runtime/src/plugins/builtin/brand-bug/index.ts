/**
 * MIGRATION ONLY. Brand Bug / Watermark as a runtime plugin, kept in this
 * package until milestone 4 moves it to plugins/brand-bug. An ambient claim
 * on each corner that has a mark. The host lifts bottom corners clear of the
 * bottom strip; the mark only places itself inside its corner container.
 */
import {
  defineRuntimePlugin,
  element,
  setStyles,
  type SurfaceClaim,
  type SurfaceSlot,
} from "@tilecast/plugin-sdk/runtime";
import {
  tilecastBrandBug,
  type TilecastActiveBrandBug,
  type TilecastBrandBugPlugin,
} from "./resolver";

type Corner = TilecastActiveBrandBug["corner"];

const SLOTS: Record<Corner, SurfaceSlot> = {
  top_left: "corner.top-left",
  top_right: "corner.top-right",
  bottom_left: "corner.bottom-left",
  bottom_right: "corner.bottom-right",
};

interface MarkView {
  root: HTMLElement;
  logo: HTMLImageElement;
  text: HTMLElement;
}

export default defineRuntimePlugin({
  id: "brand_bug",
  tier: "ambient",
  manifestTypes: ["brand_bug"],
  surfaces: [
    "corner.top-left",
    "corner.top-right",
    "corner.bottom-left",
    "corner.bottom-right",
  ],
  create(context) {
    const views = new Map<SurfaceSlot, MarkView>();
    const marks = new Map<SurfaceSlot, TilecastActiveBrandBug>();
    /** A hidden mark keeps its last content, so its logo is never re-decoded. */
    const last = new Map<SurfaceSlot, TilecastActiveBrandBug>();

    const draw = (
      view: MarkView,
      mark: TilecastActiveBrandBug | undefined,
      shown: boolean,
    ) => {
      view.root.classList.toggle("tc-brand-bug--visible", shown);
      view.root.classList.toggle(
        "tc-brand-bug--scrim",
        mark?.backgroundStyle === "scrim",
      );
      setStyles(view.root, {
        opacity: mark ? String(mark.opacityPercent / 100) : null,
        "max-width": mark ? `${Math.max(mark.widthPercent, 12)}vw` : null,
        "--tc-brand-bug-margin": mark ? `${mark.marginPercent}vmin` : null,
      });
      if (mark?.imageSrc) {
        if (view.logo.getAttribute("src") !== mark.imageSrc) {
          view.logo.setAttribute("src", mark.imageSrc);
        }
        setStyles(view.logo, {
          width: `${mark.widthPercent}vw`,
          display: null,
        });
      } else {
        view.logo.removeAttribute("src");
        setStyles(view.logo, { width: null, display: "none" });
      }
      view.text.textContent = mark?.text ?? "";
      setStyles(
        view.text,
        mark?.text
          ? {
              color: mark.textColor,
              "font-size": `${mark.textSizePercent}vh`,
              display: null,
            }
          : { color: null, "font-size": null, display: "none" },
      );
    };

    return {
      mount(slot, container) {
        const corner = slot.slice("corner.".length);
        const root = element("div", `tc-brand-bug tc-brand-bug--${corner}`);
        root.setAttribute("aria-hidden", "true");
        const logo = element("img", "tc-brand-bug__logo");
        logo.alt = "";
        const text = element("span", "tc-brand-bug__text");
        root.append(logo, text);
        container.appendChild(root);
        const view = { root, logo, text };
        views.set(slot, view);
        draw(view, undefined, false);
      },

      update(entries) {
        marks.clear();
        const active = tilecastBrandBug.resolve(
          entries as readonly TilecastBrandBugPlugin[],
          new Date(context.clock.now()),
          0,
          context.mediaUrl,
        );
        const claims: SurfaceClaim[] = [];
        for (const mark of active) {
          const slot = SLOTS[mark.corner];
          marks.set(slot, mark);
          claims.push({ slot, priority: mark.priority });
        }
        return claims;
      },

      render(grant) {
        for (const [slot, view] of views) {
          const shown = grant.shown.has(slot) && marks.has(slot);
          const mark = shown ? marks.get(slot) : undefined;
          if (mark) last.set(slot, mark);
          draw(view, mark ?? last.get(slot), shown);
        }
      },

      describe(slot) {
        return marks.get(slot)?.text ?? "";
      },

      dispose() {
        views.clear();
      },
    };
  },
});
