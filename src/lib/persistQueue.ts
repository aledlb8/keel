/** Serialize snapshots: an older disk write must never replace a newer chat ID. */
export class PersistQueue<T> {
  private tail: Promise<void> | undefined;

  private readonly save: (document: T) => Promise<void>;

  constructor(save: (document: T) => Promise<void>) { this.save = save; }

  enqueue(document: T): Promise<void> {
    // Start the first write immediately; later writes wait even if it fails.
    const operation = this.tail
      ? this.tail.catch(() => {}).then(() => this.save(document))
      : this.save(document);
    this.tail = operation;
    void operation.finally(() => {
      if (this.tail === operation) this.tail = undefined;
    }).catch(() => {});
    return operation;
  }
}
