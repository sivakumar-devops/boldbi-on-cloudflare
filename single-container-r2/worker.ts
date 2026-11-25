import { Container } from "@cloudflare/containers";

// Mandatory Bold BI settings (see README.md). Passed to the container unchanged.
export const REQUIRED_KEYS = [
  "BOLD_SERVICES_UNLOCK_KEY",
  "BOLD_SERVICES_DB_TYPE",
  "BOLD_SERVICES_DB_HOST",
  "BOLD_SERVICES_DB_USER",
  "BOLD_SERVICES_DB_PASSWORD",
  "BOLD_SERVICES_USER_EMAIL",
  "BOLD_SERVICES_USER_PASSWORD",
  // Cloudflare R2 storage (storage type 5)
  "BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME",
  "BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID",
  "BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL",
  "BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME",
] as const;

type Env = { BOLDBI_CONTAINER: DurableObjectNamespace<BoldBIEvalContainer>; OPTIONAL_LIBS?: string } &
  Partial<Record<(typeof REQUIRED_KEYS)[number], string>>;

export function missingKeys(env: Partial<Record<string, string>>): string[] {
  return REQUIRED_KEYS.filter(k => !env[k]);
}

export function buildContainerEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    BOLD_SERVICES_STORAGETYPE: "5",
    BOLD_SERVICES_REVERSE_PROXY: "true",
    BOLD_SERVICES_CONSOLE_LOG_ENABLED: "true",
  };
  for (const k of REQUIRED_KEYS) vars[k] = env[k] as string;
  if (env.OPTIONAL_LIBS) vars.OPTIONAL_LIBS = env.OPTIONAL_LIBS;
  return vars;
}

export class BoldBIEvalContainer extends Container<Env> {
  defaultPort = 80;
  // The default http://ping/ enters Bold BI's hostname-dependent redirects.
  pingEndpoint = "localhost/health-check";
  sleepAfter = "6h";
  enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      ports: [80],
      startOptions: { envVars: buildContainerEnv(this.env) },
      cancellationOptions: { instanceGetTimeoutMS: 120000, portReadyTimeoutMS: 300000 },
    });
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const missing = missingKeys(env as Partial<Record<string, string>>);
    if (missing.length) return new Response(`Missing configuration: ${missing.join(", ")}`, { status: 503 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", url.host);
    // A new Durable Object name is created in the hinted region (US East), near the database.
    const stub = env.BOLDBI_CONTAINER.getByName("boldbi-r2", { locationHint: "enam" });
    const response = await stub.fetch(new Request(request, { headers }));
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
