import { type SubmitEvent, useState } from 'react';
import { type Config, type Me, api } from './api.ts';
import { CardSetup } from './CardSetup.tsx';
import { navigate } from './hooks.ts';

export function Header(props: { config: Config; me: Me | null; onChange: () => void }) {
  const { config, me, onChange } = props;
  const [login, setLogin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const devSignIn = async (e: SubmitEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.devSignIn(login.trim());
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    }
  };

  return (
    <header className="site-header">
      <a
        className="brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
      >
        Holdfast
      </a>
      <div className="account">
        {me ? (
          <>
            <span>
              Signed in as <strong>{me.user.login}</strong>
            </span>
            <button
              type="button"
              className="link"
              onClick={() => {
                void api.signOut().then(onChange);
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            {config.githubSignIn && (
              <a className="button" href="/api/auth/github">
                Sign in with GitHub
              </a>
            )}
            {config.devSignIn && (
              <form className="dev-sign-in" onSubmit={(e) => void devSignIn(e)}>
                <label htmlFor="dev-login">Dev sign-in name</label>
                <input
                  id="dev-login"
                  value={login}
                  onChange={(e) => {
                    setLogin(e.target.value);
                  }}
                  pattern="[A-Za-z0-9\-]{1,39}"
                  required
                  aria-describedby={error ? 'dev-login-error' : undefined}
                />
                <button type="submit">Sign in</button>
                {error && (
                  <span id="dev-login-error" role="alert" className="error">
                    {error}
                  </span>
                )}
              </form>
            )}
          </>
        )}
      </div>
      {me && config.cardRequired && !me.hasCard && config.stripePublishableKey && (
        <CardSetup publishableKey={config.stripePublishableKey} onSaved={onChange} />
      )}
    </header>
  );
}
