import { Container } from "@cloudflare/containers";

export interface MultiEnv {
  ID_WEB_CONTAINER: DurableObjectNamespace<IdWebContainer>;
  ID_API_CONTAINER: DurableObjectNamespace<IdApiContainer>;
  ID_UMS_CONTAINER: DurableObjectNamespace<IdUmsContainer>;

  // Optional overrides (for when Azure Postgres / R2 are configured)
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
    BOLD_SERVICES_HOSTING_ENVIRONMENT: "docker",
    BOLD_SERVICES_PV_USED: "false",
    DEPLOY_MODE: "docker_multi_container",
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

export class IdWebContainer extends Container<MultiEnv> {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    await this.start({ envVars: buildContainerEnv(request.url, this.env) });
    return super.fetch(request);
  }
}

export class IdApiContainer extends Container<MultiEnv> {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    await this.start({ envVars: buildContainerEnv(request.url, this.env) });
    return super.fetch(request);
  }
}

export class IdUmsContainer extends Container<MultiEnv> {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    await this.start({ envVars: buildContainerEnv(request.url, this.env) });
    return super.fetch(request);
  }
}

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

    return secureApplicationResponse(targetResponse, publicUrl);
  },
};
