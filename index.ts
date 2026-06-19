import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DirectionEnum = Type.Union([Type.Literal("right"), Type.Literal("down")], {
  description: "Split direction when placement is 'pane'. Defaults to right.",
});

const PlacementEnum = Type.Union([Type.Literal("pane"), Type.Literal("tab"), Type.Literal("workspace")], {
  description: "Where to start the child Pi agent. 'pane' splits the current pane, 'tab' creates a Herdr tab, 'workspace' creates a Herdr workspace. Defaults to pane.",
});

const DeliveryEnum = Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
  description: "How to deliver the completion message back to the orchestrator. Defaults to steer.",
});

type Direction = "right" | "down";
type Placement = "pane" | "tab" | "workspace";
type Delivery = "followUp" | "steer";

interface HerdrJsonEnvelope<T = any> {
  result?: T;
  error?: { code?: string; message?: string };
}

interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
}

interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
}

interface WorkspaceInfo {
  workspace_id: string;
  label: string;
}

interface ExitPayload {
  type: "done" | "ping" | "error";
  name?: string;
  summary?: string;
  message?: string;
  errorMessage?: string;
  completedAt?: string;
}

function safeName(input: string | undefined): string {
  const base = (input || "subagent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "subagent";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function defaultSessionId(name: string): string {
  return `herdr-subagent-${safeName(name)}`.slice(0, 80);
}

function baseDir(): string {
  return join(homedir(), ".pi", "agent", "herdr-subagents");
}

function sessionPathFor(sessionId: string): string {
  return join(baseDir(), "sessions", `${safeName(sessionId)}.jsonl`);
}

function exitPathFor(sessionId: string): string {
  return join(baseDir(), "exits", `${safeName(sessionId)}.exit.json`);
}

function taskPathFor(sessionId: string): string {
  return join(baseDir(), "tasks", `${Date.now()}-${safeName(sessionId)}.md`);
}

function childExtensionPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "child.ts");
}

function formatCompletionMessage(params: {
  name: string;
  paneId: string;
  placement: Placement;
  sessionId: string;
  sessionFile: string;
  exit: ExitPayload;
}): string {
  const { name, paneId, placement, sessionId, sessionFile, exit } = params;
  const summary = exit.summary || exit.message || exit.errorMessage || "(no summary provided)";
  const status = exit.type === "done" ? "completed" : exit.type;
  return [
    `Herdr subagent '${name}' ${status}.`,
    `Pane: ${paneId}`,
    `Placement: ${placement}`,
    `Session id: ${sessionId}`,
    `Session file: ${sessionFile}`,
    "",
    summary,
  ].join("\n");
}

export default function herdrSubagents(pi: ExtensionAPI) {
  const currentPaneId = process.env.HERDR_PANE_ID;
  if (!process.env.HERDR_ENV || !currentPaneId) return;

  async function execHerdr(args: string[], signal?: AbortSignal) {
    const result = await pi.exec("herdr", args, { signal });
    if (signal?.aborted || result.killed) throw new Error("Aborted");
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `herdr ${args.join(" ")} failed with exit code ${result.code}`;
      throw new Error(message);
    }
    return result;
  }

  async function execHerdrJson<T = any>(args: string[], signal?: AbortSignal): Promise<T> {
    const result = await execHerdr(args, signal);
    const stdout = result.stdout.trim();
    if (!stdout) throw new Error(`Expected JSON from herdr ${args.join(" ")}`);
    const parsed = JSON.parse(stdout) as HerdrJsonEnvelope<T>;
    if (parsed.error) throw new Error(parsed.error.message || parsed.error.code || `herdr ${args.join(" ")} failed`);
    return parsed.result as T;
  }

  async function getCurrentPane(signal?: AbortSignal): Promise<PaneInfo> {
    const result = await execHerdrJson<{ pane: PaneInfo }>(["pane", "get", currentPaneId], signal);
    return result.pane;
  }

  async function createAgentPane(options: {
    placement: Placement;
    name: string;
    cwd: string;
    direction: Direction;
    signal?: AbortSignal;
  }): Promise<{ paneId: string; workspaceId?: string; tabId?: string }> {
    const { placement, name, cwd, direction, signal } = options;

    if (placement === "pane") {
      const split = await execHerdrJson<{ pane: PaneInfo }>([
        "pane", "split", currentPaneId, "--direction", direction, "--cwd", cwd, "--no-focus",
      ], signal);
      return { paneId: split.pane.pane_id, workspaceId: split.pane.workspace_id, tabId: split.pane.tab_id };
    }

    if (placement === "tab") {
      const current = await getCurrentPane(signal);
      const created = await execHerdrJson<{ tab: TabInfo; root_pane?: PaneInfo }>([
        "tab", "create", "--workspace", current.workspace_id, "--cwd", cwd, "--label", name, "--no-focus",
      ], signal);
      if (!created.root_pane) throw new Error("Herdr did not return a root pane for the created tab");
      return { paneId: created.root_pane.pane_id, workspaceId: created.root_pane.workspace_id, tabId: created.tab.tab_id };
    }

    const created = await execHerdrJson<{ workspace: WorkspaceInfo; root_pane?: PaneInfo }>([
      "workspace", "create", "--cwd", cwd, "--label", name, "--no-focus",
    ], signal);
    if (!created.root_pane) throw new Error("Herdr did not return a root pane for the created workspace");
    return { paneId: created.root_pane.pane_id, workspaceId: created.workspace.workspace_id, tabId: created.root_pane.tab_id };
  }

  async function waitForExitFile(exitFile: string, timeoutMs: number): Promise<ExitPayload> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(exitFile, "utf8");
        return JSON.parse(raw) as ExitPayload;
      } catch {
        // Not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`timed out waiting for ${exitFile}`);
  }

  function startCompletionWatcher(options: {
    name: string;
    paneId: string;
    placement: Placement;
    sessionId: string;
    sessionFile: string;
    exitFile: string;
    timeoutMs: number;
    deliverAs: Delivery;
  }) {
    void (async () => {
      const { name, paneId, placement, sessionId, sessionFile, exitFile, timeoutMs, deliverAs } = options;
      try {
        const exit = await waitForExitFile(exitFile, timeoutMs);
        pi.sendMessage(
          {
            customType: "herdr_subagent_result",
            content: formatCompletionMessage({ name, paneId, placement, sessionId, sessionFile, exit }),
            display: true,
            details: { name, paneId, placement, sessionId, sessionFile, exitFile, exit },
          },
          { triggerTurn: true, deliverAs },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pi.sendMessage(
          {
            customType: "herdr_subagent_result",
            content: `Herdr subagent '${name}' in pane ${paneId} did not report completion: ${message}\n\nSession file: ${sessionFile}`,
            display: true,
            details: { name, paneId, placement, sessionId, sessionFile, exitFile, error: message },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    })();
  }

  pi.registerTool({
    name: "herdr_subagent",
    label: "Herdr Subagent",
    description: "Spawn a visible session-backed Pi agent in a Herdr pane/tab/workspace, send it a task file, return immediately, and notify the orchestrator when the child calls herdr_subagent_done. The child session remains open for follow-up work.",
    promptSnippet: "Spawn visible session-backed Pi agents in Herdr and receive a callback when they call herdr_subagent_done.",
    promptGuidelines: [
      "Use herdr_subagent when the user wants visible Herdr/Pi subagents with automatic completion notification back to the orchestrator.",
      "The child Pi session remains open after completion; reuse the same name or sessionId to continue that child session later.",
      "Give herdr_subagent a self-contained task and explicitly tell the child to call herdr_subagent_done with a concise summary when finished.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained task prompt to send to the child Pi agent." }),
      name: Type.Optional(Type.String({ description: "Human-readable agent name. Defaults to 'subagent'." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new pane. Defaults to the current Pi cwd." })),
      placement: Type.Optional(PlacementEnum),
      direction: Type.Optional(DirectionEnum),
      sessionId: Type.Optional(Type.String({ description: "Pi session id/path key for the child agent. Defaults to a stable id derived from the agent name." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern or ID for the child agent, e.g. 'openai/gpt-4o' or 'sonnet:high'. Added to the generated command or appended to piCommand when provided." })),
      piCommand: Type.Optional(Type.String({ description: "Base Pi command. Defaults to 'pi --session <sessionFile> -e <childExtension> @<taskFile>'. Use only for advanced overrides." })),
      completionTimeoutMs: Type.Optional(Type.Number({ description: "How long the background watcher waits for herdr_subagent_done. Defaults to 1800000." })),
      deliverAs: Type.Optional(DeliveryEnum),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const name = safeName(params.name);
      const cwd = params.cwd || ctx.cwd;
      const placement = (params.placement || "pane") as Placement;
      const direction = (params.direction || "right") as Direction;
      const sessionId = params.sessionId || defaultSessionId(name);
      const sessionFile = sessionPathFor(sessionId);
      const exitFile = exitPathFor(sessionId);
      const taskFile = taskPathFor(sessionId);
      const completionTimeoutMs = params.completionTimeoutMs ?? 1800000;
      const deliverAs = (params.deliverAs || "steer") as Delivery;

      await mkdir(dirname(sessionFile), { recursive: true });
      await mkdir(dirname(exitFile), { recursive: true });
      await mkdir(dirname(taskFile), { recursive: true });
      await rm(exitFile, { force: true });

      const fullTask = `${params.task}\n\nWhen you are finished, call the herdr_subagent_done tool with a concise summary. Calling that tool notifies the parent orchestrator and keeps this child session open for follow-up work.`;
      await writeFile(taskFile, fullTask, "utf8");

      const createdPane = await createAgentPane({ placement, name, cwd, direction, signal });
      const paneId = createdPane.paneId;
      await execHerdr(["pane", "rename", paneId, name], signal);

      const envPrefix = [
        `HERDR_SUBAGENT_NAME=${shellQuote(name)}`,
        `HERDR_SUBAGENT_EXIT_FILE=${shellQuote(exitFile)}`,
      ].join(" ");
      const modelArgs = params.model ? ` --model ${shellQuote(params.model)}` : "";
      const defaultCommand = `pi --session ${shellQuote(sessionFile)} -e ${shellQuote(childExtensionPath())} @${shellQuote(taskFile)}`;
      const piCommand = params.piCommand || defaultCommand;
      const command = `${envPrefix} ${piCommand}${modelArgs}`;
      await execHerdr(["pane", "run", paneId, command], signal);

      startCompletionWatcher({ name, paneId, placement, sessionId, sessionFile, exitFile, timeoutMs: completionTimeoutMs, deliverAs });

      return {
        content: [{ type: "text", text: `Started Herdr subagent '${name}' in ${placement} pane ${paneId}. It will report back when it calls herdr_subagent_done. Session remains open: ${sessionFile}` }],
        details: {
          name,
          paneId,
          cwd,
          placement,
          direction,
          workspaceId: createdPane.workspaceId,
          tabId: createdPane.tabId,
          sessionId,
          sessionFile,
          exitFile,
          taskFile,
          model: params.model,
          completionTimeoutMs,
          deliverAs,
        },
      };
    },
  });
}
