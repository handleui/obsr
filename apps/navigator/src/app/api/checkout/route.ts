import { Checkout } from "@polar-sh/nextjs";

export const GET = Checkout({
  // Same token type as POLAR_ACCESS_TOKEN in API - Polar API access token
  // Named differently per-app for deployment isolation (Vercel vs Cloudflare)
  // TODO: Consider unifying to POLAR_ACCESS_TOKEN across all apps for consistency
  accessToken: process.env.POLAR_CHECKOUT_TOKEN,
  successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/billing/success?checkout_id={CHECKOUT_ID}`,
  server: process.env.NODE_ENV === "production" ? "production" : "sandbox",
});
