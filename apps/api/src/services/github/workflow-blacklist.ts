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
  "render",
  "fly.io",
  "heroku",
  "amplify",
  "surge",
  "dependabot",
  "renovate",
  "snyk",
  "socket",
  "sonarcloud",
  "sonarqube",
  "codecov",
  "coveralls",
] as const;

const isBlacklistedWorkflow = (name: string): boolean => {
  const lowerName = name.toLowerCase();
  return BLACKLISTED_WORKFLOW_PATTERNS.some((pattern) =>
    lowerName.includes(pattern)
  );
};

export { isBlacklistedWorkflow };
