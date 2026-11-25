import { describe, it, expect, vi } from "vitest";
const readiness = vi.hoisted(() => vi.fn(async function(this: { pingEndpoint?: string }, options: { ports: number[] }) {
  if (options.ports.some(port => port !== 80)) throw new Error("HTTP readiness cannot probe the PostgreSQL binary protocol.");
  if (this.pingEndpoint !== "localhost/health-check") throw new Error("The default ping hostname enters BoldBI's login redirects.");
}));
vi.mock("@cloudflare/containers", () => ({ Container: class {
  env: Record<string, string>;
  constructor(_ctx: unknown, env: Record<string, string>) { this.env = env; }
  startAndWaitForPorts = readiness;
  async fetch(_request: Request) { return new Response("container-origin"); }
} }));
import worker, { BoldBIEvalContainer } from "./worker";

function setup() {
  const evalFetch = vi.fn(async (_request: Request) => new Response("eval", { headers: { "Content-Type": "text/html" } }));
  const getByName = vi.fn(() => ({ fetch: evalFetch }));
  const env = { BOLDBI_EVAL_CONTAINER: { getByName }, EVAL_DB_PASSWORD: "test-db", EVAL_ADMIN_PASSWORD: "test-admin" };
  const fetch = (path: string, cookie = "", method = "GET") => worker.fetch(new Request(`https://app.example${path}`, { method, headers: { Cookie: cookie } }), env as never);
  return { fetch, evalFetch, getByName, env };
}
describe("eval Worker", () => {
  it("checks HTTP readiness without sending HTTP probes to PostgreSQL", async () => {
    readiness.mockClear();
    const container = new BoldBIEvalContainer({} as never, {
      EVAL_DB_PASSWORD: "test-db", EVAL_ADMIN_PASSWORD: "test-admin",
    } as never);
    const response = await container.fetch(new Request("https://app.example/"));
    expect(await response.text()).toBe("container-origin");
    expect(readiness).toHaveBeenCalledOnce();
    expect(readiness.mock.calls[0][0].ports).toEqual([80]);
    expect(container.pingEndpoint).toBe("localhost/health-check");
  });
  it("routes absolute application paths to eval and preserves HTTPS", async () => {
    const { fetch, evalFetch, getByName } = setup();
    const response = await fetch("/ums/theme/styles/application?theme=light", "other=ok");
    expect(getByName).toHaveBeenCalledWith("boldbi-eval");
    const request = evalFetch.mock.calls[0][0];
    expect(request.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(request.headers.get("Cookie")).toBe("other=ok");
    expect(response.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("requires configured eval secrets", async () => {
    const { fetch, env, evalFetch } = setup();
    env.EVAL_DB_PASSWORD = "";
    expect((await fetch("/")).status).toBe(503);
    expect(evalFetch).not.toHaveBeenCalled();
  });
});
