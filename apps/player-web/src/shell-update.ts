/**
 * Every Browser Player slot shares one service worker registration, so when
 * one page activates a waiting worker, `clients.claim()` moves all of them to
 * it at once. A page that is playing must not reload then, and it will not
 * see that event again. Each page therefore records the takeover and reloads
 * the next time its own screen rests.
 */
type Container = Pick<
  ServiceWorkerContainer,
  "addEventListener" | "removeEventListener"
>;

export class ShellUpdate {
  private activated = false;
  private listener: (() => void) | undefined;

  constructor(
    private readonly container: Container,
    private readonly resting: () => boolean,
    private readonly reload: () => void,
  ) {}

  /** Call only after the page has its first controller; later changes are updates. */
  watch(): void {
    if (this.listener) return;
    this.listener = () => {
      this.activated = true;
      this.settle();
    };
    this.container.addEventListener("controllerchange", this.listener);
  }

  /** Reloads once a takeover has happened and the screen rests. */
  settle(): void {
    if (this.activated && this.resting()) this.reload();
  }

  stop(): void {
    if (this.listener)
      this.container.removeEventListener("controllerchange", this.listener);
    this.listener = undefined;
  }
}
