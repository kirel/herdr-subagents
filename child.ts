import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";

export default function herdrSubagentChild(pi: ExtensionAPI) {
  const exitFile = process.env.HERDR_SUBAGENT_EXIT_FILE;
  const subagentName = process.env.HERDR_SUBAGENT_NAME || "subagent";

  pi.registerTool({
    name: "herdr_subagent_done",
    label: "Herdr Subagent Done",
    description:
      "Report that this Herdr subagent has completed its delegated task. " +
      "Call this when your task is done. This notifies the parent orchestrator but keeps this Pi session open for follow-up work.",
    promptSnippet: "Notify the parent orchestrator that the delegated Herdr subagent task is complete.",
    promptGuidelines: [
      "Use herdr_subagent_done exactly when the delegated task is complete and you have a concise result summary for the parent orchestrator.",
      "Calling herdr_subagent_done notifies the parent but does not close this child Pi session, so the user can continue here later.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Concise completion summary to send back to the parent orchestrator." }),
    }),
    async execute(_toolCallId, params) {
      if (!exitFile) {
        throw new Error("HERDR_SUBAGENT_EXIT_FILE is not set; cannot notify parent orchestrator.");
      }

      writeFileSync(
        exitFile,
        JSON.stringify({
          type: "done",
          name: subagentName,
          summary: params.summary,
          completedAt: new Date().toISOString(),
        }) + "\n",
        "utf8",
      );

      return {
        content: [{ type: "text", text: "Parent orchestrator notified. This subagent session remains open." }],
        details: { exitFile, name: subagentName },
      };
    },
  });
}
