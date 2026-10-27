import { Container } from "@cloudflare/containers";

// Required for outbound interception (outboundByHost): the platform routes intercepted calls through it.
export { ContainerProxy } from "@cloudflare/containers";

export interface MultiEnv {
  ID_WEB_CONTAINER: DurableObjectNamespace<IdWebContainer>;
  ID_API_CONTAINER: DurableObjectNamespace<IdApiContainer>;
  ID_UMS_CONTAINER: DurableObjectNamespace<IdUmsContainer>;
  BI_WEB_CONTAINER: DurableObjectNamespace<BiWebContainer>;
  BI_API_CONTAINER: DurableObjectNamespace<BiApiContainer>;
  BI_JOBS_CONTAINER: DurableObjectNamespace<BiJobsContainer>;
  BI_DESIGNER_CONTAINER: DurableObjectNamespace<BiDesignerContainer>;
  BI_ETL_CONTAINER: DurableObjectNamespace<BiEtlContainer>;
  BOLD_AI_CONTAINER: DurableObjectNamespace<BoldAiContainer>;
  BOLD_MCP_CONTAINER: DurableObjectNamespace<BoldMcpContainer>;

  // Optional overrides / secrets
  SERVICE_COMMUNICATION?: string; // "internal" (default) | "public_url"
  INTERNAL_SERVICE_KEYS?: string; // optional: limit internal mode to these keys (troubleshooting)
  APP_BASE_URL?: string;
  ADMIN_TOKEN?: string; // enables POST /_internal/restart and /_internal/diag/*
  DIAG_ENABLED?: string; // "true" records timing for internal calls (Server-Timing header + structured console.log)

  // Shared file storage (AWS S3, vendor "storage type 3")
  BOLD_SERVICES_AMAZON_BUCKET_NAME?: string;
  BOLD_SERVICES_AMAZON_ROOTFOLDER_NAME?: string;
  BOLD_SERVICES_AWS_REGION?: string;
  BOLD_SERVICES_AWS_ACCESS_KEY_ID?: string;
  BOLD_SERVICES_AWS_SECRET_ACCESS_KEY?: string;
}

const S3_KEYS = [
  "BOLD_SERVICES_AMAZON_BUCKET_NAME",
  "BOLD_SERVICES_AMAZON_ROOTFOLDER_NAME",
  "BOLD_SERVICES_AWS_REGION",
  "BOLD_SERVICES_AWS_ACCESS_KEY_ID",
  "BOLD_SERVICES_AWS_SECRET_ACCESS_KEY",
] as const;

// Every service gets the S3 settings. Database settings are entered manually on the UMS startup page.
export function buildContainerEnv(requestUrl: string, env: MultiEnv): Record<string, string> {
  const url = new URL(requestUrl);
  const vars: Record<string, string> = {
    APP_BASE_URL: env.APP_BASE_URL || `${url.protocol}//${url.host}`,
    BOLD_SERVICES_PV_USED: "false",
    BOLD_SERVICES_HOSTING_ENVIRONMENT: "docker",
    // The entrypoint only writes local_service_url.json for a recognised DEPLOY_MODE (vendor compose value).
    DEPLOY_MODE: "docker_multi_container",
    INSTALL_OPTIONAL_LIBS: "mongodb,mysql,influxdb,snowflake,oracle,clickhouse,google",
    BOLD_SERVICES_CONSOLE_LOG_ENABLED: "true",
  };

  if (env.BOLD_SERVICES_AMAZON_BUCKET_NAME) {
    vars.BOLD_SERVICES_STORAGETYPE = "3";
    for (const k of S3_KEYS) if (env[k]) vars[k] = env[k]!;
  }

  return vars;
}

function secureApplicationResponse(response: Response, publicUrl: URL): Response {
  if (publicUrl.protocol !== "https:" || response.status === 101) return response;
  const html = /\btext\/html\b/i.test(response.headers.get("Content-Type") ?? "");
  let upgradedLocation: string | undefined;
  const location = response.headers.get("Location");
  if (location) {
    try {
      const target = new URL(location, publicUrl);
      if (target.protocol === "http:" && target.host === publicUrl.host) {
        target.protocol = "https:";
        upgradedLocation = target.href;
      }
    } catch { /* Preserve unparseable locations */ }
  }
  if (!html && !upgradedLocation) return response;

  const secured = new Response(response.body, response);
  if (html && !secured.headers.get("Content-Security-Policy")?.includes("upgrade-insecure-requests")) {
    secured.headers.append("Content-Security-Policy", "upgrade-insecure-requests");
  }
  if (upgradedLocation) secured.headers.set("Location", upgradedLocation);
  return secured;
}

// The stock port check sends an HTTP request. Bold BI answers each one by resolving a tenant through
// the IdP and S3 (several seconds), so the 5s probes time out and pile up and the container never
// reports ready. A TCP connect is enough: Kestrel only listens once the app is up.
class BoldContainer extends Container<MultiEnv> {
  override async waitForPort(waitOptions: Parameters<Container["waitForPort"]>[0]): Promise<number> {
    const tcpPort = this.ctx.container!.getTcpPort(waitOptions.portToCheck);
    const interval = waitOptions.waitInterval ?? 300;
    const tries = waitOptions.retries ?? Math.ceil(30_000 / interval);
    for (let i = 0; i < tries; i++) {
      try {
        const socket = tcpPort.connect(`ping:${waitOptions.portToCheck}`);
        await socket.opened;
        await socket.close();
        return i;
      } catch (e) {
        if (!this.ctx.container?.running || i === tries - 1) throw e;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
    return tries;
  }
}

// local_service_url.json: where each Bold service reaches the others.
//
// The vendor entrypoint (DEPLOY_MODE=docker_multi_container) writes Docker hostnames, which do not exist on
// Cloudflare, so we write the file first (the vendor script keeps an existing file that has no localhost/port
// and contains the Mcp/ReportsAi/ReportsMcp nodes). In the vendor's own Docker, ECS and Kubernetes modes EVERY key
// holds an address that only containers can reach (e.g. http://id-web-service:6000), so this file is
// backend-only; browser URLs come from APP_BASE_URL and the tenant domain. All keys can therefore be internal.
//
//   public:   the Worker's public URL + path (the Worker routes it) - used by SERVICE_COMMUNICATION=public_url
//   internal: http://<service-host><path> - the container's outbound call to <service-host> is intercepted
//             (outboundByHost, see OUTBOUND_HOSTS) and delivered straight to the target Durable Object.
//             Hosts and paths mirror the vendor's docker_multi_container block (the ETL prefix is not used
//             internally because the vendor nginx strips /etlservice).
export const SERVICE_URLS: Record<string, { publicPath: string; internal: string }> = {
  Idp: { publicPath: "", internal: "http://id-web" },
  IdpApi: { publicPath: "/api", internal: "http://id-api/api" },
  Ums: { publicPath: "/ums", internal: "http://id-ums/ums" },
  Bi: { publicPath: "/bi", internal: "http://bi-web/bi" },
  BiApi: { publicPath: "/bi/api", internal: "http://bi-api/bi/api" },
  BiJob: { publicPath: "/bi/jobs", internal: "http://bi-jobs/bi/jobs" },
  BiDesigner: { publicPath: "/bi/designer", internal: "http://bi-designer/bi/designer" },
  BiDesignerHelper: { publicPath: "/bi/designer/helper", internal: "http://bi-designer/bi/designer/helper" },
  Etl: { publicPath: "/etlservice", internal: "http://bi-etl" },
  EtlBlazor: { publicPath: "/etlservice/framework/blazor.server.js", internal: "http://bi-etl/framework/blazor.server.js" },
  Ai: { publicPath: "/aiservice", internal: "http://bold-ai/aiservice" },
  Mcp: { publicPath: "/mcp", internal: "http://bold-mcp/mcp" },
  // Bold Reports services are not part of this deployment (no containers); names follow the vendor block.
  Reports: { publicPath: "/reporting", internal: "http://reports-web/reporting" },
  ReportsApi: { publicPath: "/reporting/api", internal: "http://reports-api/reporting/api" },
  ReportsJob: { publicPath: "/reporting/jobs", internal: "http://reports-jobs/reporting/jobs" },
  ReportsService: { publicPath: "/reporting/reportservice", internal: "http://reports-reportservice/reporting/reportservice" },
  ReportsViewer: { publicPath: "/reporting/viewer", internal: "http://reports-viewer/reporting/viewer" },
  ReportsAi: { publicPath: "/reportsai", internal: "http://reports-ai/reportsai" },
  ReportsMcp: { publicPath: "/reportsmcp", internal: "http://reports-mcp/reportsmcp" },
};

export type CommunicationMode = "internal" | "public_url";

export function communicationMode(env: Pick<MultiEnv, "SERVICE_COMMUNICATION">): CommunicationMode {
  return (env.SERVICE_COMMUNICATION ?? "").trim().toLowerCase() === "public_url" ? "public_url" : "internal";
}

// Keys that use internal URLs. Default (internal mode): all of them. INTERNAL_SERVICE_KEYS (optional, comma
// separated) restricts internal mode to the listed keys for troubleshooting; the others stay public.
export function internalKeysFor(env: Pick<MultiEnv, "SERVICE_COMMUNICATION" | "INTERNAL_SERVICE_KEYS">): string[] {
  if (communicationMode(env) === "public_url") return [];
  const all = Object.keys(SERVICE_URLS);
  if (!env.INTERNAL_SERVICE_KEYS?.trim()) return all;
  const wanted = env.INTERNAL_SERVICE_KEYS.split(",").map((k) => k.trim());
  return all.filter((k) => wanted.includes(k));
}

export function buildServiceUrls(baseUrl: string, internalKeys: string[]): Record<string, string> {
  const base = baseUrl.replace(/\/+$/, "");
  return Object.fromEntries(
    Object.entries(SERVICE_URLS).map(([k, v]) => [k, internalKeys.includes(k) ? v.internal : `${base}${v.publicPath}`]),
  );
}

// The entrypoint override: writes the URL file from APP_BASE_URL (set per request), then runs the vendor script.
export function buildServiceEntrypoint(internalKeys: string[]): string[] {
  const json = JSON.stringify(
    Object.fromEntries(
      Object.entries(SERVICE_URLS).map(([k, v]) => [k, internalKeys.includes(k) ? v.internal : `\u0024base${v.publicPath}`]),
    ),
  ).replace(/\\u0024/g, "$");
  return [
    "bash",
    "-c",
    `set -eu; base="\${APP_BASE_URL%/}"; dir=/application/app_data/configuration; mkdir -p "$dir"; chmod 777 "$dir"; ` +
      `printf '%s' "${json.replace(/"/g, '\\"')}" > "$dir/local_service_url.json"; exec bash entrypoint.sh`,
  ];
}

// TEMPORARY diagnostic: health-check paths per internal host, used by /_internal/ping-internal.
const INTERNAL_HEALTH_PATHS: Record<string, string> = {
  "id-web": "/health-check", "id-api": "/api/health-check", "id-ums": "/ums/health-check",
  "bi-web": "/bi/health-check", "bi-api": "/bi/api/health-check", "bi-jobs": "/bi/jobs/health-check",
  "bi-designer": "/bi/designer/health-check", "bi-etl": "/health-check", "bold-ai": "/health-check", "bold-mcp": "/health-check",
};

abstract class BoldServiceContainer extends BoldContainer {
  defaultPort = 80;
  protected servicePort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  // TEMPORARY diagnostic: runs inside this container and calls http://<host><health path> so the call goes
  // through the outbound interception. Uses curl when present, otherwise bash /dev/tcp.
  async pingInternal(host: string): Promise<{ host: string; ok: boolean; status?: string; ms?: number; error?: string }> {
    const path = INTERNAL_HEALTH_PATHS[host];
    if (!path) return { host, ok: false, error: "unknown host" };
    if (!this.ctx.container?.running) return { host, ok: false, error: "caller container is not running" };
    const script =
      `url="http://${host}${path}"; s=$(date +%s%N); ` +
      `if command -v curl >/dev/null 2>&1; then code=$(curl -s -o /dev/null -m 60 -w '%{http_code}' "$url") || code=curl-failed; ` +
      `else exec 3<>/dev/tcp/${host}/80 && printf 'GET ${path} HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n' >&3 && read -r -t 60 line <&3 && code=$(echo "$line" | cut -d' ' -f2) || code=tcp-failed; fi; ` +
      `e=$(date +%s%N); echo "$code $(( (e - s) / 1000000 ))"`;
    try {
      const proc = await this.ctx.container.exec(["bash", "-c", script]);
      const out = await proc.output();
      const [status, ms] = new TextDecoder().decode(out.stdout).trim().split(" ");
      const ok = /^[23]\d\d$/.test(status ?? "");
      return { host, ok, status, ms: Number(ms), error: ok ? undefined : new TextDecoder().decode(out.stderr).slice(0, 200) || undefined };
    } catch (e) {
      return { host, ok: false, error: String(e) };
    }
  }

  // DIAGNOSTIC (admin only): run a script inside this container and return stdout/ms. Inputs are validated by callers.
  async diagExec(script: string): Promise<{ ok: boolean; out: string; err?: string }> {
    if (!this.ctx.container?.running) return { ok: false, out: "", err: "container is not running (not started yet)" };
    try {
      const proc = await this.ctx.container.exec(["bash", "-c", script]);
      const r = await proc.output();
      return { ok: true, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).slice(0, 300) || undefined };
    } catch (e) {
      return { ok: false, out: "", err: String(e) };
    }
  }

  // Stops the container so the next request starts a fresh one (re-writes local_service_url.json, re-reads env).
  async restartContainer(): Promise<boolean> {
    if (!this.ctx.container?.running) return false;
    await this.destroy();
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    let startMs = 0;
    if (!this.ctx.container?.running) {
      const t0 = Date.now();
      await this.startAndWaitForPorts({
        ports: this.servicePort,
        startOptions: { envVars: buildContainerEnv(request.url, this.env), entrypoint: buildServiceEntrypoint(internalKeysFor(this.env)) },
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
      startMs = Date.now() - t0;
    }
    const t1 = Date.now();
    const response = await super.fetch(request);
    return withTiming(response, `container-start;dur=${startMs}, container-app;dur=${Date.now() - t1}`);
  }
}

// Server-Timing lets us see where time goes: container-start (cold start), container-app (time until the
// app returned headers), worker-total (whole Worker), so hop overhead = worker-total - container-start - container-app.
function withTiming(response: Response, value: string): Response {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  const prev = out.headers.get("Server-Timing");
  out.headers.set("Server-Timing", prev ? `${prev}, ${value}` : value);
  return out;
}

// Internal hostname -> container. Used for intercepted container-to-container calls.
let lastPublicBase = "";
function internalTarget(env: MultiEnv, host: string): { fetch(r: Request): Promise<Response> } | undefined {
  switch (host) {
    case "id-web": return env.ID_WEB_CONTAINER.getByName("id-web");
    case "id-api": return env.ID_API_CONTAINER.getByName("id-api");
    case "id-ums": return env.ID_UMS_CONTAINER.getByName("id-ums");
    case "bi-web": return env.BI_WEB_CONTAINER.getByName("bi-web");
    case "bi-api": return env.BI_API_CONTAINER.getByName("bi-api");
    case "bi-jobs": return env.BI_JOBS_CONTAINER.getByName("bi-jobs");
    case "bi-designer": return env.BI_DESIGNER_CONTAINER.getByName("bi-designer");
    case "bi-etl": return env.BI_ETL_CONTAINER.getByName("bi-etl");
    case "bold-ai": return env.BOLD_AI_CONTAINER.getByName("bold-ai");
    case "bold-mcp": return env.BOLD_MCP_CONTAINER.getByName("bold-mcp");
  }
  return undefined;
}

// Samples kept per isolate (best effort: the outbound handler may run in a different isolate than the public
// fetch handler, so the structured console.log lines are the authoritative source for percentiles).
const internalStats = new Map<string, { totals: number[]; apps: number[]; errors: number }>();
const MAX_SAMPLES = 2000;

export function recordInternal(host: string, totalMs: number, appMs: number | undefined, error: boolean): void {
  const s = internalStats.get(host) ?? { totals: [], apps: [], errors: 0 };
  s.totals.push(totalMs);
  if (appMs !== undefined) s.apps.push(appMs);
  if (error) s.errors++;
  if (s.totals.length > MAX_SAMPLES) s.totals.shift();
  if (s.apps.length > MAX_SAMPLES) s.apps.shift();
  internalStats.set(host, s);
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  return { n: v.length, avg: avg === null ? null : Math.round(avg), p50: percentile(v, 50), p95: percentile(v, 95), p99: percentile(v, 99) };
}

export function internalStatsReport() {
  return Object.fromEntries(
    [...internalStats].map(([host, s]) => [host, { total: summarize(s.totals), app: summarize(s.apps), errors: s.errors }]),
  );
}

function appDuration(serverTiming: string | null): number | undefined {
  const m = /container-app;dur=([\d.]+)/.exec(serverTiming ?? "");
  return m ? Number(m[1]) : undefined;
}

export async function forwardInternal(request: Request, env: MultiEnv): Promise<Response> {
  const diag = env.DIAG_ENABLED === "true";
  const t0 = Date.now();
  const url = new URL(request.url);
  const target = internalTarget(env, url.hostname);
  if (!target) return new Response(`Unknown internal service ${url.hostname}`, { status: 502 });
  // Same forwarding headers the public path sets, so the app resolves the tenant by the public host.
  const base = new URL(env.APP_BASE_URL || lastPublicBase || "https://localhost");
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Proto", base.protocol.slice(0, -1));
  headers.set("X-Forwarded-Host", base.host);
  if (!diag) return target.fetch(new Request(request, { headers }));

  // Diagnostics only. Stages observable here: stub resolution, and the target fetch (DO RPC + container start + app).
  const tStub = Date.now();
  let response: Response;
  try {
    response = await target.fetch(new Request(request, { headers }));
  } catch (e) {
    recordInternal(url.hostname, Date.now() - t0, undefined, true);
    console.log(JSON.stringify({ diag: "internal", host: url.hostname, method: request.method, path: url.pathname, error: String(e), totalMs: Date.now() - t0 }));
    throw e;
  }
  const tDone = Date.now();
  const timing = response.headers.get("Server-Timing");
  const appMs = appDuration(timing);
  const totalMs = tDone - t0;
  recordInternal(url.hostname, totalMs, appMs, response.status >= 500);
  console.log(JSON.stringify({
    diag: "internal", host: url.hostname, method: request.method, path: url.pathname, status: response.status,
    totalMs, prepMs: tStub - t0, targetFetchMs: tDone - tStub, appMs,
    // targetFetchMs - appMs = DO RPC + container.fetch overhead (+ container start when cold)
    overheadMs: appMs === undefined ? undefined : tDone - tStub - appMs,
  }));
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.append("Server-Timing", `internal-forward;dur=${totalMs}`);
  return out;
}

export class IdWebContainer extends BoldServiceContainer {}
export class IdApiContainer extends BoldServiceContainer {}
export class IdUmsContainer extends BoldServiceContainer {}
export class BiWebContainer extends BoldServiceContainer {}
export class BiApiContainer extends BoldServiceContainer {}
export class BiJobsContainer extends BoldServiceContainer {}
export class BiDesignerContainer extends BoldServiceContainer {}
export class BiEtlContainer extends BoldServiceContainer {}
export class BoldAiContainer extends BoldServiceContainer {
  override defaultPort = 8080; // the AI service listens on 8080 (vendor nginx: proxy_pass bold-ai:8080)
  protected override servicePort = 8080;
}
export class BoldMcpContainer extends BoldServiceContainer {}

export const OUTBOUND_HOSTS = ["id-web", "id-api", "id-ums", "bi-web", "bi-api", "bi-jobs", "bi-designer", "bi-etl", "bold-ai", "bold-mcp"];
for (const cls of [IdWebContainer, IdApiContainer, IdUmsContainer, BiWebContainer, BiApiContainer, BiJobsContainer, BiDesignerContainer, BiEtlContainer, BoldAiContainer, BoldMcpContainer]) {
  cls.outboundByHost = Object.fromEntries(
    OUTBOUND_HOSTS.map((h) => [h, (req: Request, env: unknown) => forwardInternal(req, env as MultiEnv)]),
  );
}

type DiagContainer = { diagExec(script: string): Promise<{ ok: boolean; out: string; err?: string }> };
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._~\/-]{0,200}$/;

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// /_internal/diag/stats                       per-host internal forward stats (this isolate only)
// /_internal/diag/trace?host=all|id-web,...   container egress colo via cdn-cgi/trace (approximates container location)
// /_internal/diag/curl?from=bi-web&to=bi-api&path=/bi/api/health-check&n=20   timing breakdown per request, run inside "from"
// /_internal/diag/tcp?from=bi-api&host=<db-or-s3-host>&port=5432&n=10         TCP connect time from inside the container
// /_internal/diag/resources?host=all          load average, memory, CPU count, uptime inside each container
async function handleDiag(path: string, url: URL, env: MultiEnv): Promise<Response> {
  const hostsParam = url.searchParams.get("host") ?? "all";
  const hosts = hostsParam === "all" ? OUTBOUND_HOSTS : hostsParam.split(",").filter((h) => OUTBOUND_HOSTS.includes(h));
  const exec = (h: string, script: string) => (internalTarget(env, h) as unknown as DiagContainer).diagExec(script);

  if (path === "/_internal/diag/stats") return Response.json({ note: "samples are per isolate; use DIAG_ENABLED logs for full percentiles", hosts: internalStatsReport() });

  if (path === "/_internal/diag/trace") {
    const out: Record<string, unknown> = {};
    for (const h of hosts) {
      const r = await exec(h, "curl -s -m 10 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(colo|loc|ip|http)=' | tr '\\n' ' '");
      out[h] = r.ok ? r.out : r.err;
    }
    return Response.json({ worker: { colo: (url as unknown as { cf?: { colo?: string } }).cf?.colo ?? null }, containers: out });
  }

  if (path === "/_internal/diag/resources") {
    const out: Record<string, unknown> = {};
    for (const h of hosts) {
      const r = await exec(h, "echo \"cpus=$(nproc) load=$(cut -d' ' -f1-3 /proc/loadavg) $(grep -E 'MemTotal|MemAvailable' /proc/meminfo | tr -s ' ' | tr '\\n' ' ') uptime_s=$(cut -d. -f1 /proc/uptime)\"; cat /sys/fs/cgroup/cpu.stat 2>/dev/null | grep -E 'throttled|nr_periods' | tr '\\n' ' '");
      out[h] = r.ok ? r.out : r.err;
    }
    return Response.json(out);
  }

  const from = url.searchParams.get("from") ?? "";
  if (!OUTBOUND_HOSTS.includes(from)) return Response.json({ error: "from must be one of " + OUTBOUND_HOSTS.join(",") }, { status: 400 });
  const n = clampInt(url.searchParams.get("n"), 10, 1, 100);

  if (path === "/_internal/diag/curl") {
    const to = url.searchParams.get("to") ?? "";
    const p = url.searchParams.get("path") ?? "/";
    const target = url.searchParams.get("target"); // optional absolute public URL host (for public_url comparison)
    if (!SAFE_PATH.test(p)) return Response.json({ error: "bad path" }, { status: 400 });
    let base: string;
    if (target) {
      if (!SAFE_HOST.test(target)) return Response.json({ error: "bad target" }, { status: 400 });
      base = `https://${target}`;
    } else {
      if (!OUTBOUND_HOSTS.includes(to)) return Response.json({ error: "to must be an internal host or pass target=<public host>" }, { status: 400 });
      base = `http://${to}`;
    }
    // One curl per iteration (new connection each time, matching a fresh outbound call). Fields: code, dns, connect, ttfb, total (ms).
    const script = `for i in $(seq 1 ${n}); do curl -s -o /dev/null -m 60 -w '%{http_code} %{time_namelookup} %{time_connect} %{time_starttransfer} %{time_total}\\n' "${base}${p}" || echo "000 0 0 0 0"; done`;
    const r = await exec(from, script);
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    const rows = r.out.split("\n").map((l) => l.trim().split(" ")).filter((c) => c.length === 5);
    const col = (i: number) => rows.map((c) => Math.round(Number(c[i]) * 1000));
    const errors = rows.filter((c) => !/^[23]/.test(c[0])).length;
    return Response.json({
      from, url: `${base}${p}`, n: rows.length, errors, errorRate: rows.length ? errors / rows.length : null,
      ms: { dns: summarize(col(1)), connect: summarize(col(2)), ttfb: summarize(col(3)), total: summarize(col(4)) },
      note: "first sample may include cold start; discard it or warm up first",
    });
  }

  if (path === "/_internal/diag/tcp") {
    const host = url.searchParams.get("host") ?? "";
    const port = clampInt(url.searchParams.get("port"), 0, 1, 65535);
    if (!SAFE_HOST.test(host) || !port) return Response.json({ error: "host and port required" }, { status: 400 });
    const script = `for i in $(seq 1 ${n}); do s=$(date +%s%N); (exec 3<>/dev/tcp/${host}/${port}) 2>/dev/null && r=ok || r=fail; e=$(date +%s%N); echo "$r $(( (e - s) / 1000000 ))"; done`;
    const r = await exec(from, script);
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    const rows = r.out.split("\n").map((l) => l.trim().split(" "));
    return Response.json({
      from, host, port, errors: rows.filter((c) => c[0] !== "ok").length,
      connectMs: summarize(rows.filter((c) => c[0] === "ok").map((c) => Number(c[1]))),
      note: "TCP connect only (includes DNS). For S3 this is network RTT; HTTPS/API time is measured with /diag/curl target=<bucket host>.",
    });
  }

  return new Response("Not found", { status: 404 });
}

const HEALTH_PATHS = new Set(["/health-check", "/api/health-check", "/ums/health-check"]);
const HEALTH_TTL_MS = 5000;
const healthCache = new Map<string, { at: number; status: number; body: string }>();

export default {
  async fetch(request: Request, env: MultiEnv): Promise<Response> {
    const startedAt = Date.now();
    const publicUrl = new URL(request.url);
    lastPublicBase = publicUrl.origin;
    const path = publicUrl.pathname;

    // Internal diagnostics
    if (path === "/_internal/health") {
      return Response.json({
        ok: true,
        mode: "multi-container-spike",
        services: ["id-web", "id-api", "id-ums", "bi-web", "bi-api", "bi-jobs", "bi-designer", "bi-etl", "bold-ai", "bold-mcp"],
      });
    }

    // POST /_internal/restart?host=all|id-api,bi-web  (header X-Admin-Token must equal the ADMIN_TOKEN secret).
    // Needed because `wrangler deploy` does not restart containers when only the Worker code changed.
    if (path === "/_internal/restart") {
      if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
      const hostParam = publicUrl.searchParams.get("host") ?? "all";
      const hosts = hostParam === "all" ? OUTBOUND_HOSTS : hostParam.split(",").filter((h) => OUTBOUND_HOSTS.includes(h));
      const results: Record<string, string> = {};
      for (const h of hosts) {
        try {
          const c = internalTarget(env, h) as unknown as { restartContainer(): Promise<boolean> };
          results[h] = (await c.restartContainer()) ? "restarted" : "was not running";
        } catch (e) {
          results[h] = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return Response.json({ results });
    }

    // TEMPORARY diagnostic: /_internal/ping-internal?from=id-ums&to=id-api,bi-api,bi-jobs
    // Makes the running "from" container call each "to" host over its internal URL and reports status and time.
    if (path === "/_internal/ping-internal") {
      const from = publicUrl.searchParams.get("from") ?? "id-ums";
      const targets = (publicUrl.searchParams.get("to") ?? "id-api,bi-api,bi-jobs").split(",").filter((h) => h in INTERNAL_HEALTH_PATHS);
      const caller = internalTarget(env, from) as unknown as { pingInternal?(h: string): Promise<unknown> } | undefined;
      if (!caller?.pingInternal) return Response.json({ error: `unknown from host ${from}` }, { status: 400 });
      const results = [];
      for (const h of targets) results.push(await caller.pingInternal(h));
      return Response.json({ from, results });
    }

    // DIAGNOSTICS (admin only, read-only). See multi/DIAGNOSTICS.md.
    if (path.startsWith("/_internal/diag/")) {
      if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) return new Response("Forbidden", { status: 403 });
      return handleDiag(path, publicUrl, env);
    }

    const cacheable = request.method === "GET" && HEALTH_PATHS.has(path);
    if (cacheable) {
      const hit = healthCache.get(path);
      if (hit && Date.now() - hit.at < HEALTH_TTL_MS) {
        return new Response(hit.body, { status: hit.status, headers: { "Content-Type": "text/plain" } });
      }
    }

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", publicUrl.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", publicUrl.host);

    const forwardRequest = new Request(request, { headers });

    // Path-based routing matching Syncfusion multi-container default.conf. Longest prefix first.
    const under = (p: string) => path === p || path.startsWith(p + "/");
    let targetResponse: Response;

    if (under("/etlservice")) {
      // Vendor nginx: location /etlservice/ { proxy_pass http://bi-etl/; } strips the prefix.
      const target = new URL(request.url);
      target.pathname = path.slice("/etlservice".length) || "/";
      targetResponse = await env.BI_ETL_CONTAINER.getByName("bi-etl").fetch(new Request(target, forwardRequest));
    } else if (under("/aiservice")) {
      targetResponse = await env.BOLD_AI_CONTAINER.getByName("bold-ai").fetch(forwardRequest);
    } else if (under("/mcp")) {
      targetResponse = await env.BOLD_MCP_CONTAINER.getByName("bold-mcp").fetch(forwardRequest);
    } else if (under("/bi/api")) {
      targetResponse = await env.BI_API_CONTAINER.getByName("bi-api").fetch(forwardRequest);
    } else if (under("/bi/jobs")) {
      targetResponse = await env.BI_JOBS_CONTAINER.getByName("bi-jobs").fetch(forwardRequest);
    } else if (under("/bi/designer")) {
      targetResponse = await env.BI_DESIGNER_CONTAINER.getByName("bi-designer").fetch(forwardRequest);
    } else if (under("/bi")) {
      targetResponse = await env.BI_WEB_CONTAINER.getByName("bi-web").fetch(forwardRequest);
    } else if (under("/api")) {
      targetResponse = await env.ID_API_CONTAINER.getByName("id-api").fetch(forwardRequest);
    } else if (under("/ums")) {
      targetResponse = await env.ID_UMS_CONTAINER.getByName("id-ums").fetch(forwardRequest);
    } else {
      targetResponse = await env.ID_WEB_CONTAINER.getByName("id-web").fetch(forwardRequest);
    }

    if (cacheable && targetResponse.status === 200) {
      healthCache.set(path, { at: Date.now(), status: 200, body: await targetResponse.clone().text() });
    }

    return withTiming(secureApplicationResponse(targetResponse, publicUrl), `worker-total;dur=${Date.now() - startedAt}`);
  },
};
