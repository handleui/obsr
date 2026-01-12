"use client";

import { Button } from "@detent/ui/button";
import Link from "next/link";
import { useActionState } from "react";
import { type AcceptState, acceptInvitation } from "./actions";

interface InvitationFormProps {
  token: string;
  organizationName: string;
}

const CheckIcon = () => (
  <svg
    aria-hidden="true"
    className="size-5 text-green-600"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path
      d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const initialState: AcceptState = { success: false, error: null };

const InvitationForm = ({ token, organizationName }: InvitationFormProps) => {
  const [state, action, isPending] = useActionState(
    acceptInvitation,
    initialState
  );

  // Success state
  if (state.success) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-2 text-green-600">
          <CheckIcon />
          <span className="font-medium">
            You&apos;ve joined {state.organizationName ?? organizationName}
          </span>
        </div>
        <Link
          className="inline-block font-medium text-neutral-900 text-sm underline underline-offset-4 hover:text-neutral-700"
          href="/"
        >
          Go to dashboard
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input name="token" type="hidden" value={token} />

      {state.error && (
        <p aria-live="polite" className="text-red-500 text-sm" role="alert">
          {state.error}
        </p>
      )}

      <Button className="w-full" disabled={isPending} type="submit">
        {isPending ? "Accepting..." : "Accept Invitation"}
      </Button>

      <p className="text-neutral-500 text-xs">
        By accepting, you agree to the organization&apos;s terms and will be
        added as a member.
      </p>
    </form>
  );
};

export { InvitationForm };
