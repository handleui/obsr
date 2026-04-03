#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

legacy_package_pattern='from ["'\''](@obsr/extract|@obsr/legacy-types|legacy/types)["'\'']|import ["'\''](@obsr/extract|@obsr/legacy-types|legacy/types)["'\'']'

if rg -n "$legacy_package_pattern" apps packages --glob '!legacy/**' >/dev/null; then
  echo "Found non-legacy imports of legacy packages."
  rg -n "$legacy_package_pattern" apps packages --glob '!legacy/**'
  exit 1
fi

if rg -n 'from "@obsr/types"|from '\''@obsr/types'\''' apps packages --glob '!legacy/**' \
  | grep -E 'CIError|ExtractedError|ContextParser|CIProvider|WorkflowContext|CodeSnippet|CICodeSnippet|CIWorkflowContext' >/dev/null; then
  echo "Found non-legacy imports of legacy error abstractions from @obsr/types."
  rg -n 'from "@obsr/types"|from '\''@obsr/types'\''' apps packages --glob '!legacy/**' \
    | grep -E 'CIError|ExtractedError|ContextParser|CIProvider|WorkflowContext|CodeSnippet|CICodeSnippet|CIWorkflowContext'
  exit 1
fi

echo "Legacy import boundary check passed."
