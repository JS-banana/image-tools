/** A task may publish only while its owning selection/lifecycle is current. */
export interface TaskTicket {
  isCurrent(): boolean;
}

export class TaskScope {
  private version = 0;

  capture(): TaskTicket {
    const version = this.version;
    return { isCurrent: () => version === this.version };
  }

  next(): TaskTicket {
    this.invalidate();
    return this.capture();
  }

  /** Invalidate pending success, failure and progress callbacks together. */
  invalidate(): void {
    this.version += 1;
  }
}
