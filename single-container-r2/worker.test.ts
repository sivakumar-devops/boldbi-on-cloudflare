import { describe, it, expect, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {
  env: Record<string, string>;
  constructor(_ctx: unknown, env: Record<string, string>) { this.env = env; }
  startAndWaitForPorts = vi.fn(async () => {});
  async fetch(_request: Request) { return new Response("container-origin"); }
} }));
import worker, { REQUIRED_KEYS, buildContainerEnv, missingKeys } from "./worker";

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
});
