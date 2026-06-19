# herdr-subagents

Spawn visible Pi subagents in Herdr panes, tabs, or workspaces — and get notified in the parent session when they finish.

Thanks to [`pi-interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) for the design inspiration.

## Requirements

- [Pi](https://pi.dev) running inside [Herdr](https://herdr.io)
- `herdr` CLI available in PATH
- `pi` CLI available in PATH

## Install

```bash
pi install git:github.com/kirel/herdr-subagents
```

## What it does

When you ask pi to work on two things in parallel, or hand off a task to a separate visible agent, this extension spawns a new pi session in a Herdr pane (or tab, or workspace). The child gets its task, works independently, and when it's done the parent session is automatically notified and picks up where it left off.

The child pane **stays open** after it reports completion — you can switch to it and continue working there.

## Usage

Just ask pi:

> "Spawn a subagent to review the auth module and summarize the risks."

> "Run two subagents in parallel: one reviews the frontend, one reviews the backend."

The agent handles placement, session management, and the completion callback automatically.

## Choose a child model

The `herdr_subagent` tool accepts an optional `model` parameter for the child Pi process. It uses the same model pattern syntax as Pi's `--model` flag, for example:

- `sonnet:high`
- `openai/gpt-4o`
- `anthropic/claude-sonnet-4-5`

When `model` is set, the generated child command includes `--model <model>`. The advanced `piCommand` override owns the full command, so `model` and `piCommand` cannot be used together.

## Child pane stays open

After the subagent reports back, its Herdr pane remains open. You can:
- Switch to it and continue the conversation
- Ask it follow-up questions
- Reuse the same session by name for the next related task

## Credit

Design inspired by [pi-interactive-subagents](https://github.com/hazat/pi-interactive-subagents).
