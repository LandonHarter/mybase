---
title: Agent sandboxes
summary: Temporary isolated JavaScript and Chromium workspaces, with durable jobs and private artifacts.
section: Services
order: 16
---

# Agent sandboxes

An optional project service for executing agent-controlled code and visiting untrusted pages.
The calling app owns model selection, prompts, tool loops, extraction schemas, and interpretation.
mybase supplies compute, lifecycle, quotas, authentication, browser transport, and artifact storage.
No model provider or model key is required.

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

Install Docker and gVisor following [gVisor's installation guide](https://gvisor.dev/docs/user_guide/install/),
register the `runsc` Docker runtime, and verify `docker run --rm --runtime=runsc --network=none
hello-world`. Check cgroup v2 CPU, memory, and pids controllers on the host. Do not disable
resource controls in runsc's configuration. Only one worker may manage a Docker daemon:
startup removes all containers labelled `mybase.sandbox=true` as orphans.

For a local build (from repo root):

```sh
docker build -f docker/sandbox.Dockerfile -t mybase-sandbox:local .
docker build -f docker/sandbox-worker.Dockerfile -t mybase-sandbox-worker:local .
```

Set these in the server's `.env`, preserving any existing profiles:

```dotenv
COMPOSE_PROFILES=sandbox,tunnel
MYBASE_SANDBOX_WORKER_URL=http://sandbox-worker:4010
MYBASE_SANDBOX_WORKER_KEY=<openssl rand -hex 32>
MYBASE_SANDBOX_DENY_HOSTS=mybase.example.com,s3.example.com,<public-router-or-worker-IP>
MYBASE_SANDBOX_IMAGE=mybase-sandbox:local
MYBASE_SANDBOX_WORKER_IMAGE=mybase-sandbox-worker:local
```

For releases, pre-pull `ghcr.io/landonharter/mybase-sandbox:<version>` and use the matching worker
image. Guest creation never pulls an app-selected image. Enable with `docker compose --profile
sandbox up -d`, then `mybase sandbox enable <project>`. Worker port 4010 and browser port 9222
are never published. The Compose worker alone gets the Docker socket; it is trusted host
administration code, not a sandbox. Its key authorizes privileged worker operations. Keep its
network private. A remote worker needs an authenticated TLS tunnel/VPN and firewall restriction
to the API; plain HTTP over an untrusted network is unsupported.

Default stack still starts without a worker. This profile reserves 1 CPU, 1024 MiB memory, 256
pids, 128 MiB workspace, 256 MiB temporary browser space, and 64 MiB shm per guest. tmpfs counts
against memory; swap is disabled. Global capacity is two guests, one per project. On a 4 GB Pi,
one browser plus the backend can be tight; measure host headroom before enabling this profile.
No Kubernetes, nested Docker, or privileged guest is involved.

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

Limits: 32 simultaneous / 1024 lifetime network streams per sandbox, 128 MiB encoded relay traffic per lifetime, 15-second
idle socket timeout, bounded frames and buffering. Relay exhaustion/failure terminates guest.
The stdio transport favors bounded small evidence collection over bulk downloads.

## API and lifecycle

All routes below require authentication and project-scoped `sandbox:read` or `sandbox:write`.
Writes include execution, export, browser credential creation, and CDP upgrade (even though GET).
Normal API permission/project revocation applies at every request/upgrade. No browser token alone
grants access. Running CDP connections have a hard 60-second lease.

Base: `{{MYBASE_URL}}/sandbox/<project>`.

| Method/path | Result |
|---|---|
| POST base `{key, profile:"browser", ttlSeconds?, idleSeconds?}` | 202, durable sandbox; poll GET |
| GET base; GET `/<id>`; GET `/usage` | list, state, quota/usage |
| DELETE `/<id>` | 202, request termination; poll until terminal |
| POST `/<id>/executions` `{key, code OR command:[], timeoutMs?}` | 202, durable execution |
| GET `/<id>/executions[/<execution>]` | bounded stdout/stderr and structured status |
| DELETE `/<id>/executions/<execution>` | cancel; destroys entire guest/process tree |
| PUT/GET `/<id>/files?path=<relative>` | binary upload/download, maximum 8 MiB |
| POST `/<id>/artifacts` `{path,type?}` | export file to private Garage storage |
| GET `/<id>/artifacts[/<artifact>]` | metadata list / authenticated binary download |
| POST `/<id>/browser` | single-use credential, 30-second redemption deadline |
| GET `/<id>/browser` (WebSocket) | standard CDP; requires API auth + `X-Mybase-Browser-Token` |

States: `queued → provisioning → ready → stopping → terminated`; TTL/idle → `expired`;
provisioning, OOM, guest/relay loss, restart → `failed`. Terminal states never reopen.
TTL is 10–600 seconds from admission (default 300), idle 10–300 (default 120). Inspections do
not renew idle lifetime; work, transfers and browser connections count as activity. Worker
enforces TTL/idle independently of API availability. A busy execution cannot exceed its own
100–120000 ms timeout (default 30000) or sandbox lifetime. Explicit cancel/timeout destroys
the entire sandbox so forked descendants cannot survive. Workspace persistence ends there.

One execution/transfer/CDP connection at a time per sandbox; conflicts return 409 rather than
silently racing. Sequential successful commands share filesystem and browser state. ESM code
runs with Node in `/workspace`, with `playwright` installed. Commands are argv arrays, with no
implicit shell. No packages are installed from caller input. Output is capped at 64 KiB per
stream with `truncated`, and maximum 120 executions per sandbox. Logs are execution stdout/stderr;
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
Maximum 8 MiB/file, 32 MiB exported bytes and 100 artifacts/sandbox, 100 MiB exported bytes per
project admission day. Pending exports reserve bytes; failed/crashed exports are deleted and their
reservations released after five minutes. Metadata is committed before object upload, so cleanup
always knows the object key. Retention cleanup runs each minute; expired downloads fail immediately.
Disabling service/project deletion stops guests before removing metadata/artifacts. Failed cleanup
must be retried; resources are not declared released while Docker is unreachable.

Quota admission is transactional in Postgres: one live sandbox/project, two globally, 3600
allocated TTL-seconds per project UTC admission day. Reserved TTL budget is not refunded, preventing
cheap create/kill churn. Usage includes elapsed runtime, fixed CPU/memory allocation, executions,
and exported bytes. Usage is attributed to the sandbox's admission day. Audit records creation,
execution requests, credential issuance, exports, terminal transitions and cancellation.

As with other mybase in-process runners, run **one API instance**. Scheduler polls once per second;
HTTP requests only admit work, never own its lifetime. API restart reattaches worker's live
sandboxes; missing runtimes fail. Worker restart kills labelled orphans before listening; all
interrupted sandboxes fail on API reconciliation. Guest state is never checkpointed/replayed.
Graceful API/worker shutdown requests guest destruction. After hard host failure, restart worker
to remove orphans; Docker restart policy for guests is `no`, tmpfs is lost. No jobs auto-resume.
Worker HTTP health is authenticated, checks capacity after startup's runtime/controller validation;
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

No human takeover/live video, downloads larger than 8 MiB, browser frames larger than 1 MiB,
arbitrary runtimes, package installation API, private network allowlists, GPU, VM checkpoint,
or multi-worker orchestration. CDP is Chromium-only and lower fidelity than Playwright's native
protocol. A timed-out/cancelled execution loses the guest; export important files first.
Artifact upload and DB commit use a pending/ready protocol; crashed pending exports are cleaned up
and must be retried afterward. Worker retains completed execution results for ten minutes after termination; if API
is unavailable longer, uncollected results can be lost and are marked failed on reconciliation.
Operational follow-up: configurable per-project policy, durable per-execution partial output,
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
