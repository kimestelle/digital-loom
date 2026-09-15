const INACTIVE_ANCESTOR =
  '[inert], [hidden], [data-cabinet-face][data-active="false"], .room-light-modal[data-open="false"]';

type ActivityListener = (active: boolean) => void;

interface HostActivity {
  intersecting: boolean;
  active: boolean;
  listeners: Set<ActivityListener>;
}

/** One visibility observer for all companion pixels, including portalled rails.
 * Intersection handles viewport/scroll clipping; mounted inactive cabinet faces
 * need their explicit state as well, since a backface can still intersect. */
export class PixelPlayActivity {
  private hosts = new Map<HTMLElement, HostActivity>();
  private intersection?: IntersectionObserver;
  private mutations?: MutationObserver;

  observe(host: HTMLElement, listener: ActivityListener): () => void {
    if (this.hosts.size === 0) this.connect();
    let state = this.hosts.get(host);
    if (!state) {
      // Wait for the first measured intersection. Older hosts without the API
      // retain animation, with explicit inactive ancestry still respected.
      const intersecting = !this.intersection;
      state = {
        intersecting,
        active: intersecting && !host.closest(INACTIVE_ANCESTOR),
        listeners: new Set(),
      };
      this.hosts.set(host, state);
      this.intersection?.observe(host);
    }
    state.listeners.add(listener);
    listener(state.active);

    return () => {
      const current = this.hosts.get(host);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        this.intersection?.unobserve(host);
        this.hosts.delete(host);
      }
      if (this.hosts.size === 0) {
        this.intersection?.disconnect();
        this.mutations?.disconnect();
        this.intersection = undefined;
        this.mutations = undefined;
      }
    };
  }

  private publish(host: HTMLElement, state: HostActivity): void {
    const active = state.intersecting && !host.closest(INACTIVE_ANCESTOR);
    if (state.active === active) return;
    state.active = active;
    for (const listener of state.listeners) listener(active);
  }

  private connect(): void {
    if (typeof IntersectionObserver !== "undefined") {
      const intersection = new IntersectionObserver(entries => {
        if (this.intersection !== intersection) return;
        for (const entry of entries) {
          const host = entry.target as HTMLElement;
          const state = this.hosts.get(host);
          if (!state) continue;
          state.intersecting = entry.isIntersecting
            && entry.intersectionRect.width > 0
            && entry.intersectionRect.height > 0;
          this.publish(host, state);
        }
      }, { threshold: [0, 0.000001] });
      this.intersection = intersection;
    }
    this.mutations = new MutationObserver(records => {
      for (const [host, state] of this.hosts) {
        if (records.some(record => record.target.contains(host))) {
          this.publish(host, state);
        }
      }
    });
    this.mutations.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      // Do not observe styles: daylight publishes them continuously. Ordinary
      // selection changes below a host cannot change its activity either.
      attributeFilter: ["inert", "hidden", "data-active", "data-open"],
    });
  }
}
