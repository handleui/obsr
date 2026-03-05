import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { jwt } from "better-auth/plugins/jwt";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { organization } from "better-auth/plugins/organization";
// biome-ignore lint/performance/noNamespaceImport: Better Auth drizzle adapter accepts schema namespace object
import * as authSchema from "./auth-schema.js";
import type { CreateDetentAuthOptions, DetentAuthEnv } from "./types.js";

const DEFAULT_GITHUB_AUTHORIZATION_URL =
  "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_USER_INFO_URL = "https://api.github.com/user";
const DEFAULT_GITHUB_SCOPES = ["read:user", "user:email", "read:org"];
const DEFAULT_API_KEY_HEADERS = ["x-api-key", "x-detent-token"];

const parseCsv = (input: string | undefined): string[] =>
  input
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

const isTrue = (value: string | undefined): boolean =>
  value === "true" || value === "1";

const required = (value: string | undefined, key: string): string => {
  if (!value) {
    throw new Error(`Missing required Better Auth env var: ${key}`);
  }
  return value;
};

const normalizeApiKeyHeaders = (headers: string[] | undefined): string[] => {
  const values = headers ?? DEFAULT_API_KEY_HEADERS;
  const normalized = values
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized)];
};

export const createDetentAuth = (options: CreateDetentAuthOptions) => {
  const plugins: NonNullable<Parameters<typeof betterAuth>[0]["plugins"]> = [
    genericOAuth({
      config: options.oauthProviders,
    }),
    organization(),
    apiKey({
      apiKeyHeaders: normalizeApiKeyHeaders(options.apiKeyHeaders),
    }),
    bearer(),
  ];

  if (options.enableJwt) {
    plugins.push(jwt());
  }

  if (options.oauthProxy?.enabled) {
    plugins.push(
      oAuthProxy({
        currentURL: options.oauthProxy.currentURL,
        productionURL: options.oauthProxy.productionURL,
      })
    );
  }

  return betterAuth({
    appName: options.appName ?? "Detent",
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    account: {
      accountLinking: {
        enabled: true,
      },
    },
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: authSchema,
    }),
    plugins,
  });
};

export const createDetentAuthFromEnv = (
  env: DetentAuthEnv,
  database: CreateDetentAuthOptions["database"]
) => {
  const scopes = parseCsv(env.BETTER_AUTH_GITHUB_SCOPES);
  const oauthProxyEnabled = isTrue(env.BETTER_AUTH_OAUTH_PROXY_ENABLED);

  if (oauthProxyEnabled && env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_OAUTH_PROXY_ENABLED must be disabled in production"
    );
  }

  return createDetentAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: parseCsv(env.BETTER_AUTH_TRUSTED_ORIGINS),
    database,
    apiKeyHeaders: DEFAULT_API_KEY_HEADERS,
    enableJwt: isTrue(env.BETTER_AUTH_ENABLE_JWT),
    oauthProviders: [
      {
        providerId: "github",
        clientId: required(
          env.BETTER_AUTH_GITHUB_CLIENT_ID,
          "BETTER_AUTH_GITHUB_CLIENT_ID"
        ),
        clientSecret: required(
          env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
          "BETTER_AUTH_GITHUB_CLIENT_SECRET"
        ),
        authorizationUrl:
          env.BETTER_AUTH_GITHUB_AUTHORIZATION_URL ??
          DEFAULT_GITHUB_AUTHORIZATION_URL,
        tokenUrl: env.BETTER_AUTH_GITHUB_TOKEN_URL ?? DEFAULT_GITHUB_TOKEN_URL,
        userInfoUrl:
          env.BETTER_AUTH_GITHUB_USER_INFO_URL ?? DEFAULT_GITHUB_USER_INFO_URL,
        scopes: scopes.length > 0 ? scopes : DEFAULT_GITHUB_SCOPES,
      },
    ],
    oauthProxy: oauthProxyEnabled
      ? {
          enabled: true,
          currentURL: required(
            env.BETTER_AUTH_OAUTH_PROXY_CURRENT_URL,
            "BETTER_AUTH_OAUTH_PROXY_CURRENT_URL"
          ),
          productionURL: required(
            env.BETTER_AUTH_OAUTH_PROXY_PRODUCTION_URL,
            "BETTER_AUTH_OAUTH_PROXY_PRODUCTION_URL"
          ),
        }
      : undefined,
  });
};
