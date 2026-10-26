import { Container } from "@cloudflare/containers";

export interface MultiEnv {
  ID_WEB_CONTAINER: DurableObjectNamespace<IdWebContainer>;
  ID_API_CONTAINER: DurableObjectNamespace<IdApiContainer>;
  ID_UMS_CONTAINER: DurableObjectNamespace<IdUmsContainer>;
  BI_WEB_CONTAINER: DurableObjectNamespace<BiWebContainer>;
  BI_API_CONTAINER: DurableObjectNamespace<BiApiContainer>;
  BI_JOBS_CONTAINER: DurableObjectNamespace<BiJobsContainer>;
  BI_DESIGNER_CONTAINER: DurableObjectNamespace<BiDesignerContainer>;

  // Optional overrides / secrets
  SERVICE_COMMUNICATION?: string; // "public_url" (default)
  APP_BASE_URL?: string;
  BOLD_SERVICES_DB_HOST?: string;
  BOLD_SERVICES_DB_PORT?: string;
  BOLD_SERVICES_DB_NAME?: string;
  BOLD_SERVICES_DB_USER?: string;
  BOLD_SERVICES_DB_PASSWORD?: string;

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

const DB_KEYS = ["BOLD_SERVICES_DB_HOST", "BOLD_SERVICES_DB_PORT", "BOLD_SERVICES_DB_NAME", "BOLD_SERVICES_DB_PASSWORD"] as const;

// Mirrors the vendor's S3 multi-container manifests: every service gets the S3 settings,
// and only UMS (which sets up the database) gets the database settings.
export function buildContainerEnv(requestUrl: string, env: MultiEnv, withDatabase: boolean): Record<string, string> {
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

  // The vendor compose resolves services by Docker hostname (http://id-api/api). Containers here
  // share no network, so point every service at the public URL, which the Worker routes.
  const base = vars.APP_BASE_URL.replace(/\/+$/, "");
  Object.assign(vars, {
    ID_WEB_SERVICE_URL: base,
    ID_API_SERVICE_URL: `${base}/api`,
    ID_UMS_SERVICE_URL: `${base}/ums`,
    BI_WEB_SERVICE_URL: `${base}/bi`,
    BI_API_SERVICE_URL: `${base}/bi/api`,
    BI_JOBS_SERVICE_URL: `${base}/bi/jobs`,
    BI_DESIGNER_SERVICE_URL: `${base}/bi/designer`,
    BI_DESIGNER_HELPER_SERVICE_URL: `${base}/bi/designer/helper`,
  });

  if (env.BOLD_SERVICES_AMAZON_BUCKET_NAME) {
    vars.BOLD_SERVICES_STORAGETYPE = "3";
    for (const k of S3_KEYS) if (env[k]) vars[k] = env[k]!;
  }

  if (withDatabase && env.BOLD_SERVICES_DB_HOST) {
    vars.BOLD_SERVICES_DB_TYPE = "postgresql";
    vars.BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB = "postgres";
    vars.BOLD_SERVICES_DB_USER = env.BOLD_SERVICES_DB_USER || "postgres";
    for (const k of DB_KEYS) if (env[k]) vars[k] = env[k]!;
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

abstract class BoldServiceContainer extends BoldContainer {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;
  protected withDatabase = false;

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running) {
      await this.startAndWaitForPorts({
        ports: 80,
        startOptions: { envVars: buildContainerEnv(request.url, this.env, this.withDatabase) },
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
    }
    return super.fetch(request);
  }
}

export class IdWebContainer extends BoldServiceContainer {}
export class IdApiContainer extends BoldServiceContainer {}
export class IdUmsContainer extends BoldServiceContainer {
  protected override withDatabase = true;
}
export class BiWebContainer extends BoldServiceContainer {}
export class BiApiContainer extends BoldServiceContainer {}
export class BiJobsContainer extends BoldServiceContainer {}
export class BiDesignerContainer extends BoldServiceContainer {}

// Services not deployed yet: answer immediately so the apps' retry loops don't load the containers.
const UNAVAILABLE_PREFIXES = ["/aiservice", "/mcp", "/etlservice"];
const HEALTH_PATHS = new Set(["/health-check", "/api/health-check", "/ums/health-check"]);
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
        services: ["id-web", "id-api", "id-ums", "bi-web", "bi-api", "bi-jobs", "bi-designer"],
      });
    }

    // TEMPORARY: shape of the S3 settings (never the values), to debug S3 403s. Remove once fixed.
    if (path === "/_internal/s3-config") {
      const shape = (v?: string) => (v === undefined ? "MISSING" : { length: v.length, trimmedLength: v.trim().length, hasQuoteOrNewline: /["'\r\n]/.test(v) });
      return Response.json({
        bucket: env.BOLD_SERVICES_AMAZON_BUCKET_NAME, // not secret
        region: env.BOLD_SERVICES_AWS_REGION,
        rootFolder: env.BOLD_SERVICES_AMAZON_ROOTFOLDER_NAME,
        accessKeyId: { ...(shape(env.BOLD_SERVICES_AWS_ACCESS_KEY_ID) as object), first4: env.BOLD_SERVICES_AWS_ACCESS_KEY_ID?.slice(0, 4), last4: env.BOLD_SERVICES_AWS_ACCESS_KEY_ID?.slice(-4) },
        secretAccessKey: shape(env.BOLD_SERVICES_AWS_SECRET_ACCESS_KEY),
      });
    }

    if (UNAVAILABLE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
      return new Response("Service not deployed", { status: 503, headers: { "Retry-After": "60" } });
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

    if (under("/bi/api")) {
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

    return secureApplicationResponse(targetResponse, publicUrl);
  },
};
