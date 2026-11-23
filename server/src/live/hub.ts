// Fan-out across instances (ADR 0004). Redis pub/sub is the doorbell: a message on
// `auction:<id>` means "that auction changed". The events themselves are always read from
// Postgres, so a lost, late or duplicated Redis message can only delay an update, never
// drop, reorder or invent one. A slow poll covers lost doorbells and Redis being down.
import type { AuctionEvent } from '@holdfast/shared';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.ts';
import { contextFrom, currentTraceparent, inSpan } from '../observability.ts';
import type { LiveEvent, Publisher } from '../outbox/publisher.ts';
import { type Aliaser, eventsSince } from './read.ts';

const CHANNEL_PREFIX = 'auction:';

/** The outbox's `publish` rows ring the doorbell for their auction. */
export class RedisPublisher implements Publisher {
  private readonly redis: Pick<Redis, 'publish'>;

  constructor(redis: Pick<Redis, 'publish'>) {
    this.redis = redis;
  }

  async publish(event: LiveEvent): Promise<void> {
    // A failure here leaves the outbox row to retry with backoff.
    // The doorbell carries the trace on (spec §8), so the fan-out on every instance joins it.
    await this.redis.publish(
      `${CHANNEL_PREFIX}${event.auctionId}`,
      JSON.stringify({ version: event['version'], traceparent: currentTraceparent() }),
    );
  }
}

export type Listener = (events: AuctionEvent[]) => void;

interface Feed {
  /** The highest version this instance has broadcast for the auction. */
  last: number;
  listeners: Set<Listener>;
  running: Promise<void> | null;
  again: boolean;
}

export interface LiveHubOptions {
  db: Db;
  alias: Aliaser;
  /** A dedicated connection (subscribe mode); null runs on polling alone. */
  subscriber: Redis | null;
  /** How often a watched auction is re-read even without a doorbell. */
  pollMs?: number;
  onError?: (e: unknown) => void;
}

export class LiveHub {
  private readonly feeds = new Map<string, Feed>();
  private readonly timer: NodeJS.Timeout;
  private readonly options: Required<Omit<LiveHubOptions, 'subscriber'>> & {
    subscriber: Redis | null;
  };

  constructor(options: LiveHubOptions) {
    this.options = { pollMs: 2_000, onError: () => undefined, ...options };
    const { subscriber } = options;
    if (subscriber) {
      subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
        const auctionId = channel.slice(CHANNEL_PREFIX.length);
        let traceparent: unknown = null;
        try {
          traceparent = (JSON.parse(message) as { traceparent?: unknown }).traceparent;
        } catch {
          // An older or foreign message: still a doorbell, just untraced.
        }
        if (traceparent) {
          void inSpan(
            'live.fanout',
            { 'auction.id': auctionId },
            async () => {
              this.ring(auctionId);
              await this.feeds.get(auctionId)?.running;
            },
            contextFrom(traceparent),
          );
        } else {
          this.ring(auctionId);
        }
      });
      // After a reconnect, anything published while Redis was away was missed: re-read all.
      subscriber.on('ready', () => {
        this.ringAll();
      });
      subscriber.psubscribe(`${CHANNEL_PREFIX}*`).catch(this.options.onError);
    }
    this.timer = setInterval(() => {
      this.ringAll();
    }, this.options.pollMs);
    this.timer.unref();
  }

  /** Watch an auction; returns the unsubscribe. */
  watch(auctionId: string, listener: Listener): () => void {
    let feed = this.feeds.get(auctionId);
    if (!feed) {
      // -1 until the first read: every connection catches up on its own anyway (see sse.ts).
      feed = { last: -1, listeners: new Set(), running: null, again: false };
      this.feeds.set(auctionId, feed);
      this.ring(auctionId);
    }
    feed.listeners.add(listener);
    return () => {
      feed.listeners.delete(listener);
      if (feed.listeners.size === 0) this.feeds.delete(auctionId);
    };
  }

  /** Re-read one auction now: one query per instance, however many clients watch it. */
  ring(auctionId: string): void {
    const feed = this.feeds.get(auctionId);
    if (!feed) return;
    if (feed.running) {
      feed.again = true;
      return;
    }
    feed.running = this.refresh(auctionId, feed)
      .catch(this.options.onError)
      .finally(() => {
        feed.running = null;
        if (feed.again) {
          feed.again = false;
          this.ring(auctionId);
        }
      });
  }

  private ringAll(): void {
    for (const id of this.feeds.keys()) this.ring(id);
  }

  private async refresh(auctionId: string, feed: Feed): Promise<void> {
    const since = feed.last;
    const read = await eventsSince(
      this.options.db,
      this.options.alias,
      auctionId,
      Math.max(since, 0),
    );
    if (!read) return;
    if (since === -1) {
      // First read: start from now. Connections send their own history.
      feed.last = read.version;
      return;
    }
    if (read.events.length === 0) return;
    feed.last = read.events.at(-1)?.version ?? feed.last;
    for (const listener of feed.listeners) listener(read.events);
  }

  /** For tests and shutdown: wait for reads in flight. */
  async idle(): Promise<void> {
    await Promise.all([...this.feeds.values()].flatMap((f) => (f.running ? [f.running] : [])));
  }

  close(): void {
    clearInterval(this.timer);
    this.feeds.clear();
  }
}
