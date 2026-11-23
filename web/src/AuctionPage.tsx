import { type SubmitEvent, useEffect, useRef, useState } from 'react';
import { ApiError, type Me, type OwnBid, api } from './api.ts';
import { navigate, useAuctionStream, useNow } from './hooks.ts';
import { type AuctionView, describeOutcome, money } from './live.ts';

export function AuctionPage(props: { auctionId: string; me: Me | null; canBid: boolean }) {
  const { view, connection } = useAuctionStream(props.auctionId);
  const now = useNow();

  if (connection === 'gone' && !view) {
    return (
      <main>
        <h1>Auction not found</h1>
        <p>It may have been removed, or the link is wrong.</p>
      </main>
    );
  }
  if (!view) {
    return (
      <main aria-busy="true">
        <p>Loading the auction…</p>
      </main>
    );
  }

  const { auction, currentHigh, recentBids, you } = view.snapshot;
  const open = auction.status === 'open';
  const msLeft = Date.parse(auction.endsAt) - now;

  return (
    <main className="auction">
      <h1>{auction.title}</h1>
      <p className={`connection connection-${connection}`}>
        {view.result
          ? 'Ended'
          : connection === 'live'
            ? 'Live'
            : connection === 'reconnecting'
              ? 'Reconnecting…'
              : 'Connecting…'}
      </p>

      <section className="price" aria-labelledby="price-label">
        <h2 id="price-label">{view.result ? 'Final price' : 'Current high bid'}</h2>
        <p className="amount" data-testid="current-price">
          {currentHigh ? money(currentHigh.amount) : 'No bids yet'}
        </p>
        <p className="muted">
          {currentHigh
            ? `by ${currentHigh.bidder === you ? 'you' : currentHigh.bidder}`
            : `Starting at ${money(auction.startingPrice)}`}
        </p>
        {/* Screen readers hear each change once, politely, without moving focus. */}
        <p
          className="visually-hidden"
          aria-live="polite"
          aria-atomic="true"
          data-testid="announcer"
        >
          {view.announcement}
        </p>
      </section>

      {view.result ? (
        <Result view={view} />
      ) : (
        <p className="countdown">
          {auction.status === 'scheduled'
            ? `Opens ${new Date(auction.startsAt).toLocaleString()}`
            : msLeft > 0
              ? `Ends in about ${formatDuration(msLeft)}`
              : 'Ending now…'}
          <span className="muted"> (the server’s clock decides the exact moment)</span>
        </p>
      )}

      {open && !view.result && (
        <BidForm auctionId={auction.id} view={view} me={props.me} canBid={props.canBid} />
      )}
      <p className="muted small">
        Bids count in the order they’re confirmed, not the order they’re clicked. A card that
        confirms faster can win a tie.
      </p>

      <section aria-labelledby="bids-title">
        <h2 id="bids-title">Recent bids</h2>
        {recentBids.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ol className="bids" data-testid="recent-bids">
            {recentBids.map((b) => (
              <li key={b.version}>
                <span>{money(b.amount)}</span>
                <span>{b.bidder === you ? `${b.bidder} (you)` : b.bidder}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Result({ view }: { view: AuctionView }) {
  const { result, snapshot } = view;
  if (!result) return null;
  const text =
    result.winner === null || result.amount === null
      ? 'Ended with no bids.'
      : result.winner === snapshot.you
        ? `You won, at ${money(result.amount)}.`
        : `Sold to ${result.winner} for ${money(result.amount)}.`;
  return (
    <>
      <p className="result" data-testid="result">
        {text}
      </p>
      {/* Demo auctions run in rounds: the next one opens shortly after this one ends. */}
      <p>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          See the live auctions
        </a>
      </p>
    </>
  );
}

function formatDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

const toCents = (dollars: string): number | null =>
  /^\d+(\.\d{1,2})?$/.test(dollars.trim()) ? Math.round(Number(dollars) * 100) : null;
const toDollars = (amount: number) => (amount / 100).toFixed(2);

function BidForm(props: { auctionId: string; view: AuctionView; me: Me | null; canBid: boolean }) {
  const minimum = props.view.snapshot.auction.minimumNextBid ?? 0;
  const [dollars, setDollars] = useState(toDollars(minimum));
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mine, setMine] = useState<OwnBid | null>(null);
  // One idempotency key per intended bid: a retry after a network error reuses it, so it
  // can't become a second bid or a second hold (invariant 5).
  const attempt = useRef<{ amount: number; key: string } | null>(null);

  // Follow the minimum until the bidder types their own amount.
  useEffect(() => {
    if (!edited) setDollars(toDollars(minimum));
  }, [minimum, edited]);

  if (!props.me) return <p className="notice">Sign in to bid.</p>;
  if (!props.canBid) return <p className="notice">Add a card to bid.</p>;

  const { currentHigh, you } = props.view.snapshot;
  const outbid = mine?.status === 'accepted' && currentHigh !== null && currentHigh.bidder !== you;
  const status = outbid ? describeOutcome('outbid', null) : message;

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const amount = toCents(dollars);
    if (amount === null) {
      setMessage('Enter an amount in dollars, like 55 or 55.50.');
      return;
    }
    if (attempt.current?.amount !== amount) {
      attempt.current = { amount, key: crypto.randomUUID() };
    }
    const { key } = attempt.current;
    setBusy(true);
    setMessage(null);
    try {
      let bid = await withRetry(() => api.bid(props.auctionId, amount, key));
      setMine(bid);
      setMessage(describeOutcome(bid.status, bid.reason));
      // 202: the hold is still being placed. Follow the bid until it resolves.
      for (let i = 0; bid.status === 'pending' && i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));
        bid = (await api.ownBid(bid.id)).bid;
      }
      setMine(bid);
      setMessage(describeOutcome(bid.status, bid.reason));
      attempt.current = null;
      setEdited(false);
    } catch (err) {
      if (err instanceof ApiError) {
        attempt.current = null;
        setMessage(err.status === 429 ? 'Too many bids at once; wait a few seconds.' : err.message);
      } else {
        setMessage('Network problem. Press Bid again to retry the same bid safely.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="bid-form" onSubmit={(e) => void submit(e)} aria-labelledby="bid-title">
      <h2 id="bid-title">Place a bid</h2>
      <label htmlFor="bid-amount">Your bid in dollars (minimum {money(minimum)})</label>
      <div className="row">
        <span aria-hidden="true">$</span>
        <input
          id="bid-amount"
          inputMode="decimal"
          autoComplete="off"
          value={dollars}
          onChange={(e) => {
            setDollars(e.target.value);
            setEdited(true);
          }}
          aria-describedby="bid-status"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Bidding…' : 'Bid'}
        </button>
      </div>
      <p id="bid-status" role="status" data-testid="bid-status">
        {status}
      </p>
    </form>
  );
}

/** Retries only network failures, never an answer from the server. */
async function withRetry(call: () => Promise<{ bid: OwnBid }>): Promise<OwnBid> {
  for (let i = 0; ; i++) {
    try {
      return (await call()).bid;
    } catch (e) {
      if (e instanceof ApiError || i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}
