import { Container } from "@cloudflare/containers";

export interface MultiEnv {
  ID_WEB_CONTAINER: DurableObjectNamespace<IdWebContainer>;
  ID_API_CONTAINER: DurableObjectNamespace<IdApiContainer>;
  ID_UMS_CONTAINER: DurableObjectNamespace<IdUmsContainer>;

  // Optional overrides (for when Azure Postgres / R2 are configured)
  ADMIN_TOKEN?: string; // secret; enables POST /_internal/reset
  SPIKE_FAKE_HEALTH?: string; // "true": answer health probes in the Worker (diagnostic only)
  SERVICE_COMMUNICATION?: string; // "public_url" (default)
  APP_BASE_URL?: string;
  BOLD_SERVICES_DB_HOST?: string;
  BOLD_SERVICES_DB_USER?: string;
  BOLD_SERVICES_DB_PASSWORD?: string;
}

function buildContainerEnv(requestUrl: string, env: MultiEnv): Record<string, string> {
  const url = new URL(requestUrl);
  const appBase = env.APP_BASE_URL || `${url.protocol}//${url.host}`;

  const vars: Record<string, string> = {
    APP_BASE_URL: appBase,
    BOLD_SERVICES_PV_USED: "false",
  };

  if (env.BOLD_SERVICES_DB_HOST) {
    vars.BOLD_SERVICES_DB_HOST = env.BOLD_SERVICES_DB_HOST;
    vars.BOLD_SERVICES_DB_TYPE = "postgresql";
    vars.BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB = "postgres";
    vars.BOLD_SERVICES_DB_USER = env.BOLD_SERVICES_DB_USER || "postgres";
    if (env.BOLD_SERVICES_DB_PASSWORD) {
      vars.BOLD_SERVICES_DB_PASSWORD = env.BOLD_SERVICES_DB_PASSWORD;
    }
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

// The stock port check follows redirects. The apps redirect to their https base URL, which the
// container runtime refuses to follow, so the check never succeeds. Any HTTP answer means "up".
class BoldContainer extends Container<MultiEnv> {
  override async waitForPort(waitOptions: Parameters<Container["waitForPort"]>[0]): Promise<number> {
    const tcpPort = this.ctx.container!.getTcpPort(waitOptions.portToCheck);
    const interval = waitOptions.waitInterval ?? 300;
    const tries = waitOptions.retries ?? Math.ceil(30_000 / interval);
    for (let i = 0; i < tries; i++) {
      try {
        await tcpPort.fetch(`http://${this.pingEndpoint}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        return i;
      } catch (e) {
        if (!this.ctx.container?.running || i === tries - 1) throw e;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
    return tries;
  }
}

export class IdWebContainer extends BoldContainer {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running) {
      await this.startAndWaitForPorts({
        ports: 80,
        startOptions: { envVars: buildContainerEnv(request.url, this.env) },
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
    }
    return super.fetch(request);
  }
}

export class IdApiContainer extends BoldContainer {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running) {
      await this.startAndWaitForPorts({
        ports: 80,
        startOptions: { envVars: buildContainerEnv(request.url, this.env) },
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
    }
    return super.fetch(request);
  }
}

export class IdUmsContainer extends BoldContainer {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running) {
      await this.startAndWaitForPorts({
        ports: 80,
        startOptions: { envVars: buildContainerEnv(request.url, this.env) },
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
    }
    return super.fetch(request);
  }
}

// Services not deployed yet: answer immediately so the apps' retry loops don't load the containers.
const UNAVAILABLE_PREFIXES = ["/bi", "/reporting", "/aiservice", "/mcp", "/etlservice", "/reportsai", "/reportsmcp"];
const HEALTH_PATHS = new Set([
  "/health-check", "/api/health-check", "/ums/health-check",
  "/bi/health-check", "/bi/api/health-check", "/bi/jobs/health-check", "/bi/designer/health-check",
  "/aiservice/health-check", "/etlservice/health-check",
]);
const HEALTH_TTL_MS = 5000;
const healthCache = new Map<string, { at: number; status: number; body: string }>();

export default {
  async fetch(request: Request, env: MultiEnv): Promise<Response> {
    const publicUrl = new URL(request.url);
    const path = publicUrl.pathname;

    // Internal diagnostics
    if (path === "/_internal/health") {
      return Response.json({
        ok: true,
        mode: "multi-container-spike",
        services: ["id-web", "id-api", "id-ums"],
      });
    }

    if (UNAVAILABLE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
      return new Response("Service not deployed", { status: 503, headers: { "Retry-After": "60" } });
    }

    if (env.SPIKE_FAKE_HEALTH === "true" && request.method === "GET" && HEALTH_PATHS.has(path)) {
      return new Response("OK (faked by Worker)", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    const cacheable = request.method === "GET" && HEALTH_PATHS.has(path);
    if (cacheable) {
      const hit = healthCache.get(path);
      if (hit && Date.now() - hit.at < HEALTH_TTL_MS) {
        return new Response(hit.body, { status: hit.status, headers: { "Content-Type": "text/plain" } });
      }
    }

    if (path === "/_internal/reset" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) {
        return new Response("Not found", { status: 404 });
      }
      await Promise.all([
        env.ID_WEB_CONTAINER.getByName("id-web").destroy(),
        env.ID_API_CONTAINER.getByName("id-api").destroy(),
        env.ID_UMS_CONTAINER.getByName("id-ums").destroy(),
      ]);
      return Response.json({ ok: true, destroyed: ["id-web", "id-api", "id-ums"] });
    }

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", publicUrl.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", publicUrl.host);

    const forwardRequest = new Request(request, { headers });

    // Path-based routing matching Syncfusion multi-container default.conf:
    // /api, /api/* -> id-api
    // /ums, /ums/* -> id-ums
    // default (/, /login, /health-check, etc.) -> id-web
    let targetResponse: Response;

    if (path === "/api" || path.startsWith("/api/")) {
      targetResponse = await env.ID_API_CONTAINER.getByName("id-api").fetch(forwardRequest);
    } else if (path === "/ums" || path.startsWith("/ums/")) {
      targetResponse = await env.ID_UMS_CONTAINER.getByName("id-ums").fetch(forwardRequest);
    } else {
      targetResponse = await env.ID_WEB_CONTAINER.getByName("id-web").fetch(forwardRequest);
    }

    if (cacheable && targetResponse.status === 200) {
      healthCache.set(path, { at: Date.now(), status: 200, body: await targetResponse.clone().text() });
    }

    return secureApplicationResponse(targetResponse, publicUrl);
  },
};
