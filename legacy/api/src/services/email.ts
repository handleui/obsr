import { render } from "@react-email/components";
import { Resend } from "resend";
import { InvitationEmail } from "../emails/index.js";
import type { Env } from "../types/env.js";

interface SendInvitationEmailParams {
  to: string;
  organizationName: string;
  inviterName?: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}

export const createEmailService = (env: Env) => {
  const resend = new Resend(env.RESEND_API_KEY);
  const emailFrom = env.RESEND_EMAIL_FROM;

  return {
    sendInvitationEmail: async (params: SendInvitationEmailParams) => {
      const { to, organizationName, inviterName, role, acceptUrl, expiresAt } =
        params;

      const expiresInDays = Math.ceil(
        (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );

      const emailComponent = InvitationEmail({
        organizationName,
        inviterName,
        role,
        acceptUrl,
        expiresInDays,
      });

      const html = await render(emailComponent);
      const text = await render(emailComponent, { plainText: true });

      const { data, error } = await resend.emails.send({
        from: emailFrom,
        to,
        subject: `You've been invited to join ${organizationName} on Detent`,
        html,
        text,
      });

      if (error) {
        throw new Error(`Failed to send invitation email: ${error.message}`);
      }

      return data;
    },
  };
};
