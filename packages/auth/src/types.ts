import type { DB } from "@better-auth/drizzle-adapter";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import type { OAuthProxyOptions } from "better-auth/plugins/oauth-proxy";

export interface DeviceAuthorizationConfig {
  clientIds: string[];
  verificationUri?: string;
}

export interface OAuthProviderConfig {
  providerId: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

export interface OAuthProxyConfig extends OAuthProxyOptions {
  enabled: boolean;
  currentURL: string;
  productionURL: string;
}

export interface CreateDetentAuthOptions {
  appName?: string;
  baseURL?: string;
  secret?: string;
  database: DB;
  trustedOrigins?: string[];
  oauthProviders: GenericOAuthConfig[];
  apiKeyHeaders?: string[];
  enableJwt?: boolean;
  oauthProxy?: OAuthProxyConfig;
  deviceAuthorization?: DeviceAuthorizationConfig;
}

export interface DetentAuthEnv {
  NODE_ENV?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  BETTER_AUTH_GITHUB_CLIENT_ID?: string;
  BETTER_AUTH_GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_GITHUB_SCOPES?: string;
  BETTER_AUTH_GITHUB_AUTHORIZATION_URL?: string;
  BETTER_AUTH_GITHUB_TOKEN_URL?: string;
  BETTER_AUTH_GITHUB_USER_INFO_URL?: string;
  BETTER_AUTH_ENABLE_JWT?: string;
  BETTER_AUTH_OAUTH_PROXY_ENABLED?: string;
  BETTER_AUTH_OAUTH_PROXY_CURRENT_URL?: string;
  BETTER_AUTH_OAUTH_PROXY_PRODUCTION_URL?: string;
  BETTER_AUTH_DEVICE_CLIENT_IDS?: string;
  BETTER_AUTH_DEVICE_VERIFICATION_URI?: string;
}
