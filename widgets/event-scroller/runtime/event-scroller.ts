import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
  ClockController,
  emptyState,
  formatTime,
  formatWidgetValue,
  TilecastWidgetElement,
} from "@tilecast/widget-kit";
import {
  scrollerDate,
  scrollDurationSeconds,
  visibleScrollerEvents,
  type EventScrollerConfig,
  type EventScrollerData,
  type ScrollerEvent,
} from "./events.ts";
import { eventScrollerStyles } from "./styles.ts";

export class TilecastEventScrollerWidget extends TilecastWidgetElement<
  EventScrollerConfig,
  EventScrollerData
> {
  private readonly clock = new ClockController(this, {
    granularity: () => "minute",
    nextBoundary: (now) =>
      this.config?.hideEnded
        ? (this.data?.events.reduce<number | null>((next, event) => {
            const end = event.end?.day === null ? event.end.ms : null;
            return end !== null && end > now && (next === null || end < next)
              ? end
              : next;
          }, null) ?? null)
        : null,
  });
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    eventScrollerStyles,
  ];

  protected override themeOverrides(config: EventScrollerConfig) {
    return {
      background: config.background,
      foreground: config.foreground,
      accent: config.accent,
    };
  }
  private visible(): readonly ScrollerEvent[] {
    return this.data
      ? visibleScrollerEvents(
          this.data,
          this.config,
          this.clock.now,
          this.context.timeZone,
        )
      : [];
  }
  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    // Runtime CSP permits CSSOM properties, but refuses inline style attributes.
    this.style.setProperty(
      "--tc-event-seconds",
      `${scrollDurationSeconds(this.visible().length, this.config.scrollSpeed)}s`,
    );
    this.style.setProperty(
      "--tc-event-horizontal-reverse",
      this.config.horizontalDirection === "right" ? "reverse" : "normal",
    );
  }
  protected override presentationState() {
    if (this.empty !== null)
      return { state: "empty" as const, reason: this.empty };
    return this.visible().length
      ? { state: "ready" as const }
      : { state: "empty" as const, reason: "no_records" };
  }
  protected override renderEmpty(reason: string): TemplateResult {
    return this.config.emptyText
      ? emptyState({ title: this.config.emptyText })
      : super.renderEmpty(reason);
  }
  protected override renderContent(): TemplateResult {
    const events = this.visible();
    if (!events.length) return this.renderEmpty("no_records");
    const config = this.config;
    const still = this.context.motion.reduced || !config.scrolling;
    const rows = () =>
      events.map((event) => {
        const cell = (key: string) =>
          formatWidgetValue(
            event.values[key],
            this.data?.fields[key],
            this.context,
          ).trim();
        const date = scrollerDate(event, config, this.context);
        const time =
          config.showTime && event.start.day === null
            ? formatTime(event.start.ms, this.context)
            : "";
        const location = config.showLocation ? cell(config.locationField) : "";
        const category = config.showCategory ? cell(config.categoryField) : "";
        return html`<div class="row" role="listitem" data-event-id=${event.id}>
          ${date ? html`<span class="date">${date}</span>` : nothing}
          <span class="title">${cell(config.titleField)}</span>
          ${location ? html`<span class="location">${location}</span>` : nothing}
          ${category ? html`<span class="category">${category}</span>` : nothing}
          ${time ? html`<span class="time">${time}</span>` : nothing}
          <span class="separator" aria-hidden="true">•</span>
        </div>`;
      });
    return html`<div
      class="board"
      data-flow=${config.flow}
      data-density=${config.density}
      data-vertical-direction=${config.verticalDirection}
      ?data-dividers=${config.showDividers}
      ?data-still=${still}
    >
      ${config.heading ? html`<div class="heading">${config.heading}</div>` : nothing}
      <div class="viewport">
        <div class="track">
          <div class="group" role="list">${rows()}</div>
          ${still ? nothing : html`<div class="group" aria-hidden="true">${rows()}</div>`}
        </div>
      </div>
    </div>`;
  }
}
