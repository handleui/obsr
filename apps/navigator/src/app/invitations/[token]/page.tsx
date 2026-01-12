import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { API_BASE_URL } from "@/lib/constants";
import { isValidTokenFormat } from "@/lib/validation";
import { InvitationForm } from "./invitation-form";

interface InvitationPageProps {
  params: Promise<{ token: string }>;
}

interface InvitationDetails {
  organization_name: string;
  organization_slug: string;
  role: string;
  expires_at: string;
  email: string;
}

interface InvitationError {
  error: string;
  code?: string;
}

const EnvelopeIcon = () => (
  <svg
    aria-hidden="true"
    className="size-8 text-neutral-700"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    viewBox="0 0 24 24"
  >
    <path
      d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const formatExpiry = (expiresAt: string): string => {
  const expiry = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return "expired";
  }
  if (diffDays === 0) {
    return "expires soon";
  }
  if (diffDays === 1) {
    return "expires in 1 day";
  }
  return `expires in ${diffDays} days`;
};

const formatRole = (role: string): string => {
  return role.charAt(0).toUpperCase() + role.slice(1);
};

interface ErrorPageProps {
  title: string;
  message: string;
  showDashboardLink?: boolean;
}

const ErrorPage = ({
  title,
  message,
  showDashboardLink = false,
}: ErrorPageProps) => (
  <main className="flex min-h-screen items-center justify-center bg-white">
    <div className="w-full max-w-md space-y-6 p-8 text-center">
      <div className="flex justify-center">
        <EnvelopeIcon />
      </div>
      <h1 className="font-semibold text-neutral-900 text-xl">{title}</h1>
      <p className="text-neutral-600 text-sm">{message}</p>
      {showDashboardLink && (
        <Link
          className="inline-block font-medium text-neutral-900 text-sm underline underline-offset-4 hover:text-neutral-700"
          href="/"
        >
          Go to dashboard
        </Link>
      )}
    </div>
  </main>
);

const renderGoneError = (
  code: string | undefined,
  fallbackMessage: string
): React.ReactNode => {
  const errorMessages: Record<
    string,
    { title: string; message: string; showDashboardLink?: boolean }
  > = {
    ACCEPTED: {
      title: "Already Accepted",
      message: "This invitation has already been accepted.",
      showDashboardLink: true,
    },
    REVOKED: {
      title: "Invitation Revoked",
      message: "This invitation has been revoked by the organization admin.",
    },
    EXPIRED: {
      title: "Invitation Expired",
      message:
        "This invitation has expired. Please contact the organization admin to request a new invitation.",
    },
  };

  const errorConfig = code ? errorMessages[code] : undefined;
  if (errorConfig) {
    return <ErrorPage {...errorConfig} />;
  }

  return (
    <ErrorPage
      message={fallbackMessage || "This invitation is no longer valid."}
      title="Invitation No Longer Available"
    />
  );
};

const renderApiError = (
  status: number,
  errorData: InvitationError
): React.ReactNode => {
  if (status === 404) {
    return (
      <ErrorPage
        message="This invitation link is invalid or has been removed."
        title="Invitation Not Found"
      />
    );
  }

  if (status === 410) {
    return renderGoneError(errorData.code, errorData.error);
  }

  if (status >= 500) {
    return (
      <ErrorPage
        message="We're experiencing technical difficulties. Please try again later."
        title="Server Error"
      />
    );
  }

  return (
    <ErrorPage
      message={errorData.error || "Unable to load invitation details."}
      title="Something Went Wrong"
    />
  );
};

const InvitationPage = async ({ params }: InvitationPageProps) => {
  const { token } = await params;

  // Validate token format before any operations to prevent injection attacks
  if (!isValidTokenFormat(token)) {
    return (
      <ErrorPage
        message="This invitation link is invalid."
        title="Invalid Invitation"
      />
    );
  }

  const { isAuthenticated, user } = await getUser();

  // Fetch invitation details from API
  // Using AbortController for timeout to prevent hanging requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/invitations/${token}`, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return (
      <ErrorPage
        message={
          isAbortError
            ? "The server took too long to respond. Please try again."
            : "Unable to connect to the server. Please check your connection and try again."
        }
        title={isAbortError ? "Request Timed Out" : "Connection Error"}
      />
    );
  }
  clearTimeout(timeoutId);

  // Handle error responses
  if (!response.ok) {
    let errorData: InvitationError = { error: "Unknown error" };
    try {
      errorData = (await response.json()) as InvitationError;
    } catch {
      // Fall through with default error
    }
    return renderApiError(response.status, errorData);
  }

  const invitation = (await response.json()) as InvitationDetails;

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    const returnTo = `/invitations/${token}`;
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-white">
      <div className="w-full max-w-md space-y-6 p-8 text-center">
        <div className="flex justify-center">
          <EnvelopeIcon />
        </div>
        <h1 className="font-semibold text-neutral-900 text-xl">
          Join {invitation.organization_name}
        </h1>

        <div className="space-y-2">
          <p className="text-neutral-600 text-sm">
            You&apos;ve been invited to join{" "}
            <span className="font-medium text-neutral-900">
              {invitation.organization_name}
            </span>{" "}
            as a{" "}
            <span className="font-medium text-neutral-900">
              {formatRole(invitation.role)}
            </span>
            .
          </p>
          <p className="text-neutral-500 text-xs">
            Invitation sent to {invitation.email} &middot;{" "}
            {formatExpiry(invitation.expires_at)}
          </p>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-left text-sm">
          <p className="text-neutral-600">
            Accepting as{" "}
            <span className="font-medium text-neutral-900">{user?.email}</span>
          </p>
        </div>

        <InvitationForm
          organizationName={invitation.organization_name}
          token={token}
        />
      </div>
    </main>
  );
};

export default InvitationPage;
