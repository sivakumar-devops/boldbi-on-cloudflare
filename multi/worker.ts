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
  ADMIN_TOKEN?: string; // enables POST /_internal/restart

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

export async function forwardInternal(request: Request, env: MultiEnv): Promise<Response> {
  const url = new URL(request.url);
  const target = internalTarget(env, url.hostname);
  if (!target) return new Response(`Unknown internal service ${url.hostname}`, { status: 502 });
  // Same forwarding headers the public path sets, so the app resolves the tenant by the public host.
  const base = new URL(env.APP_BASE_URL || lastPublicBase || "https://localhost");
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Proto", base.protocol.slice(0, -1));
  headers.set("X-Forwarded-Host", base.host);
  return target.fetch(new Request(request, { headers }));
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
