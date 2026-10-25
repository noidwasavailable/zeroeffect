import { Context, Effect, Layer } from "effect";
import { GmailApiError } from "../../shared/errors";

export const GMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
] as const;

export const PUBSUB_OAUTH_SCOPES = ["https://www.googleapis.com/auth/pubsub"] as const;
export type GoogleOAuthPurpose = "gmail" | "pubsub";

export interface GoogleOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly tokenType?: string;
  readonly scope?: string;
}

export interface GoogleOAuth2Api {
  readonly authorizationUrl: (accountId: string, state: string, purpose?: GoogleOAuthPurpose) => URL;
  readonly exchangeCode: (accountId: string, code: string) => Effect.Effect<{ readonly accountId: string; readonly tokens: GoogleOAuthTokens }, GmailApiError>;
  readonly refreshAccessToken: (accountId: string, refreshToken: string) => Effect.Effect<{ readonly accountId: string; readonly tokens: GoogleOAuthTokens }, GmailApiError>;
}

export class GoogleOAuth2 extends Context.Service<GoogleOAuth2, GoogleOAuth2Api>()(
  "zeroeffect/GoogleOAuth2",
) {}

export interface GoogleOAuth2Config {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export const GoogleOAuth2Live = (config: GoogleOAuth2Config): Layer.Layer<GoogleOAuth2> =>
  Layer.succeed(GoogleOAuth2, makeOAuth2(config));

export const GoogleOAuth2Test = GoogleOAuth2Live;

const makeOAuth2 = (config: GoogleOAuth2Config): GoogleOAuth2Api => {
  const authorizationEndpoint = config.authorizationEndpoint ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenEndpoint = config.tokenEndpoint ?? "https://oauth2.googleapis.com/token";
  const fetcher = config.fetch ?? globalThis.fetch;
  const authorizationUrl = (accountId: string, state: string, purpose: GoogleOAuthPurpose = "gmail"): URL => {
    validateAccountId(accountId);
    if (!state || /[\r\n]/.test(state)) throw new Error("OAuth state must be a non-empty, single-line value.");
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: (purpose === "pubsub" ? PUBSUB_OAUTH_SCOPES : GMAIL_OAUTH_SCOPES).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: `${accountId}:${state}`,
    }).toString();
    return url;
  };

  const tokenRequest = (accountId: string, body: URLSearchParams) => Effect.tryPromise({
    try: async () => {
      validateAccountId(accountId);
      const response = await fetcher(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* handled as a typed OAuth error below */ }
      if (!response.ok || typeof data.access_token !== "string") {
        throw new GmailApiError({
          message: `Google OAuth token request failed (${response.status}): ${text.slice(0, 500)}`,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      return {
        accountId,
        tokens: {
          accessToken: data.access_token,
          ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
          ...(typeof data.expires_in === "number" ? { expiresIn: data.expires_in } : {}),
          ...(typeof data.token_type === "string" ? { tokenType: data.token_type } : {}),
          ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
        },
      };
    },
    catch: (cause) => cause instanceof GmailApiError
      ? cause
      : new GmailApiError({ message: `Google OAuth request failed: ${String(cause)}`, status: 0, retryable: true }),
  });

  return {
    authorizationUrl,
    exchangeCode: (accountId, code) => tokenRequest(accountId, new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    })),
    refreshAccessToken: (accountId, refreshToken) => tokenRequest(accountId, new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    })),
  };
};

const validateAccountId = (accountId: string): void => {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("Invalid account ID.");
};
