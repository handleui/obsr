/** @jsxImportSource react */
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

interface EmailLayoutProps {
  preview: string;
  children: ReactNode;
}

export const EmailLayout = ({ preview, children }: EmailLayoutProps) => (
  <Html dir="ltr" lang="en">
    <Head />
    <Preview>{preview}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Section>{children}</Section>
        <Hr style={styles.hr} />
        <Text style={styles.footer}>
          If you didn't expect this email, you can safely ignore it.
        </Text>
      </Container>
    </Body>
  </Html>
);

// Shared styles exported for use in email templates
export const styles = {
  main: {
    backgroundColor: "#ffffff",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  } satisfies CSSProperties,

  container: {
    margin: "0 auto",
    padding: "20px 0 48px",
    maxWidth: "600px",
  } satisfies CSSProperties,

  hr: {
    borderColor: "#eee",
    margin: "24px 0",
  } satisfies CSSProperties,

  footer: {
    color: "#888",
    fontSize: "12px",
  } satisfies CSSProperties,

  // Common text styles
  heading: {
    color: "#1a1a1a",
    fontSize: "24px",
    fontWeight: "600",
    lineHeight: "1.3",
    margin: "0 0 16px",
  } satisfies CSSProperties,

  paragraph: {
    color: "#4a4a4a",
    fontSize: "16px",
    lineHeight: "1.6",
    margin: "0 0 24px",
  } satisfies CSSProperties,

  // Common button style
  button: {
    backgroundColor: "#000",
    borderRadius: "6px",
    color: "#fff",
    display: "inline-block",
    fontSize: "16px",
    fontWeight: "600",
    padding: "12px 24px",
    textDecoration: "none",
  } satisfies CSSProperties,

  // Muted text
  muted: {
    color: "#888",
    fontSize: "14px",
  } satisfies CSSProperties,
};
