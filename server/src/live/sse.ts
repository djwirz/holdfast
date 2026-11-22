// One SSE connection (spec §4, ADR 0004): a snapshot (or a resume from Last-Event-ID),
// then events in strict version order. Versions go up by exactly one per accept and per
// close, so a jump means something was missed, and the connection reads the gap from
// Postgres before sending anything past it. Each client sees every version exactly once.
import type { AuctionEvent } from '@holdfast/shared';
import type { Db } from '../db/client.ts';
import type { LiveHub } from './hub.ts';
import { type Aliaser, eventsSince, snapshot } from './read.ts';

export interface SseSink {
  write(chunk: string): void;
  onClose(fn: () => void): void;
}

export interface StreamOptions {
  db: Db;
  alias: Aliaser;
  hub: Pick<LiveHub, 'watch'>;
  auctionId: string;
  viewerId: string | null;
  /** The client's Last-Event-ID, if it's resuming. */
  lastEventId: number | null;
  heartbeatMs?: number;
}

function frame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Returns false if the auction doesn't exist (nothing written). */
export async function streamAuction(sink: SseSink, options: StreamOptions): Promise<boolean> {
  const { db, alias, hub, auctionId } = options;
  let last = -1;
  let ready = false;
  let closed = false;
  const buffered: AuctionEvent[] = [];
  // Deliveries run one at a time, so a gap read can't interleave with a live batch.
  let chain = Promise.resolve();

  const send = (events: AuctionEvent[]) => {
    for (const e of events) {
      if (e.version <= last) continue;
      sink.write(frame(e.type, e.version, e));
      last = e.version;
    }
  };

  const deliver = (events: AuctionEvent[]) => {
    chain = chain.then(async () => {
      if (closed) return;
      const fresh = events.filter((e) => e.version > last);
      const first = fresh[0];
      if (!first) return;
      if (first.version !== last + 1) {
        // A gap: read everything after what this client has, from the source of truth.
        const read = await eventsSince(db, alias, auctionId, last);
        if (read) send(read.events);
      }
      send(fresh);
    });
  };

  // Watch before reading, so nothing published during the read is lost; it's buffered.
  const unwatch = hub.watch(auctionId, (events) => {
    if (ready) deliver(events);
    else buffered.push(...events);
  });
  const heartbeat = setInterval(() => {
    sink.write(': keep-alive\n\n');
  }, options.heartbeatMs ?? 15_000);
  sink.onClose(() => {
    closed = true;
    clearInterval(heartbeat);
    unwatch();
  });

  try {
    if (options.lastEventId === null) {
      const snap = await snapshot(db, alias, auctionId, options.viewerId);
      if (!snap) {
        clearInterval(heartbeat);
        unwatch();
        return false;
      }
      sink.write('retry: 2000\n\n');
      sink.write(frame('snapshot', snap.auction.version, snap));
      last = snap.auction.version;
    } else {
      const read = await eventsSince(db, alias, auctionId, options.lastEventId);
      if (!read) {
        clearInterval(heartbeat);
        unwatch();
        return false;
      }
      sink.write('retry: 2000\n\n');
      last = options.lastEventId;
      send(read.events);
    }
  } catch (e) {
    clearInterval(heartbeat);
    unwatch();
    throw e;
  }
  ready = true;
  deliver(buffered.splice(0));
  return true;
}
