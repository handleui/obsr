# Invitation System Enhancements

Future PR scope for completing the organization invitation and access request system.

## Background

When `mirrorGithubPermissions` is disabled, organizations rely entirely on manual membership management. The current system supports admin-initiated invitations via API, but lacks CLI tooling and user-initiated access requests.

---

## Scope

### 1. CLI Command: `dt org invite`

Allow organization owners and admins to invite users directly from the terminal.

**Behavior:**
- Prompt for email address if not provided as argument
- Prompt for role selection (admin or member)
- Call the existing invitation API endpoint
- Display confirmation with invitation details and expiry
- Handle errors gracefully (duplicate invitation, invalid email, permission denied)

**Flags:**
- `--email` or `-e` for target email
- `--role` or `-r` for role assignment
- `--org` to specify organization (or use current context)

**Output:**
- Success message with email sent confirmation
- Invitation expiry date
- Revocation instructions

---

### 2. CLI Command: `dt org invitations`

List and manage pending invitations for an organization.

**Subcommands:**
- `list` (default) - Show all pending invitations with email, role, expiry, inviter
- `revoke <id>` - Cancel a pending invitation

**Output format:**
- Table view with columns: Email, Role, Invited By, Expires, Created
- Empty state message when no pending invitations

---

### 3. Request-to-Join Flow

Allow users to request access to organizations they're not members of.

**Database additions:**
- New `access_requests` table storing: organization, requester user ID, requester email, message (optional), status (pending/approved/denied), timestamps, reviewer info

**API endpoints:**
- `POST /orgs/:orgId/access-requests` - Submit request (authenticated, non-member)
- `GET /orgs/:orgId/access-requests` - List pending requests (owner/admin)
- `POST /orgs/:orgId/access-requests/:id/approve` - Approve with role assignment
- `POST /orgs/:orgId/access-requests/:id/deny` - Deny with optional message

**User flow:**
- User attempts to access an org where they're not a member
- System returns "access denied" with option to request access
- User submits request (optionally with a message explaining why)
- Org admins receive email notification of pending request
- Admin approves or denies via Navigator UI or CLI
- User receives email with outcome

**CLI integration:**
- `dt org request <org-slug>` - Request access to an organization
- `dt org requests` - List pending requests (for admins)
- `dt org requests approve <id>` - Approve a request
- `dt org requests deny <id>` - Deny a request

---

### 4. React Email Integration

Replace inline HTML email templates with React Email components for maintainability and consistency.

**Setup:**
- Add `@react-email/components` package
- Create `apps/api/src/emails/` directory for email components
- Configure React Email dev server for local preview

**Email templates to create:**
- `invitation.tsx` - Organization invitation (replace current inline template)
- `access-request-submitted.tsx` - Confirmation to requester
- `access-request-notification.tsx` - Notification to org admins
- `access-request-approved.tsx` - Approval notification to requester
- `access-request-denied.tsx` - Denial notification to requester

**Template requirements:**
- Consistent branding with Detent visual identity
- Dark mode support
- Mobile-responsive layouts
- Plain text fallbacks generated from React components
- Shared layout component for header/footer

**Email service updates:**
- Refactor `createEmailService` to render React Email components
- Add helper for generating plain text from React components
- Support for email preview in development

---

### 5. Navigator Admin UI

Add invitation and access request management to the Navigator web interface.

**Invitation management page:**
- Form to create new invitation (email, role)
- Table of pending invitations with revoke action
- History of past invitations (accepted, expired, revoked)

**Access request management page:**
- List of pending access requests with requester info and message
- Approve button with role selector
- Deny button with optional message input
- History of processed requests

**Location:**
- New section under organization settings or dedicated `/org/[slug]/members` page

---

## Dependencies

- Current invitation API (complete)
- Current email service with Resend (complete)
- Organization membership system (complete)

## Out of Scope

- Bulk invitation import (CSV upload)
- Invitation link sharing (shareable join links)
- Auto-approval rules based on email domain
- Integration with external identity providers for membership sync

---

## Implementation Order

1. React Email integration (foundation for all emails)
2. CLI `org invite` and `org invitations` commands
3. Access request database schema and API
4. Access request email notifications
5. CLI access request commands
6. Navigator admin UI for invitations
7. Navigator admin UI for access requests
