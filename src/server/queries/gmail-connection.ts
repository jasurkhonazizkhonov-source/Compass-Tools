import { prisma } from "@/lib/prisma";

export type GmailConnectionState = "NOT_CONNECTED" | "CONNECTED" | "REVOKED";

/** Never returns the encrypted refresh token or any other sensitive field
 * — only the tri-state the UI needs to render Connect/Connected/Reconnect. */
export async function getGmailConnectionState(accountId: string | undefined): Promise<GmailConnectionState> {
  if (!accountId) return "NOT_CONNECTED";
  const connection = await prisma.gmailConnection.findUnique({
    where: { accountId },
    select: { status: true },
  });
  if (!connection) return "NOT_CONNECTED";
  return connection.status;
}
