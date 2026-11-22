import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type AuctionSummary, type Config, type Me, api } from './api.ts';
import { AuctionPage } from './AuctionPage.tsx';
import { Header } from './Header.tsx';
import { navigate, usePath } from './hooks.ts';
import { money } from './live.ts';
import './styles.css';

function App() {
  const path = usePath();
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([api.config(), api.me()]).then(
      ([c, m]) => {
        setConfig(c);
        setMe(m);
      },
      () => {
        setError('The server isn’t answering. Try again in a moment.');
      },
    );
  }, []);
  useEffect(refresh, [refresh]);

  if (error) {
    return (
      <main>
        <p role="alert">{error}</p>
      </main>
    );
  }
  if (!config) return <main aria-busy="true" />;

  const auctionId = /^\/auctions\/([0-9a-f-]{36})$/.exec(path)?.[1];
  const canBid = Boolean(me) && (!config.cardRequired || Boolean(me?.hasCard));
  return (
    <>
      <Header config={config} me={me} onChange={refresh} />
      {auctionId ? (
        // Keyed by who's signed in, so the stream restarts and the snapshot says which
        // alias is yours.
        <AuctionPage
          key={`${auctionId}:${me?.user.login ?? ''}`}
          auctionId={auctionId}
          me={me}
          canBid={canBid}
        />
      ) : (
        <Home />
      )}
    </>
  );
}

function Home() {
  const [auctions, setAuctions] = useState<AuctionSummary[] | null>(null);
  useEffect(() => {
    void api.auctions().then((r) => {
      setAuctions(r.auctions);
    });
  }, []);
  return (
    <main>
      <h1>Auctions</h1>
      <p>
        Live auctions where a bid counts only once a card hold covers it. Stripe test mode: no real
        money moves.
      </p>
      {auctions === null ? (
        <p aria-busy="true">Loading…</p>
      ) : auctions.length === 0 ? (
        <p>No auctions right now.</p>
      ) : (
        <ul className="auction-list">
          {auctions.map((a) => (
            <li key={a.id}>
              <a
                href={`/auctions/${a.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/auctions/${a.id}`);
                }}
              >
                {a.title}
              </a>
              <span className={`status status-${a.status}`}>{a.status}</span>
              <span>{a.currentHigh === null ? 'no bids' : money(a.currentHigh)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
