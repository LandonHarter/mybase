---
title: Agent sandboxes
summary: Temporary isolated JavaScript and Chromium workspaces, with durable jobs and private artifacts.
section: Services
order: 16
---

# Agent sandboxes

An optional project service for executing agent-controlled code and visiting untrusted pages.
The calling app owns model selection, prompts, tool loops, extraction schemas, and interpretation.
mybase supplies compute, lifecycle, authentication, browser transport, and artifact storage.
No model provider or model key is required.

## Start here

1. On the Linux Docker host, run `mybase server sandbox --project <project>`. This sets up
   gVisor, the matching images, and the trusted worker, then enables the project service.
2. Open the project in the dashboard and choose **Agent sandboxes → Runs**. Create a sandbox
   there, or from your server through the SDK or CLI. All three share the same run history.
3. Open a sandbox to run code, inspect execution results, transfer files, and export artifacts.
4. Export anything you need before terminating the sandbox or reaching its lifetime/idle deadline.

Choose a guide:

- [Dashboard and run history](sandbox-dashboard.md): visual status, executions, output, artifacts, and usage.
- [Agent sandbox client](sdk/sandboxes.md): TypeScript SDK, browser automation, files, and error handling.
- Continue below for host requirements, isolation, REST endpoints, and recovery behavior.

## Isolation and deployment

MVP uses Docker's **gVisor `runsc` runtime**, with Node.js 24 and Playwright 1.63.0 Chromium
headless shell. Guest image installs Chromium only (`--only-shell`), without Firefox/WebKit or
full GUI browser layers, reducing storage and download cost on the Pi.
Ordinary containers alone are not a sufficient hostile-code boundary. The worker refuses to
start without `runsc`, cgroup v2, and functioning resource controllers. There is no runc fallback.
Kata and Firecracker provide VM boundaries but require more host/kernel/image machinery; gVisor
is the smallest addition to this single-host Docker deployment. It still trusts gVisor, Docker,
the worker, and the host kernel; it is not a guarantee against vulnerabilities in those components.
Use a dedicated worker host when stronger separation from valuable host data is required.

Supported image architectures: Linux amd64 and arm64. Host must support a current gVisor release
on that architecture. Chromium runs headless with its inner sandbox disabled **inside gVisor**;
browser code shares the guest trust domain with agent code. No guest is shared between projects.
The guest has no host mounts, Docker socket, project credentials, model keys, application source,
or network interface. Files and browser profiles live in bounded tmpfs mounts; root filesystem is
read-only. CPU/memory/pids/no-new-privileges/capability limits apply to the complete guest.

### Automatic host setup

Run this once **on the Linux machine running the mybase Docker installation** (for a Pi, SSH into
it and run the command there). Add `--project` to enable the service immediately:

```sh
mybase server sandbox --project touse
```

For a non-default installation location, add `--dir /path/to/mybase`. Without a terminal, add
`--yes`. The equivalent shortcuts are `mybase server setup --sandboxes` during installation and
`mybase sandbox enable touse --setup-worker` for one project.

The host command automatically:

- checks Linux amd64/arm64, a local rootful Docker daemon, Linux 5.6+, and cgroup v2 CPU,
  memory, swap, and process controllers;
- downloads the official checksum-verified gVisor bundle if `runsc` is not registered, keeps its
  required sidecar binaries together, registers the runtime, and reloads Docker's runtime
  configuration without restarting existing containers (administrator/sudo access may be needed);
- preserves the existing tunnel/profile settings and worker key, generates a key if missing,
  derives denied control-plane/storage hostnames and the server's public IP, and adds the
  `sandbox` Compose profile;
- selects sandbox and worker images matching the installed API version (or commit-tagged master
  image), pulls missing images, and retains local/custom images without pulling them;
- launches a temporary, resource-limited Chromium under `runsc` to verify the actual isolation
  path before saving settings, then starts the worker and applies the API configuration;
- waits for worker/API health and optionally enables the project service.

No manual Docker commands, key generation, or `.env` editing are needed. Rerunning is safe:
existing settings and keys are retained, already registered gVisor is reused, and existing images
are not pulled again. `mybase server update` also pulls matching guest/worker images for
automatically managed installations; the guest is not a Compose service, so this extra step is
necessary. After host setup, creating and terminating individual sandboxes is automatic.

If public-IP detection is unavailable, pass `--deny-hosts <public-router/server-IP>`. Additional
comma-separated infrastructure hostnames can be included. Custom local images use
`--image mybase-sandbox:local --worker-image mybase-sandbox-worker:local`; build those from the
repository with `docker build -f docker/sandbox.Dockerfile -t mybase-sandbox:local .` and
`docker build -f docker/sandbox-worker.Dockerfile -t mybase-sandbox-worker:local .` first.

The command deliberately refuses Docker Desktop, rootless Docker, and remote Docker TCP endpoints:
run it on the actual Docker host instead. It does not install Docker or change kernel/cgroup boot
settings; if its prerequisite check identifies one of those problems, fix that host setting and
rerun the same command. Existing custom/remote worker URLs are not overwritten.

### Isolation boundary

Do not disable resource controls in runsc's configuration. Only one worker may manage a Docker
daemon: startup removes all containers labelled `mybase.sandbox=true` as orphans. Guest creation
never pulls an app-selected image. Worker port 4010 and browser port 9222 are never published.
The Compose worker alone gets the Docker socket; it is trusted host administration code, not a
sandbox. Its key authorizes privileged worker operations. Keep its network private. A remote worker
needs an authenticated TLS tunnel/VPN and firewall restriction to the API; plain HTTP over an
untrusted network is unsupported.

Default stack still starts without a worker. Default per-guest controls are 1 CPU, 1024 MiB memory, 256
pids, 128 MiB workspace, 256 MiB temporary browser space, and 64 MiB shm per guest. tmpfs counts
against memory; swap is disabled. There are no project/global sandbox-count quotas or daily budgets.
On a 4 GB Pi, one browser plus the backend can be tight; size concurrency for host headroom.
No Kubernetes, nested Docker, or privileged guest is involved.

### Host-owned resource and transfer controls

Set `MYBASE_SANDBOX_CONFIG` in the installation's `.env` to override per-guest controls. Compose
passes the same value to the API and worker; for custom deployments, set it on both processes.
Settings are read at startup. Restart/recreate the API and worker after changing them; new guests
use the updated resource settings. Apps cannot override these controls.

```dotenv
MYBASE_SANDBOX_CONFIG='{"resources":{"cpus":2,"memoryMb":2048,"workspaceMb":512},"limits":{"fileBytes":33554432,"outputBytes":262144,"networkStreams":64}}'
```

| Group | Setting | Default | Meaning |
| --- | --- | --- | --- |
| `resources` | `cpus` | 1 | CPU ceiling; positive fractions allowed |
| `resources` | `memoryMb` | 1024 | Guest memory ceiling, MiB; swap disabled |
| `resources` | `workspaceMb` | 128 | `/workspace` tmpfs size, MiB |
| `resources` | `tmpMb` | 256 | `/tmp` browser/tmpfs size, MiB |
| `resources` | `shmMb` | 64 | Shared memory size, MiB |
| `resources` | `pids` | 256 | Process ceiling |
| `limits` | `fileBytes` | 8388608 | Maximum uploaded/downloaded/exported file size |
| `limits` | `outputBytes` | 65536 | Captured bytes per stdout/stderr stream |
| `limits` | `networkStreams` | 32 | Simultaneous outbound TCP streams per guest |
| `limits` | `networkIdleMs` | 15000 | Outbound socket idle timeout |

All values must be positive; values other than `cpus` must be safe integers. Omitted settings
keep defaults; unknown names and invalid values fail startup. Resource controllers, path checks,
public-only egress, and bounded protocol frames/buffers remain enforced. HTTP upload limits also
apply (`MYBASE_MAX_UPLOAD`, default 1 GiB, and any reverse-proxy limit).

## Network boundary

Guests use `--network=none`. A local HTTP proxy transports streams over `docker exec` stdio to
the trusted worker. Only public unicast destinations on TCP 80/443 are allowed. Each connection
resolves DNS, rejects the entire answer set if any address is non-public/denied, and connects
directly to the selected IP. DNS is never resolved again during connect. IPv4 private, loopback,
link-local, CGNAT, metadata, reserved ranges and IPv6 transition/private ranges are refused.
Worker interface addresses plus configured infrastructure names and their resolved IPs are denied.
**List every public control-plane, storage, worker and router address/alias in DENY_HOSTS, including
NAT public IPs; update/restart worker when infrastructure addresses change.** Shared CDN IP denial
may also block unrelated sites on that CDN.

The boundary covers redirects, subresources, browser WebSockets, and arbitrary executed code:
there is no alternate NIC, DNS socket, UDP/QUIC, host gateway, or private route. A malicious agent
can bypass its proxy settings but then has no outbound transport. HTTP CONNECT supports HTTPS
and WSS. Non-HTTP clients must explicitly use the local proxy. Node's bundled version may not
honor proxy environment variables automatically: Playwright is configured explicitly; use its
browser response APIs for downloads. Browser-local loopback services are inside the same guest.
Guest code may exfiltrate anything deliberately supplied to it to public internet endpoints.

Default controls: 32 simultaneous network streams per sandbox and a 15-second idle socket timeout,
both host-configurable. There is no lifetime stream-count or traffic-byte quota. Protocol frames
and buffering remain bounded; relay failure or exceeded concurrent-stream/buffer limits terminates the guest.

## API and lifecycle

All routes below require authentication and project-scoped `sandbox:read` or `sandbox:write`.
Writes include execution, export, browser credential creation, and CDP upgrade (even though GET).
Normal API permission/project revocation applies at every request/upgrade. No browser token alone
grants access. Running CDP connections have no fixed lifetime; an explicitly configured sandbox
deadline, guest termination, or transport failure can still close them.

Base: `{{MYBASE_URL}}/sandbox/<project>`.

| Method/path | Result |
|---|---|
| POST base `{key, profile:"browser", ttlSeconds?, idleSeconds?}` | 202, durable sandbox; poll GET |
| GET base; GET `/<id>`; GET `/usage` | list, state, usage |
| DELETE `/<id>` | 202, request termination; poll until terminal |
| POST `/<id>/executions` `{key, code OR command:[], timeoutMs?}` | 202, durable execution |
| GET `/<id>/executions[/<execution>]` | bounded stdout/stderr and structured status |
| DELETE `/<id>/executions/<execution>` | cancel; destroys entire guest/process tree |
| PUT/GET `/<id>/files?path=<relative>` | binary upload/download, host-configured file cap (default 8 MiB) |
| POST `/<id>/artifacts` `{path,type?}` | export file to private Garage storage |
| GET `/<id>/artifacts[/<artifact>]` | metadata list / authenticated binary download |
| POST `/<id>/browser` | single-use credential, 30-second redemption deadline |
| GET `/<id>/browser` (WebSocket) | standard CDP; requires API auth + `X-Mybase-Browser-Token` |

States: `queued → provisioning → ready → stopping → terminated`; TTL/idle → `expired`;
provisioning, OOM, guest/relay loss, restart → `failed`. Terminal states never reopen.
Lifetime (`ttlSeconds`), idle expiry (`idleSeconds`), and execution timeout (`timeoutMs`) are
opt-in: omit or pass `null` for no deadline. Explicit values are positive integers in their named
units, without a fixed policy ceiling. Lifetime starts at admission. Sandbox `expiresAt` is `null`
when no lifetime was requested. Inspections do not reset an explicitly set idle timeout; work,
transfers and browser connections count as activity. Worker enforces requested deadlines
independently of API availability. Execution cannot outlive a requested sandbox lifetime. Explicit cancel/timeout destroys
the entire sandbox so forked descendants cannot survive. Workspace persistence ends there.

One execution/transfer/CDP connection at a time per sandbox; conflicts return 409 rather than
silently racing. Sequential successful commands share filesystem and browser state. ESM code
runs with Node in `/workspace`, with `playwright` installed. Commands are argv arrays, with no
implicit shell. No packages are installed from caller input. Output defaults to 64 KiB per
stream with `truncated` (host-configurable); there is no execution-count quota. Logs are execution stdout/stderr;
platform diagnostic logs never contain code, page content, URLs, browser headers, or artifacts.

Creation/execution require idempotency keys. Same key + same normalized input returns same ID;
different input returns 409. Keys/metadata remain seven days. A lost execution dispatch response
is never blindly replayed: sandbox is stopped and uncertain work is failed. Export is append-only;
retrying export of the same path and bytes returns the same artifact. A changed file creates a new version.

## Artifacts, usage, recovery

Artifacts are stored under a private `_mybase/sandboxes/<id>/…` prefix in the existing project
bucket. They include project/sandbox IDs, MIME type, byte size, SHA-256, and seven-day expiration.
Downloads always require authorization, are attachments with sandboxed content headers, and
stream binary bytes. No images are embedded in application JSON. As with all project storage,
the project's S3 credentials can access its own bucket (including sandbox artifacts).
File transfers/exports default to 8 MiB/file (host-configurable). There are no artifact-count,
per-sandbox aggregate byte, or daily export quotas. Pending exports count toward usage;
failed/crashed exports are deleted and their usage accounting reversed after five minutes.
Metadata is committed before object upload, so cleanup
always knows the object key. Retention cleanup runs each minute; expired downloads fail immediately.
Disabling service/project deletion stops guests before removing metadata/artifacts. Failed cleanup
must be retried; resources are not declared released while Docker is unreachable.

Admission/idempotency is transactional in Postgres. There are no daily runtime/allocation budgets
or sandbox-count quotas. Usage includes elapsed runtime, configured CPU/memory controls, executions,
and exported bytes, attributed to the sandbox's UTC admission day. `allocatedSecondsToday` sums
only explicitly requested lifetimes; it is accounting, not a budget. Legacy usage `limits` fields
are `null` to mean unlimited. Audit records creation,
execution requests, credential issuance, exports, terminal transitions and cancellation.

As with other mybase in-process runners, run **one API instance**. Scheduler polls once per second;
HTTP requests only admit work, never own its lifetime. API restart reattaches worker's live
sandboxes; missing runtimes fail. Worker restart kills labelled orphans before listening; all
interrupted sandboxes fail on API reconciliation. Guest state is never checkpointed/replayed.
Graceful API/worker shutdown requests guest destruction. After hard host failure, restart worker
to remove orphans; Docker restart policy for guests is `no`, tmpfs is lost. No jobs auto-resume.
Worker HTTP health is authenticated and reports active guests and configured resource controls after startup's runtime/controller validation;
runtime exit/OOM and cleanup are checked each second.

## touse example and diagnostics

```sh
mybase sandbox enable touse
mybase token create touse-agent --project touse --perm sandbox:write
MYBASE_API_KEY=mb_... bun examples/sandbox/touse.ts touse
# Optional live-site smoke (no reliability promise):
MYBASE_API_KEY=mb_... bun examples/sandbox/touse.ts touse https://example.com/listing
```

Controlled fixture renders details from JSON, expands a section/gallery, captures response image
bytes and rendered text, and exports screenshots, evidence, photos and manifest before terminating.
`examples/sandbox/agent-tools.ts` supplies provider-neutral tool definitions for an external agent loop.
The selector/field heuristics are example application policy, not backend features. Diagnostics
distinguish `page_blocked_or_challenged`, `navigation_failure`, `content_loaded_information_absent`,
`gallery_discovery_failure`, and `image_download_failure`. Chromium does not guarantee access to
Zillow or another protected site. Challenges are observable outcomes; no CAPTCHA bypass is supplied.

## Limitations and follow-up

No human takeover/live video, browser frames larger than 1 MiB,
arbitrary runtimes, package installation API, private network allowlists, GPU, VM checkpoint,
or multi-worker orchestration. CDP is Chromium-only and lower fidelity than Playwright's native
protocol. A timed-out/cancelled execution loses the guest; export important files first.
Artifact upload and DB commit use a pending/ready protocol; crashed pending exports are cleaned up
and must be retried afterward. Worker retains completed execution results for ten minutes after termination; if API
is unavailable longer, uncollected results can be lost and are marked failed on reconciliation.
Operational follow-up: durable per-execution partial output,
external worker fencing, and optional Kata VM profile.

## Verification

```sh
bun run typecheck
bun test
bun scripts/test-sandboxes.ts
docker build -f docker/sandbox.Dockerfile -t mybase-sandbox:local .
bun scripts/test-sandbox-runtime.ts
```

API integration tests create disposable Postgres, Garage and Valkey containers and a deterministic
worker double; existing databases are never migrated. Hardened-runtime checks require a configured
gVisor host and cover real Chromium/CDP, network denial, timeout/cancel process-tree destruction,
resource exhaustion, TTL and worker orphan recovery. `.github/workflows/sandbox.yml` runs these
checks on native amd64 and arm64 hosts. On hosts without runsc, `--fixture-only` runs the **trusted**
Chromium fixture and file helpers under runc; it does not verify hostile-code isolation. Live-site
checks are opt-in by providing a URL to the example, never part of deterministic CI.

## Agent notes

- Use `@mybase-dev/sdk/sandbox` and `sandbox:write` limited to your project; never put admin/model keys in code.
- Poll sandbox/execution status; check terminal reason, exit status and truncation explicitly.
- Fetch browser credentials just before connecting; pass headers to `chromium.connectOverCDP`.
- Keep extraction schema and site-specific actions in your application. Treat missing/blocked content as evidence.
- Export useful files before terminate/TTL; use artifact IDs for authorized downloads afterward.
