// Where `publish` outbox rows go. Redis pub/sub implements it in slice 4 (ADR 0004); until
// then the in-memory publisher records events, which is all the tests need.
export type LiveEvent = Record<string, unknown> & { event: string; auctionId: string };

export interface Publisher {
  publish(event: LiveEvent): Promise<void>;
}

export class MemoryPublisher implements Publisher {
  readonly events: LiveEvent[] = [];

  publish(event: LiveEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
