"use client";

import { Button } from "@detent/ui/button";
import { Input } from "@detent/ui/input";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createApiKey, revokeApiKey } from "./actions";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface ApiKeysSectionProps {
  keys: ApiKey[];
  provider: string;
  org: string;
}

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <Button onClick={copy} size="sm" variant="outline">
      {copied ? "Copied" : "Copy"}
    </Button>
  );
};

const ApiKeysSection = ({ keys, provider, org }: ApiKeysSectionProps) => {
  const [createState, createAction, isCreating] = useActionState(
    createApiKey,
    null
  );
  const [revokeState, revokeAction, isRevoking] = useActionState(
    revokeApiKey,
    null
  );

  return (
    <div className="space-y-6">
      {createState?.key && (
        <div className="rounded-lg border border-neutral-200 bg-surface p-4">
          <p className="mb-2 font-medium text-neutral-900 text-sm">
            API key created — copy it now, it won&apos;t be shown again
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-neutral-100 px-3 py-2 font-mono text-sm">
              {createState.key}
            </code>
            <CopyButton value={createState.key} />
          </div>
        </div>
      )}

      <form action={createAction} className="flex items-end gap-3">
        <input name="provider" type="hidden" value={provider} />
        <input name="org" type="hidden" value={org} />
        <div className="flex-1">
          <label
            className="mb-1 block text-neutral-500 text-sm"
            htmlFor="key-name"
          >
            Key name
          </label>
          <Input
            id="key-name"
            maxLength={128}
            name="name"
            placeholder="e.g. CI pipeline"
            required
          />
        </div>
        <Button disabled={isCreating} type="submit">
          {isCreating ? "Creating…" : "Create key"}
        </Button>
      </form>
      {createState?.error && (
        <p className="text-red-500 text-sm" role="alert">
          {createState.error}
        </p>
      )}

      {keys.length === 0 && !createState?.key ? (
        <p className="text-neutral-500 text-sm">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              className="flex items-center justify-between rounded-lg border border-neutral-200 p-4"
              key={k.id}
            >
              <div>
                <p className="font-medium text-neutral-900 text-sm">{k.name}</p>
                <p className="text-neutral-500 text-xs">
                  {k.key_prefix}…{"  "}·{"  "}Created{" "}
                  {new Date(k.created_at).toLocaleDateString()}
                  {k.last_used_at && (
                    <>
                      {"  "}·{"  "}Last used{" "}
                      {new Date(k.last_used_at).toLocaleDateString()}
                    </>
                  )}
                </p>
              </div>
              <form
                action={revokeAction}
                onSubmit={(e) => {
                  // biome-ignore lint/suspicious/noAlert: intentional — minimal UX, no custom modal
                  if (!confirm(`Revoke "${k.name}"? This cannot be undone.`)) {
                    e.preventDefault();
                  }
                }}
              >
                <input name="provider" type="hidden" value={provider} />
                <input name="org" type="hidden" value={org} />
                <input name="keyId" type="hidden" value={k.id} />
                <Button
                  disabled={isRevoking}
                  size="sm"
                  type="submit"
                  variant="outline"
                >
                  Revoke
                </Button>
              </form>
            </div>
          ))}
        </div>
      )}
      {revokeState?.error && (
        <p className="text-red-500 text-sm" role="alert">
          {revokeState.error}
        </p>
      )}
    </div>
  );
};

export default ApiKeysSection;
