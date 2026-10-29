---
title: Sandbox dashboard and run history
summary: Monitor sandbox lifecycles, inspect execution output, transfer files, and download retained artifacts.
section: Services
order: 17
---

# Sandbox dashboard and run history

Open a project and choose **Agent sandboxes**. The **Runs** tab shows work created through
the dashboard, SDK, CLI, and MCP tools. **Setup** has an app example, a scoped API-key action,
the host setup command, and links to the sandbox guides. Search for these pages and actions
with Ctrl/⌘ K.

## Enable the service

First, run this on the Linux machine hosting your mybase Docker installation:

```sh
mybase server sandbox --project shop
```

This installs/configures the worker and enables sandboxes for `shop`. For an existing prepared
host, use the service switch on the project's Overview page or the Turn on button on its
Agent sandboxes page. A browser cannot install a host runtime: if enabling reports that the
worker is missing, run the host command first. See [Agent sandboxes](sandboxes.md) for prerequisites.

## Read the runs list

The list shows the **latest 100 sandboxes**, newest first, within seven-day metadata retention.
Each row includes ID, lifecycle state, terminal reason when available, runtime, execution count,
and exported bytes. Click the sandbox ID to open its details. Filter by ID, state, or reason;
the filter and selected sandbox/execution are kept in the URL for sharing and browser navigation.

The list refreshes every three seconds while the tab is visible. A failed refresh shows an inline
error and preserves the last loaded data; use Retry after fixing connectivity. Hidden tabs pause
polling. Looking at a sandbox does **not** renew its idle deadline.

### Usage today

The totals report project usage for the **UTC admission day**, without quota meters:

| Total | Meaning |
| --- | --- |
| Active sandboxes | Nonterminal sandboxes, including queued, starting, and stopping |
| Runtime today | Elapsed runtime for today's admitted sandboxes |
| Exported artifacts | Exported bytes attributed to sandbox admission day |

The header also shows execution count and elapsed runtime for today's admitted sandboxes.
These are accounting totals, not CPU or memory utilization. There are no daily, execution-count,
artifact-count, or project/global sandbox-count quotas.

## Create a sandbox

Choose **Create sandbox**. Lifetime and idle timeout are optional positive integer seconds;
leave blank for no expiry (the default). Explicit deadlines have no fixed policy ceiling.
Lifetime starts at admission, including time spent waiting/starting. Resource controls are set
by the host owner with `MYBASE_SANDBOX_CONFIG`; defaults are 1 CPU, 1024 MiB RAM, 128 MiB workspace,
and a 256-process limit. See [host configuration](sandboxes.md).

Creation opens its detail page immediately. A lifecycle strip tracks:

| State | Meaning / next step |
| --- | --- |
| Queued | Accepted durably; waiting for the worker |
| Starting | Worker is preparing the guest and Chromium |
| Ready | Submit code or transfer/export files |
| Stopping | Destruction is requested; wait for a terminal state before assuming capacity is free |
| Terminated | Explicitly stopped; temporary workspace is gone |
| Expired | Lifetime or idle deadline was reached |
| Failed | Provisioning, runtime, resource, or recovery failure; inspect the reason and execution stderr |

The detail page shows runtime, remaining lifetime (or finish time), resource allocation, full ID,
and the lifetime deadline. Idle expiry can happen earlier than the displayed lifetime deadline.
Terminal sandboxes cannot restart; create a new one for further work.

## Run code and inspect executions

Once Ready, choose **Run code**. Use ESM JavaScript with Playwright already installed, or a JSON
argument array such as `["node", "--version"]`. Commands do not get an implicit shell.
Optionally set a positive integer execution timeout in milliseconds, or leave blank for no timeout.

The example visits `example.com`, prints its title, and writes `page.png` in `/workspace`.
After it succeeds, export `page.png` from the Artifacts section to retain the screenshot.
Your calling app still owns model selection, prompts, extraction rules, and the agent loop.

Executions appear in a table with state, start time, duration, and exit code. Select one to see
its ID, stdout, and stderr. An active execution is selected automatically when no execution
is specified in the URL; otherwise the latest one is shown.

- Execution states: Queued, Running, Succeeded, Failed, Timed out, Cancelled.
- **Output arrives when an execution finishes**, not as a live log stream. Polling does not
  make partial output available.
- Each output stream defaults to a host-configurable 64 KiB cap. A truncation message means you should export large
  results as workspace files instead.
- Execution requests/code are not returned in history; the inspector shows results, not source.
- Sequential successful executions share filesystem/browser state, with no execution-count quota.
- Only one execution, transfer, or external CDP connection may use a sandbox at a time. A 409
  busy error can mean an SDK/CLI client holds it even when this page has no active execution.

## Transfer workspace files

On a ready sandbox with no active execution, choose **Workspace files**. Upload a local file
to a relative path such as `data/input.json`, or download a file by its known relative path.
Paths cannot be absolute or contain `.`/`..` segments. File size cap defaults to 8 MiB and is host-configurable.

There is no recursive workspace browser or directory-listing endpoint. Use code to inspect
directories if needed. Downloads go to your browser's download location. Uploads and code run
inside the same guest; never upload administrative credentials or model keys.

## Export and download artifacts

Choose **Export artifact**, enter its workspace path, and optionally give a MIME type such as
`image/png` or `application/json`. Export before the guest stops: workspace files disappear
on termination, expiry, timeout, cancellation, or runtime failure.

The Artifacts table shows the file name, type, byte size, SHA-256 checksum, expiration, and a
Download action. Artifacts are private authenticated attachments, not rendered inside the
dashboard. Downloads continue working after the guest stops until seven-day artifact expiry,
subject to sandbox metadata retention and the service remaining enabled. File size cap defaults
to 8 MiB and is host-configurable; there are no aggregate export-byte or artifact-count quotas.
Exporting identical path/content returns the existing artifact; changed contents create a version.

## Stop work

**Terminate** destroys the guest, browser, process tree, and temporary files. **Cancel execution**
also destroys the **entire sandbox**, not just the selected command. An execution timeout has the
same workspace-loss consequence. Export important files beforehand. Retained artifacts and run
history remain subject to seven-day retention.

Under **Setup → Turn off agent sandboxes**, disabling the service stops every project guest and
deletes its sandbox artifacts and history. This is broader than terminating a single sandbox.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Worker not configured/unreachable | Run `mybase server sandbox --project shop` on the Docker host; inspect `mybase server logs sandbox-worker` |
| Workspace busy or unavailable | Wait for the active execution/transfer/CDP lease, then retry |
| No stdout while Running | Output is collected at completion; use an exported file for large results |
| Expired while watching | Viewing/polling does not count as activity; idle expiry can precede the lifetime deadline |
| Failed after worker restart | Guest state is not checkpointed or automatically replayed; inspect reason and create a new sandbox |
| Artifact not found or expired | Check retention and whether the service was disabled; temporary files cannot be recovered after guest loss |

External browser automation uses the [SDK's authenticated CDP connection](sdk/sandboxes.md).
The dashboard does not provide live video or human browser takeover.

## Agent notes

- Share sandbox/execution URLs to point a human at specific results; do not share API keys or browser headers.
- Read terminal state, reason, exit code, and truncation before reporting success.
- Cancel/terminate are explicit operations; closing the dashboard or aborting a client poll does not cancel work.
- Export evidence before the sandbox stops, then refer to artifact IDs and retention deadlines.
