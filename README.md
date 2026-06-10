# herdr-subagents

Visible, session-backed Pi subagents for Herdr.

Thanks to [`pi-interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) for the design inspiration. This extension intentionally copies the important architectural idea: the parent spawns a visible child Pi session, the child gets a small completion tool, and the parent is notified asynchronously when the child reports done.

## What this does

Registers a Pi tool:

- `herdr_subagent`

The tool:

1. Creates a Herdr pane, tab, or workspace.
2. Starts a child `pi` session there.
3. Passes the task as a Markdown file (`@task.md`) instead of typing into the TUI editor.
4. Loads a tiny child extension that provides `herdr_subagent_done`.
5. Returns immediately to the parent.
6. Watches a sidecar `.exit.json` file.
7. Sends a parent-session callback via `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` when the child calls `herdr_subagent_done`.

The child session **does not exit** when it reports completion. It stays open so you can continue working in it later.

## Requirements

- Pi running inside Herdr
- `herdr` CLI available
- `pi` CLI available

This extension does **not** depend on `pi-herdr`. It uses the Herdr CLI directly.

## Usage

Ask the parent agent to use `herdr_subagent`, or call it with parameters like:

```json
{
  "name": "scout-auth",
  "placement": "pane",
  "task": "Inspect src/auth. Do not edit files. Summarize risks. When done, call herdr_subagent_done with a concise summary."
}
```

Placement options:

- `pane` — split the current Herdr pane
- `tab` — create a new Herdr tab
- `workspace` — create a new Herdr workspace

## Sessions

By default the child session file is stable per subagent name:

```text
~/.pi/agent/herdr-subagents/sessions/herdr-subagent-<name>.jsonl
```

Use `sessionId` to choose a specific child session key.

## Completion model

The child receives a tool named `herdr_subagent_done`.

The child should call it when done:

```json
{
  "summary": "What was completed / found / changed."
}
```

That writes a sidecar file under:

```text
~/.pi/agent/herdr-subagents/exits/<sessionId>.exit.json
```

The parent watcher reads the sidecar and injects a callback message into the parent session.

## Why not print-mode sentinel?

A print-mode command is easy to automate, but it makes the child session feel less like an interactive subagent. This extension starts normal interactive Pi with an initial task file so the child pane remains useful after the first task.
