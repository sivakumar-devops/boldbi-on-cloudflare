import { describe, it, expect, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {
  env: Record<string, string>;
  constructor(_ctx: unknown, env: Record<string, string>) { this.env = env; }
  startAndWaitForPorts = vi.fn(async () => {});
  async fetch(_request: Request) { return new Response("container-origin"); }
} }));
import worker, { REQUIRED_KEYS, buildContainerEnv, handleDiag, missingKeys } from "./worker";

const full = Object.fromEntries(REQUIRED_KEYS.map(k => [k, `v-${k}`]));

describe("single-container-r2 Worker", () => {
  it("reports every missing setting with a 503", async () => {
    const getByName = vi.fn();
    const res = await worker.fetch(new Request("https://app.example/"), { BOLDBI_CONTAINER: { getByName }, BOLD_SERVICES_DB_HOST: "h" } as never);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("BOLD_SERVICES_UNLOCK_KEY");
    expect(getByName).not.toHaveBeenCalled();
  });
  it("passes the settings through and forces R2 storage", () => {
    const vars = buildContainerEnv({ ...full, OPTIONAL_LIBS: "mysql" } as never);
    expect(vars.BOLD_SERVICES_STORAGETYPE).toBe("5");
    expect(vars.BOLD_SERVICES_DB_HOST).toBe("v-BOLD_SERVICES_DB_HOST");
    expect(vars.BOLD_SERVICES_CLOUDFLARE_R2_ROOT_FOLDER_NAME).toBeDefined();
    expect(vars.OPTIONAL_LIBS).toBe("mysql");
    expect(missingKeys(full)).toEqual([]);
  });
  it("routes to the US East object and keeps HTTPS", async () => {
    const containerFetch = vi.fn(async (_r: Request) => new Response("ok", { headers: { "Content-Type": "text/html" } }));
    const getByName = vi.fn(() => ({ fetch: containerFetch }));
    const res = await worker.fetch(new Request("https://app.example/x"), { ...full, BOLDBI_CONTAINER: { getByName } } as never);
    expect(getByName).toHaveBeenCalledWith("boldbi-r2", { locationHint: "enam" });
    expect(containerFetch.mock.calls[0][0].headers.get("X-Forwarded-Proto")).toBe("https");
    expect(res.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
  });
  it("diagnostics reject a missing or wrong token and never reach the container", async () => {
    const diagRun = vi.fn();
    const getByName = vi.fn(() => ({ diagRun }));
    const env = { BOLDBI_CONTAINER: { getByName }, ADMIN_TOKEN: "secret" } as never;
    for (const headers of [{}, { "X-Admin-Token": "wrong" }]) {
      const res = await worker.fetch(new Request("https://app.example/_internal/diag/logs", { headers }), env);
      expect(res.status).toBe(403);
    }
    expect(diagRun).not.toHaveBeenCalled();
  });
  it("diagnostics refuse unset ADMIN_TOKEN and unsafe file names, and tail a safe one", async () => {
    const diagRun = vi.fn(async () => ({ ok: true, out: "line1" }));
    const req = (q: string, token = "secret") => new Request(`https://app.example/_internal/diag/logs${q}`, { headers: { "X-Admin-Token": token } });
    expect((await handleDiag(req("", ""), {} as never, { diagRun })).status).toBe(403);
    const env = { ADMIN_TOKEN: "secret" } as never;
    expect((await handleDiag(req("?file=/etc/passwd"), env, { diagRun })).status).toBe(400);
    expect((await handleDiag(req("?file=/application/../etc/x.log"), env, { diagRun })).status).toBe(400);
    expect((await handleDiag(req("?file=/application/a.log&grep=a'b"), env, { diagRun })).status).toBe(400);
    const ok = await handleDiag(req("?file=/application/app_data/logs/a.log&grep=ERROR"), env, { diagRun });
    expect(await ok.text()).toBe("line1");
  });
  it("returns the logs folder as a gzip download, token required", async () => {
    const b64 = btoa("hello");
    const stub = { diagRun: vi.fn(async () => ({ ok: true, out: b64 })) };
    const url = "https://app.example/_internal/diag/logs.tgz";
    expect((await handleDiag(new Request(url), { ADMIN_TOKEN: "t" } as never, stub)).status).toBe(403);
    const res = await handleDiag(new Request(url, { headers: { "X-Admin-Token": "t" } }), { ADMIN_TOKEN: "t" } as never, stub);
    expect(res.headers.get("Content-Disposition")).toContain("boldbi-logs.tgz");
    expect(await res.text()).toBe("hello");
    expect(stub.diagRun).toHaveBeenCalledWith(expect.stringContaining("tar -czf"));
  });
  it("clears logs only with POST and the token", async () => {
    const stub = { diagRun: vi.fn(async () => ({ ok: true, out: "cleared 3 files" })) };
    const url = "https://app.example/_internal/diag/logs/clear";
    const env = { ADMIN_TOKEN: "t" } as never;
    expect((await handleDiag(new Request(url, { method: "POST" }), env, stub)).status).toBe(403);
    expect((await handleDiag(new Request(url, { headers: { "X-Admin-Token": "t" } }), env, stub)).status).toBe(405);
    expect(stub.diagRun).not.toHaveBeenCalled();
    const ok = await handleDiag(new Request(url, { method: "POST", headers: { "X-Admin-Token": "t" } }), env, stub);
    expect(ok.status).toBe(200);
    expect(stub.diagRun.mock.calls[0][0]).toContain("truncate -s 0");
  });
});
