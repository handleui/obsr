const BLACKLISTED_WORKFLOW_PATTERNS = [
  "greptile",
  "coderabbit",
  "sourcery",
  "codium",
  "qodo",
  "sweep",
  "ellipsis",
  "vercel",
  "netlify",
  "cloudflare",
  "railway",
  "render.com",
  "render deploy",
  "render-deploy",
  "fly.io",
  "heroku",
  "amplify",
  "surge",
  "dependabot",
  "renovate",
  "snyk",
  "socket.dev",
  "socket security",
  "socket-security",
  "sonarcloud",
  "sonarqube",
  "codecov",
  "coveralls",
  "mintlify",
] as const;

const isBlacklistedWorkflow = (name: string): boolean => {
  const lowerName = name.toLowerCase();
  return BLACKLISTED_WORKFLOW_PATTERNS.some((pattern) =>
    lowerName.includes(pattern)
  );
};

export { isBlacklistedWorkflow };
