#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if rg -n 'from "@obsr/types"|from '\''@obsr/types'\''' apps packages \
  | grep -E 'CIError|ExtractedError|ContextParser|CIProvider|WorkflowContext|CodeSnippet|CICodeSnippet|CIWorkflowContext' >/dev/null; then
  echo "Found imports of legacy error abstractions from @obsr/types."
  rg -n 'from "@obsr/types"|from '\''@obsr/types'\''' apps packages \
    | grep -E 'CIError|ExtractedError|ContextParser|CIProvider|WorkflowContext|CodeSnippet|CICodeSnippet|CIWorkflowContext'
  exit 1
fi

echo "Legacy import boundary check passed."
