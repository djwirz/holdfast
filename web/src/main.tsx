// Placeholder until slice 4 builds the auction page. It imports from @holdfast/shared so
// the workspace wiring is exercised by typecheck, lint and build from the start.
import { cents, formatCents } from '@holdfast/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main>
      <h1>Holdfast</h1>
      <p>Live auctions where a bid counts only once a card hold covers it.</p>
      <p>Bids start from {formatCents(cents(1_500))} in the demo.</p>
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
