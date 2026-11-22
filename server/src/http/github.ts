// GitHub sign-in (spec §9): the two OAuth web-flow calls, behind an interface so tests
// can stand in for GitHub. Only the public profile is read; no scopes are requested.
export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHub {
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchange the callback's code for an access token. */
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  user(accessToken: string): Promise<GitHubUser>;
}

export function gitHubOAuth(clientId: string, clientSecret: string): GitHub {
  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode(code, redirectUri) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!res.ok || !body.access_token) {
        throw new Error(`github token exchange failed: ${body.error ?? String(res.status)}`);
      }
      return body.access_token;
    },
    async user(accessToken) {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'holdfast',
        },
      });
      if (!res.ok) throw new Error(`github user lookup failed: ${String(res.status)}`);
      const body = (await res.json()) as { id: number; login: string };
      return { id: body.id, login: body.login };
    },
  };
}
