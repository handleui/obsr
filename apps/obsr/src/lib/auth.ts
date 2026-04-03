import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
} from "@/db/auth-schema";
import { getDb } from "@/db/client";

interface GitHubUserResponse {
  avatar_url: string | null;
  email: string | null;
  id: number;
  login: string;
  name: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

const authSchema = {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
};

const getGitHubUserInfo = async (accessToken?: string) => {
  if (!accessToken) {
    return null;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "obsr",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const [userResponse, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers }),
  ]);

  if (!userResponse.ok) {
    return null;
  }

  const user = (await userResponse.json()) as GitHubUserResponse;
  const emails = emailsResponse.ok
    ? ((await emailsResponse.json()) as GitHubEmailResponse[])
    : [];
  const primaryEmail =
    emails.find((email) => email.primary) ??
    emails.find((email) => email.verified);
  const email = user.email ?? primaryEmail?.email;

  if (!email) {
    return null;
  }

  return {
    email,
    emailVerified: primaryEmail?.verified ?? false,
    id: String(user.id),
    image: user.avatar_url ?? undefined,
    name: user.name ?? user.login,
  };
};

const createAuth = () => {
  const { db } = getDb();
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchema,
    }),
    plugins: [
      genericOAuth({
        config: [
          {
            authorizationUrl: "https://github.com/login/oauth/authorize",
            clientId: process.env.BETTER_AUTH_GITHUB_CLIENT_ID ?? "",
            clientSecret: process.env.BETTER_AUTH_GITHUB_CLIENT_SECRET ?? "",
            getUserInfo: (tokens) => {
              return getGitHubUserInfo(tokens.accessToken);
            },
            providerId: "github",
            scopes: ["read:user", "user:email"],
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        ],
      }),
      nextCookies(),
    ],
  });
};

type AuthInstance = ReturnType<typeof createAuth>;

let authInstance: AuthInstance | null = null;

export const getAuth = (): AuthInstance => {
  const existingAuth = authInstance;
  if (existingAuth) {
    return existingAuth;
  }

  const nextAuth = createAuth();
  authInstance = nextAuth;
  return nextAuth;
};
