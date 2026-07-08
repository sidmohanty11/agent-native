import { defineAction } from "@agent-native/core";
import { writeAppState } from "@agent-native/core/application-state";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { assertAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

/**
 * Surface the LocalhostWriteConsentDialog so the user can approve local file
 * writes. Granting is human-only (`grant-localhost-write-consent` is
 * `agentTool: false`), so an agent writing from chat can only *request* the
 * prompt: this writes an app-state key the editor observes and opens the dialog.
 * If a valid grant already exists it reports that instead of prompting again.
 */
export default defineAction({
  description:
    "Prompt the user to allow local file writes for a design's localhost " +
    "connection by opening the write-consent dialog in the editor. Write " +
    "consent itself is human-only and cannot be granted by the agent. Call " +
    "this when write-local-file fails because no write-consent grant exists, " +
    "then retry write-local-file after the user approves. Requires editor " +
    "access on the design.",
  schema: z.object({
    designId: z.string().describe("Design ID."),
    connectionId: z
      .string()
      .describe("Localhost connection ID (from list-localhost-connections)."),
    files: z
      .array(z.string())
      .optional()
      .describe("File paths about to be written, shown in the dialog."),
  }),
  run: async ({ designId, connectionId, files }) => {
    await assertAccess("design", designId, "editor");

    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("no authenticated user");

    const db = getDb();
    const [connection] = await db
      .select({ rootPath: schema.designLocalhostConnections.rootPath })
      .from(schema.designLocalhostConnections)
      .where(
        and(
          eq(schema.designLocalhostConnections.id, connectionId),
          eq(schema.designLocalhostConnections.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);

    if (!connection) {
      throw new Error(
        `Localhost connection "${connectionId}" not found for the current user.`,
      );
    }

    // Skip the prompt when a non-expired grant already covers this connection —
    // the agent can just retry write-local-file.
    const [grant] = await db
      .select({
        grantedUntil: schema.designLocalhostWriteGrants.grantedUntil,
      })
      .from(schema.designLocalhostWriteGrants)
      .where(
        and(
          eq(schema.designLocalhostWriteGrants.designId, designId),
          eq(schema.designLocalhostWriteGrants.connectionId, connectionId),
          eq(schema.designLocalhostWriteGrants.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);
    if (grant && grant.grantedUntil > new Date().toISOString()) {
      return {
        designId,
        connectionId,
        alreadyGranted: true,
        message:
          "A valid write-consent grant already exists. Retry write-local-file.",
      };
    }

    await writeAppState(`design-localhost-write-consent-request:${designId}`, {
      designId,
      connectionId,
      rootPath: connection.rootPath ?? connectionId,
      files: files ?? [],
      requestedAt: new Date().toISOString(),
    });

    return {
      designId,
      connectionId,
      surfaced: true,
      message:
        "Prompted the user to allow file writes in the editor. Ask them to " +
        "click 'Allow writes' in the dialog, then retry write-local-file.",
    };
  },
});
