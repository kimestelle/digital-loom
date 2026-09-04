/**
 * Monotonic revisions for durable resources such as one material preset or the
 * library order. A failed write may be retried only while its token is current;
 * reserving a newer token permanently supersedes the older closure.
 */
export interface SaveRevision {
  key: string;
  revision: number;
}

export class SaveRevisionRegistry {
  private readonly revisions = new Map<string, number>();

  reserve(key: string): SaveRevision {
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return { key, revision };
  }

  isCurrent(token: SaveRevision): boolean {
    return this.revisions.get(token.key) === token.revision;
  }
}
