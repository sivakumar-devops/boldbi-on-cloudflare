import { Container } from "@cloudflare/containers";
interface EvalEnv {
  BOLDBI_EVAL_CONTAINER: DurableObjectNamespace<BoldBIEvalContainer>;
  EVAL_DB_PASSWORD: string;
  EVAL_DB_HOST: string;
  EVAL_DB_PORT?: string;
  EVAL_DB_USER?: string;
  EVAL_DB_TYPE?: string;
  EVAL_DB_MAINTENANCE_DB?: string;
  EVAL_ADMIN_PASSWORD: string;
  EVAL_ADMIN_EMAIL?: string;
  DO_LOCATION_HINT?: string; // enam (default, US East) | wnam | weur | ... | none
  DO_NAME_SUFFIX?: string; // change to create a new instance that honours the hint

  // Cloudflare R2 storage settings (vendor storage type 5)
  BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME?: string;
  BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID?: string;
  BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;
  BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL?: string;
  BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME?: string;
}

const R2_KEYS = [
  "BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME",
  "BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID",
  "BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL",
  "BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME",
] as const;

export function buildEvalContainerEnv(env: EvalEnv): Record<string, string> {
  const vars: Record<string, string> = {
    BOLD_SERVICES_DB_TYPE: env.EVAL_DB_TYPE || "postgresql",
    BOLD_SERVICES_DB_HOST: env.EVAL_DB_HOST,
    BOLD_SERVICES_DB_PORT: env.EVAL_DB_PORT || "5432",
    BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB: env.EVAL_DB_MAINTENANCE_DB || "postgres",
    BOLD_SERVICES_DB_USER: env.EVAL_DB_USER || "postgres",
    BOLD_SERVICES_DB_PASSWORD: env.EVAL_DB_PASSWORD,
    BOLD_SERVICES_USER_EMAIL: env.EVAL_ADMIN_EMAIL || "testuser@boldbi.com",
    BOLD_SERVICES_USER_PASSWORD: env.EVAL_ADMIN_PASSWORD,
    BOLD_SERVICES_REVERSE_PROXY: "true",
    BOLD_SERVICES_CONSOLE_LOG_ENABLED: "true",
  };

  if (env.BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME) {
    vars.BOLD_SERVICES_STORAGETYPE = "5";
    for (const k of R2_KEYS) {
      if (env[k]) vars[k] = env[k]!;
    }
  }

  return vars;
}

const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;
type LocationHint = (typeof LOCATION_HINTS)[number];

// A hint applies only when the Durable Object is first created; best effort (a region, not a city).
export function locationHintFor(env: Pick<EvalEnv, "DO_LOCATION_HINT">): LocationHint | undefined {
  const v = (env.DO_LOCATION_HINT ?? "enam").trim().toLowerCase();
  if (v === "none" || v === "") return undefined;
  return (LOCATION_HINTS as readonly string[]).includes(v) ? (v as LocationHint) : "enam";
}

export class BoldBIEvalContainer extends Container<EvalEnv> {
  defaultPort = 80;
  // The SDK default, http://ping/, enters BoldBI's hostname-dependent login
  // redirects. This endpoint returns HTTP 200 without entering that flow.
  pingEndpoint = "localhost/health-check";
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      // The SDK probes readiness with HTTP, not a raw TCP connection.
      // PostgreSQL's binary protocol on 5432 cannot answer that probe.
      ports: [80],
      startOptions: { envVars: buildEvalContainerEnv(this.env) },
      cancellationOptions: { instanceGetTimeoutMS: 120000, portReadyTimeoutMS: 300000 },
    });
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: EvalEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!env.EVAL_DB_HOST || !env.EVAL_DB_PASSWORD || !env.EVAL_ADMIN_PASSWORD) return new Response("Configure the eval secrets first.", { status: 503 });
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", url.host);
    const response = await env.BOLDBI_EVAL_CONTAINER.getByName(
      env.DO_NAME_SUFFIX?.trim() ? `boldbi-eval-${env.DO_NAME_SUFFIX.trim()}` : "boldbi-eval",
      locationHintFor(env) ? { locationHint: locationHintFor(env) } : undefined,
    ).fetch(new Request(request, { headers }));
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    secured.headers.set("Cache-Control", "private, no-store");
    if (url.protocol === "https:") {
      if (/\btext\/html\b/i.test(secured.headers.get("Content-Type") || "")) {
        secured.headers.append("Content-Security-Policy", "upgrade-insecure-requests");
      }
      const location = secured.headers.get("Location");
      if (location) {
        const target = new URL(location, url);
        if (target.host === url.host && target.protocol === "http:") {
          target.protocol = "https:";
          secured.headers.set("Location", target.href);
        }
      }
    }
    return secured;
  },
};
