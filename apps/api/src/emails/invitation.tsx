/** @jsxImportSource react */
import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout, styles } from "./_components/layout.js";

interface InvitationEmailProps {
  organizationName: string;
  inviterName?: string;
  role: string;
  acceptUrl: string;
  expiresInDays: number;
}

export const InvitationEmail = ({
  organizationName = "Acme Corp",
  inviterName = "Jane Doe",
  role = "member",
  acceptUrl = "https://detent.sh/accept?token=example",
  expiresInDays = 7,
}: InvitationEmailProps) => {
  const preview = `You've been invited to join ${organizationName} on Detent`;

  return (
    <EmailLayout preview={preview}>
      <Heading style={styles.heading}>
        You've been invited to join {organizationName}
      </Heading>
      <Text style={styles.paragraph}>
        {inviterName ? `${inviterName} has` : "You have been"} invited to join{" "}
        <strong>{organizationName}</strong> as a <strong>{role}</strong>.
      </Text>
      <Button href={acceptUrl} style={styles.button}>
        Accept Invitation
      </Button>
      <Text style={{ ...styles.muted, marginTop: "24px" }}>
        This invitation expires in {expiresInDays} day
        {expiresInDays === 1 ? "" : "s"}.
      </Text>
    </EmailLayout>
  );
};

export default InvitationEmail;
