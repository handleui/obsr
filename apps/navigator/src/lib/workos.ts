import { WorkOS } from "@workos-inc/node";

/**
 * Validate WorkOS configuration on initialization
 * Fail fast if credentials are missing or invalid
 */
const getWorkOSApiKey = () => {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "WORKOS_API_KEY is not set - check your environment variables"
    );
  }
  // Validate API key format (WorkOS keys start with sk_)
  if (!apiKey.startsWith("sk_")) {
    throw new Error(
      "WORKOS_API_KEY has invalid format - expected key starting with 'sk_'"
    );
  }
  return apiKey;
};

const getWorkOSClientIdForInit = () => {
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "WORKOS_CLIENT_ID is not set - check your environment variables"
    );
  }
  // Validate client ID format (WorkOS client IDs start with client_)
  if (!clientId.startsWith("client_")) {
    throw new Error(
      "WORKOS_CLIENT_ID has invalid format - expected ID starting with 'client_'"
    );
  }
  return clientId;
};

/**
 * WorkOS client instance
 * clientId is required for sealed session methods (loadSealedSession, refreshAndSealSessionData)
 * Initialization validates credentials and fails fast if misconfigured
 */
export const workos = new WorkOS(getWorkOSApiKey(), {
  clientId: getWorkOSClientIdForInit(),
});
