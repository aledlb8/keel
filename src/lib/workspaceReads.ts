/** Coalesce reads within one project visit; ignore completions after leaving it. */
export class WorkspaceReads {
  private version = 0;
  private pending = new Map<string, Promise<void>>();

  reset() {
    this.version += 1;
    this.pending.clear();
  }

  run(
    key: string,
    work: (isCurrent: () => boolean) => Promise<void>,
    afterPending = false,
  ): Promise<void> {
    const version = this.version;
    const isCurrent = () => version === this.version;
    const existing = this.pending.get(key);
    if (existing) {
      // A mutation needs a fresh read after any pre-mutation poll finishes.
      return afterPending
        ? existing.then(() => isCurrent() ? this.run(key, work) : undefined)
        : existing;
    }
    const request = Promise.resolve().then(async () => {
      if (isCurrent()) await work(isCurrent);
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
}
