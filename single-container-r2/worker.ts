import { Container } from "@cloudflare/containers";

// Mandatory Bold BI base settings (see README.md). Passed to the container unchanged.
export const BASE_REQUIRED_KEYS = [
  "BOLD_SERVICES_UNLOCK_KEY",
  "BOLD_SERVICES_DB_TYPE",
  "BOLD_SERVICES_DB_HOST",
  "BOLD_SERVICES_DB_USER",
  "BOLD_SERVICES_DB_PASSWORD",
  "BOLD_SERVICES_USER_EMAIL",
  "BOLD_SERVICES_USER_PASSWORD",
] as const;

// Optional Cloudflare R2 storage settings (storage type 5).
// When BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME is set, all R2 keys become required and BOLD_SERVICES_STORAGETYPE=5 is passed.
// When unset, Bold BI runs with default local filesystem storage inside the container.
export const R2_KEYS = [
  "BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME",
  "BOLD_SERVICES_CLOUDFLARE_R2_ACCESS_KEY_ID",
  "BOLD_SERVICES_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "BOLD_SERVICES_CLOUDFLARE_R2_ENDPOINT_URL",
  "BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME",
] as const;

export const REQUIRED_KEYS = BASE_REQUIRED_KEYS;

type AllKeys = (typeof BASE_REQUIRED_KEYS)[number] | (typeof R2_KEYS)[number];

type Env = {
  BOLDBI_CONTAINER: DurableObjectNamespace<BoldBIContainer>;
  OPTIONAL_LIBS?: string;
  ADMIN_TOKEN?: string;
  DISABLE_R2?: string; // set to "true" to force local storage even if R2 secrets exist on Worker
} & Partial<Record<AllKeys, string>>;

export function isR2Configured(env: Partial<Record<string, string>>): boolean {
  if (env.DISABLE_R2 === "true" || env.DISABLE_R2 === "1") return false;
  return Boolean(env.BOLD_SERVICES_CLOUDFLARE_R2_BUCKET_NAME);
}

export function missingKeys(env: Partial<Record<string, string>>): string[] {
  const missing: string[] = BASE_REQUIRED_KEYS.filter(k => !env[k]);
  if (isR2Configured(env)) {
    for (const k of R2_KEYS) {
      if (!env[k]) missing.push(k);
    }
  }
  return missing;
}

export function buildContainerEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    BOLD_SERVICES_REVERSE_PROXY: "true",
    BOLD_SERVICES_CONSOLE_LOG_ENABLED: "true",
  };

  for (const k of BASE_REQUIRED_KEYS) {
    if (env[k]) vars[k] = env[k] as string;
  }

  if (isR2Configured(env as Partial<Record<string, string>>)) {
    vars.BOLD_SERVICES_STORAGETYPE = "5";
    for (const k of R2_KEYS) {
      if (env[k]) vars[k] = env[k] as string;
    }
  }

  if (env.OPTIONAL_LIBS) vars.OPTIONAL_LIBS = env.OPTIONAL_LIBS;
  return vars;
}

export class BoldBIContainer extends Container<Env> {
  defaultPort = 80;
  // The default http://ping/ enters Bold BI's hostname-dependent redirects.
  pingEndpoint = "localhost/health-check";
  sleepAfter = "6h";
  enableInternet = true;

  // DIAGNOSTIC (admin only): read-only shell script inside the running container. Never starts it.
  async diagRun(script: string): Promise<{ ok: boolean; out: string; err?: string }> {
    if (!this.ctx.container?.running) return { ok: false, out: "", err: "container is not running (not started yet)" };
    try {
      const proc = await this.ctx.container.exec(["bash", "-c", script]);
      const r = await proc.output();
      return { ok: true, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr).slice(0, 300) || undefined };
    } catch (e) {
      return { ok: false, out: "", err: String(e) };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      ports: [80],
      startOptions: { envVars: buildContainerEnv(this.env) },
      cancellationOptions: { instanceGetTimeoutMS: 120000, portReadyTimeoutMS: 300000 },
    });
    return super.fetch(request);
  }
}

const SAFE_LOG_FILE = /^\/(application|var\/log|tmp)\/[A-Za-z0-9._\/-]{1,200}\.(log|txt)$/;
const MAX_ARCHIVE_B64 = 20_000_000;
const SAFE_FILTER = /^[A-Za-z0-9 ._:=-]{1,80}$/;

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

async function sameToken(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const h = async (v: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([h(given), h(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// GET /_internal/diag/logs                          newest log files inside the container
// GET /_internal/diag/logs?file=/application/...log&lines=300&grep=ERROR   tail one file (optional literal filter)
// Header X-Admin-Token must equal the ADMIN_TOKEN secret. Read-only; does not start the container.
export async function handleDiag(request: Request, env: Env, stub: { diagRun(s: string): Promise<{ ok: boolean; out: string; err?: string }> }): Promise<Response> {
  if (!(await sameToken(request.headers.get("X-Admin-Token"), env.ADMIN_TOKEN))) return new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  if (url.pathname === "/_internal/diag/env") {
    // List BOLD_SERVICES_* env vars by inspecting the running application process's /proc/<pid>/environ.
    // Container exec runs in a clean shell environment without container startup envVars.
    if (request.method !== "GET") return Response.json({ error: "use GET" }, { status: 405 });
    const script = "for envfile in /proc/[0-9]*/environ; do if tr '\\0' '\\n' < \"$envfile\" 2>/dev/null | grep -q '^BOLD_SERVICES_'; then tr '\\0' '\\n' < \"$envfile\" | grep '^BOLD_SERVICES_'; break; fi; done";
    const r = await stub.diagRun(script);
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    const raw = r.out;
    const mask = (v: string): { value: string; length: number } => {
      const n = v.length;
      if (n === 0) return { value: "(empty)", length: 0 };
      if (n <= 8) return { value: "[redacted]", length: n };
      return { value: `${v.slice(0, 2)}***${v.slice(-2)}`, length: n };
    };
    const lines = raw.split("\n").filter(Boolean).map(line => {
      const i = line.indexOf("=");
      if (i < 0) return { name: line };
      const name = line.slice(0, i);
      const m = mask(line.slice(i + 1));
      return { name, ...m };
    });
    return Response.json({ bold_services: lines });
  }
  if (url.pathname === "/_internal/diag/logs/clear") {
    // Empties (does not delete) every file under app_data/logs, so running services keep writing to them.
    if (request.method !== "POST") return Response.json({ error: "use POST" }, { status: 405 });
    console.log(JSON.stringify({ diag: "clear-logs" }));
    const r = await stub.diagRun("find /application/app_data/logs -type f -exec truncate -s 0 {} + ; echo cleared $(find /application/app_data/logs -type f | wc -l) files");
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    return Response.json({ result: r.out });
  }
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  if (url.pathname === "/_internal/diag/logs.tgz") {
    // The whole /application/app_data/logs folder as one gzip tar (sent through exec as base64, then decoded here).
    const r = await stub.diagRun("tar -czf - -C /application/app_data logs 2>/dev/null | base64 -w0");
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    if (r.out.length > MAX_ARCHIVE_B64) return Response.json({ error: "logs archive is too large; read single files with ?file=" }, { status: 413 });
    const bytes = Uint8Array.from(atob(r.out), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "application/gzip", "Content-Disposition": 'attachment; filename="boldbi-logs.tgz"', "Cache-Control": "no-store" } });
  }
  if (url.pathname !== "/_internal/diag/logs") return new Response("Not found", { status: 404 });
  const file = url.searchParams.get("file");
  if (!file) {
    const r = await stub.diagRun("find /application /var/log /tmp -type f \\( -name '*.log' -o -name '*.txt' \\) -printf '%T@ %s %p\\n' 2>/dev/null | sort -rn | head -50 | cut -d' ' -f2-");
    if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
    return Response.json({ files: r.out.split("\n").filter(Boolean).map(l => { const [size, ...f] = l.split(" "); return { size: Number(size), file: f.join(" ") }; }) });
  }
  if (!SAFE_LOG_FILE.test(file) || file.includes("..")) return Response.json({ error: "file must be a .log/.txt under /application, /var/log or /tmp" }, { status: 400 });
  const lines = clampInt(url.searchParams.get("lines"), 200, 1, 2000);
  const filter = url.searchParams.get("grep");
  if (filter !== null && !SAFE_FILTER.test(filter)) return Response.json({ error: "bad grep" }, { status: 400 });
  const script = filter ? `tail -n 20000 '${file}' | grep -F -- '${filter}' | tail -n ${lines}` : `tail -n ${lines} '${file}'`;
  const r = await stub.diagRun(script);
  if (!r.ok) return Response.json({ error: r.err }, { status: 502 });
  return new Response(r.out, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// TEMPORARY (step 1 of 2): keeps the retired namespace alive while the binding moves to BoldBIContainer.
// Step 2 removes this stub and marks the class deleted in wrangler.jsonc.
export class BoldBIEvalContainer {
  constructor(_ctx: unknown, _env: unknown) {}
  async fetch(): Promise<Response> { return new Response("retired", { status: 410 }); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/_internal/diag/")) {
      try {
        return await handleDiag(request, env, env.BOLDBI_CONTAINER.getByName("boldbi-r2", { locationHint: "enam" }));
      } catch (e) {
        console.log(JSON.stringify({ diag: "error", error: String(e) }));
        return Response.json({ error: String(e) }, { status: 502 });
      }
    }
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
