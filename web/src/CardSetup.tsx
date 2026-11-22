// Saving a card for bids (spec §5). The card form is Stripe's own CardElement, in an
// iframe, so card numbers go from the browser to Stripe and never touch our server. It's
// card-only on purpose: the Payment Element offers every method the account enables
// (bank debits, wallets), and only a card can carry an off-session hold for a bid.
// confirmCardSetup runs 3-D Secure if the card asks for it during setup.
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { type Stripe, loadStripe } from '@stripe/stripe-js';
import { type SubmitEvent, useMemo, useState } from 'react';
import { api } from './api.ts';

export function CardSetup(props: { publishableKey: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const stripe = useMemo<Promise<Stripe | null>>(
    () => loadStripe(props.publishableKey),
    [props.publishableKey],
  );

  return (
    <section className="card-setup" aria-labelledby="card-setup-title">
      <h2 id="card-setup-title">Add a card to bid</h2>
      <p>
        Each bid places a hold on your card for its amount. Holds that don’t win are released. Test
        mode: use Stripe’s test card 4242 4242 4242 4242, any future date and any CVC.
      </p>
      {open ? (
        <Elements stripe={stripe}>
          <CardForm onSaved={props.onSaved} />
        </Elements>
      ) : (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Add a card
        </button>
      )}
    </section>
  );
}

function CardForm(props: { onSaved: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const card = elements?.getElement(CardElement);
    if (!stripe || !card) return;
    setBusy(true);
    setError(null);
    try {
      const { clientSecret } = await api.startCardSetup();
      const result = await stripe.confirmCardSetup(clientSecret, { payment_method: { card } });
      if (result.error) {
        setError(result.error.message ?? 'the card could not be saved');
        setBusy(false);
        return;
      }
      // The server checks Stripe's record of this setup before saving anything.
      await api.finishCardSetup(result.setupIntent.id);
      props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the card could not be saved');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-describedby={error ? 'card-error' : undefined}>
      <div className="card-field">
        <CardElement options={{ hidePostalCode: false }} />
      </div>
      <button type="submit" disabled={!stripe || busy}>
        {busy ? 'Saving…' : 'Save card'}
      </button>
      {error && (
        <p id="card-error" role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
