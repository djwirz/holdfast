import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { type AuctionView, type StreamMessage, apply } from './live.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'gone';

/**
 * The auction's live view over SSE. EventSource reconnects on its own and sends the last
 * event id, so the server resumes from Postgres; the reducer drops anything already seen.
 */
export function useAuctionStream(auctionId: string): {
  view: AuctionView | null;
  connection: Connection;
} {
  const [view, dispatch] = useReducer(apply, null);
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    const source = new EventSource(`/api/auctions/${auctionId}/events`);
    const on = (type: string, toMessage: (data: unknown) => StreamMessage) => {
      source.addEventListener(type, (e: MessageEvent<string>) => {
        dispatch(toMessage(JSON.parse(e.data) as unknown));
      });
    };
    on('snapshot', (data) => ({ type: 'snapshot', snapshot: data as never }));
    on('bid.accepted', (data) => data as StreamMessage);
    on('auction.closed', (data) => data as StreamMessage);
    source.onopen = () => {
      setConnection('live');
    };
    source.onerror = () => {
      // CLOSED means the server refused (e.g. no such auction); otherwise it's retrying.
      setConnection(source.readyState === EventSource.CLOSED ? 'gone' : 'reconnecting');
    };
    return () => {
      source.close();
    };
  }, [auctionId]);

  return { view, connection };
}

/** The current path, kept in step with pushState navigation and the back button. */
export function usePath(): string {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('popstate', notify);
      return () => {
        window.removeEventListener('popstate', notify);
      };
    },
    () => window.location.pathname,
  );
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The time now, ticking each second, for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}
