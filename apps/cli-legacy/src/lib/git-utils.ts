const SSH_REMOTE_PATTERN = /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/;
const HTTPS_REMOTE_PATTERN = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/;

export const parseRemoteUrl = (url: string): string | null => {
  const sshMatch = url.match(SSH_REMOTE_PATTERN);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const httpsMatch = url.match(HTTPS_REMOTE_PATTERN);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  return null;
};
