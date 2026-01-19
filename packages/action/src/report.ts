import type { ReportPayload } from "./collect";

export const report = async (
  payload: ReportPayload,
  token: string,
  apiUrl: string
): Promise<{ stored: number; runId: string }> => {
  const response = await fetch(`${apiUrl}/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Detent-Token": token,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to report: ${response.status} ${errorText}`);
  }

  return response.json() as Promise<{ stored: number; runId: string }>;
};
