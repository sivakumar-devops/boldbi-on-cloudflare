import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class { env: unknown; constructor(_c: unknown, env: unknown) { this.env = env; } } }));

vi.mock("@cloudflare/containers", () => ({
  ContainerProxy: class {},
  Container: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { IdUmsContainer, MultiEnv, buildContainerEnv, buildServiceEntrypoint, internalKeysFor, buildServiceUrls, forwardInternal, OUTBOUND_HOSTS, BiApiContainer, percentile, internalStatsReport, locationHintFor, serviceStub, staticCacheEligible, staticCacheTtl, applyStaticCachePolicy } from "./worker";

function setup() {
  const idWebFetch = vi.fn(async () => new Response("id-web-response"));
  const idApiFetch = vi.fn(async () => new Response("id-api-response"));
  const idUmsFetch = vi.fn(async () => new Response("id-ums-response"));

  const biWebFetch = vi.fn(async () => new Response("bi-web-response"));
  const biApiFetch = vi.fn(async () => new Response("bi-api-response"));
  const biJobsFetch = vi.fn(async () => new Response("bi-jobs-response"));
  const biDesignerFetch = vi.fn(async () => new Response("bi-designer-response"));
  const etlFetch = vi.fn(async (_r: Request) => new Response("etl-response"));
  const aiFetch = vi.fn(async () => new Response("ai-response"));
  const mcpFetch = vi.fn(async () => new Response("mcp-response"));

  const env: MultiEnv = {
    BI_WEB_CONTAINER: { getByName: vi.fn(() => ({ fetch: biWebFetch })) } as never,
    BI_API_CONTAINER: { getByName: vi.fn(() => ({ fetch: biApiFetch })) } as never,
    BI_JOBS_CONTAINER: { getByName: vi.fn(() => ({ fetch: biJobsFetch })) } as never,
    BI_DESIGNER_CONTAINER: { getByName: vi.fn(() => ({ fetch: biDesignerFetch })) } as never,
    BI_ETL_CONTAINER: { getByName: vi.fn(() => ({ fetch: etlFetch })) } as never,
    BOLD_AI_CONTAINER: { getByName: vi.fn(() => ({ fetch: aiFetch })) } as never,
    BOLD_MCP_CONTAINER: { getByName: vi.fn(() => ({ fetch: mcpFetch })) } as never,
    ID_WEB_CONTAINER: { getByName: vi.fn(() => ({ fetch: idWebFetch })) } as never,
    ID_API_CONTAINER: { getByName: vi.fn(() => ({ fetch: idApiFetch })) } as never,
    ID_UMS_CONTAINER: { getByName: vi.fn(() => ({ fetch: idUmsFetch })) } as never,
  };

  const fetch = (path: string, init?: RequestInit) =>
    worker.fetch(new Request("https://app.example" + path, init), env);

  return { env, fetch, idWebFetch, idApiFetch, idUmsFetch, biWebFetch, biApiFetch, biJobsFetch, biDesignerFetch, etlFetch, aiFetch, mcpFetch };
}

describe("multi routing tests", () => {
  it("routes /_internal/health without hitting containers", async () => {
    const { fetch, env } = setup();
    const res = await fetch("/_internal/health");
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; services: string[] };
    expect(json.ok).toBe(true);
    expect(json.services).toEqual(["id-web", "id-api", "id-ums", "bi-web", "bi-api", "bi-jobs", "bi-designer", "bi-etl", "bold-ai", "bold-mcp"]);
    expect(env.ID_WEB_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  it("routes root path and /login to id-web", async () => {
    const { fetch, idWebFetch, idApiFetch, idUmsFetch } = setup();
    const res1 = await fetch("/");
    expect(await res1.text()).toBe("id-web-response");
    expect(idWebFetch).toHaveBeenCalledTimes(1);

    const res2 = await fetch("/login");
    expect(await res2.text()).toBe("id-web-response");
    expect(idWebFetch).toHaveBeenCalledTimes(2);

    expect(idApiFetch).not.toHaveBeenCalled();
    expect(idUmsFetch).not.toHaveBeenCalled();
  });

  it("routes /api and /api/* to id-api", async () => {
    const { fetch, idWebFetch, idApiFetch, idUmsFetch } = setup();
    const res1 = await fetch("/api");
    expect(await res1.text()).toBe("id-api-response");

    const res2 = await fetch("/api/v1/users");
    expect(await res2.text()).toBe("id-api-response");

    expect(idApiFetch).toHaveBeenCalledTimes(2);
    expect(idWebFetch).not.toHaveBeenCalled();
    expect(idUmsFetch).not.toHaveBeenCalled();
  });

  it("routes /ums and /ums/* to id-ums", async () => {
    const { fetch, idWebFetch, idApiFetch, idUmsFetch } = setup();
    const res1 = await fetch("/ums");
    expect(await res1.text()).toBe("id-ums-response");

    const res2 = await fetch("/ums/startup");
    expect(await res2.text()).toBe("id-ums-response");

    expect(idUmsFetch).toHaveBeenCalledTimes(2);
    expect(idWebFetch).not.toHaveBeenCalled();
    expect(idApiFetch).not.toHaveBeenCalled();
  });

  it("injects X-Forwarded-Proto and X-Forwarded-Host", async () => {
    const { fetch, idWebFetch } = setup();
    await fetch("/");
    expect(idWebFetch).toHaveBeenCalled();
    const sentReq = (idWebFetch.mock.calls[0] as unknown[])[0] as Request;
    expect(sentReq.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(sentReq.headers.get("X-Forwarded-Host")).toBe("app.example");
  });

  it("routes /etlservice (prefix stripped), /aiservice and /mcp to their containers", async () => {
    const s = setup();
    expect(await (await s.fetch("/etlservice/health-check?x=1")).text()).toBe("etl-response");
    const sent = s.etlFetch.mock.calls[0][0];
    expect(new URL(sent.url).pathname + new URL(sent.url).search).toBe("/health-check?x=1");
    expect(await (await s.fetch("/etlservice")).text()).toBe("etl-response");
    expect(new URL(s.etlFetch.mock.calls[1][0].url).pathname).toBe("/");
    expect(await (await s.fetch("/aiservice/health-check")).text()).toBe("ai-response");
    expect(await (await s.fetch("/mcp")).text()).toBe("mcp-response");
    expect(s.idWebFetch).not.toHaveBeenCalled();
  });

  it("routes /bi paths to the right Bold BI container, longest prefix first", async () => {
    const s = setup();
    const cases: [string, string][] = [
      ["/bi", "bi-web-response"],
      ["/bi/dashboards", "bi-web-response"],
      ["/bi/api/v1.0/items", "bi-api-response"],
      ["/bi/jobs/health-check", "bi-jobs-response"],
      ["/bi/designer", "bi-designer-response"],
      ["/bi/designer/helper/hub", "bi-designer-response"],
      ["/biography", "id-web-response"],
    ];
    for (const [p, body] of cases) expect(await (await s.fetch(p)).text()).toBe(body);
    expect(s.biWebFetch).toHaveBeenCalledTimes(2);
    expect(s.biDesignerFetch).toHaveBeenCalledTimes(2);
  });

  it("builds container env with S3 settings and no database settings", () => {
    const env = {
      BOLD_SERVICES_AMAZON_BUCKET_NAME: "bkt",
      BOLD_SERVICES_AWS_REGION: "us-east-1",
      BOLD_SERVICES_AWS_ACCESS_KEY_ID: "id",
      BOLD_SERVICES_AWS_SECRET_ACCESS_KEY: "secret",
    } as MultiEnv;
    const bi = buildContainerEnv("https://app.example/bi", env);
    expect(bi).toMatchObject({
      APP_BASE_URL: "https://app.example",
      BOLD_SERVICES_STORAGETYPE: "3",
      BOLD_SERVICES_AMAZON_BUCKET_NAME: "bkt",
      BOLD_SERVICES_AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(bi).not.toHaveProperty("BOLD_SERVICES_DB_HOST");
    expect(buildContainerEnv("https://a/", {} as MultiEnv)).not.toHaveProperty("BOLD_SERVICES_STORAGETYPE");
  });

  // Runs the generated entrypoint with the final `exec bash entrypoint.sh` swapped for `true`
  // and returns the parsed local_service_url.json the container would see.
  function renderUrlFile(env: Partial<MultiEnv>, appBaseUrl = "https://app.example/"): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), "urls-"));
    try {
      const script = buildServiceEntrypoint(internalKeysFor(env))[2]
        .replace("/application/app_data/configuration", `${dir}/configuration`)
        .replace("exec bash entrypoint.sh", "true");
      execFileSync("bash", ["-c", script], { env: { ...process.env, APP_BASE_URL: appBaseUrl } });
      return JSON.parse(readFileSync(`${dir}/configuration/local_service_url.json`, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const ALL_KEYS = [
    "Idp", "IdpApi", "Ums", "Bi", "BiApi", "BiJob", "BiDesigner", "BiDesignerHelper", "Etl", "EtlBlazor",
    "Ai", "Mcp", "Reports", "ReportsApi", "ReportsJob", "ReportsService", "ReportsViewer", "ReportsAi", "ReportsMcp",
  ];

  it("internal mode (default) writes internal URLs for ALL keys", () => {
    for (const env of [{}, { SERVICE_COMMUNICATION: "internal" }, { SERVICE_COMMUNICATION: "bogus" }]) {
      const json = renderUrlFile(env);
      expect(Object.keys(json)).toEqual(ALL_KEYS);
      for (const [k, v] of Object.entries(json)) {
        expect(v, k).toMatch(/^http:\/\/[a-z-]+(\/|$)/);
        expect(v, k).not.toContain("app.example");
      }
      expect(json).toMatchObject({
        Idp: "http://id-web", IdpApi: "http://id-api/api", Ums: "http://id-ums/ums", Bi: "http://bi-web/bi",
        BiApi: "http://bi-api/bi/api", BiJob: "http://bi-jobs/bi/jobs", BiDesigner: "http://bi-designer/bi/designer",
        Etl: "http://bi-etl", EtlBlazor: "http://bi-etl/framework/blazor.server.js",
        Ai: "http://bold-ai/aiservice", Mcp: "http://bold-mcp/mcp",
      });
    }
  });

  it("internal hosts all resolve to a container the Worker can forward to", () => {
    const hosts = new Set(Object.values(renderUrlFile({})).filter((u) => !/reports/.test(u)).map((u) => new URL(u).hostname));
    for (const h of hosts) expect(OUTBOUND_HOSTS, h).toContain(h);
  });

  it("public_url mode writes the public URL for ALL keys", () => {
    const json = renderUrlFile({ SERVICE_COMMUNICATION: "public_url" });
    expect(Object.keys(json)).toEqual(ALL_KEYS);
    for (const v of Object.values(json)) expect(v).toMatch(/^https:\/\/app\.example(\/|$)/);
    expect(json).toMatchObject({
      Idp: "https://app.example", IdpApi: "https://app.example/api", Ums: "https://app.example/ums",
      BiApi: "https://app.example/bi/api", Etl: "https://app.example/etlservice",
      EtlBlazor: "https://app.example/etlservice/framework/blazor.server.js", Ai: "https://app.example/aiservice",
      Mcp: "https://app.example/mcp",
    });
  });

  it("SERVICE_COMMUNICATION is case/space tolerant and INTERNAL_SERVICE_KEYS is ignored in public_url mode", () => {
    const json = renderUrlFile({ SERVICE_COMMUNICATION: " Public_URL ", INTERNAL_SERVICE_KEYS: "IdpApi" });
    expect(json.IdpApi).toBe("https://app.example/api");
  });

  it("INTERNAL_SERVICE_KEYS narrows internal mode; the other keys stay public", () => {
    const json = renderUrlFile({ INTERNAL_SERVICE_KEYS: "IdpApi, BiApi,Bogus" });
    expect(json.IdpApi).toBe("http://id-api/api");
    expect(json.BiApi).toBe("http://bi-api/bi/api");
    expect(json.Etl).toBe("https://app.example/etlservice");
    expect(json.Ums).toBe("https://app.example/ums");
  });

  it("empty INTERNAL_SERVICE_KEYS does not limit the default", () => {
    expect(internalKeysFor({ INTERNAL_SERVICE_KEYS: "  " })).toHaveLength(ALL_KEYS.length);
    expect(internalKeysFor({})).toEqual(ALL_KEYS);
    expect(internalKeysFor({ SERVICE_COMMUNICATION: "public_url" })).toEqual([]);
  });

  it("buildServiceUrls matches the rendered file", () => {
    expect(buildServiceUrls("https://app.example/", internalKeysFor({}))).toEqual(renderUrlFile({}));
    expect(buildServiceUrls("https://app.example/", [])).toEqual(renderUrlFile({ SERVICE_COMMUNICATION: "public_url" }));
  });

  it("forwards intercepted internal calls to the target container with public host headers", async () => {
    const { env, idApiFetch } = setup();
    env.APP_BASE_URL = "https://app.example";
    const res = await forwardInternal(new Request("http://id-api/api/token", { method: "POST" }), env);
    expect(await res.text()).toBe("id-api-response");
    const sent = (idApiFetch.mock.calls as unknown as Request[][])[0][0];
    expect(new URL(sent.url).pathname).toBe("/api/token");
    expect(sent.headers.get("X-Forwarded-Host")).toBe("app.example");
    expect(sent.headers.get("X-Forwarded-Proto")).toBe("https");
    expect((await forwardInternal(new Request("http://nope/x"), env)).status).toBe(502);
  });

  it("registers an outbound handler for every internal host", () => {
    const hosts = Object.keys((BiApiContainer as unknown as { outboundByHost: Record<string, unknown> }).outboundByHost);
    expect(hosts.sort()).toEqual([...OUTBOUND_HOSTS].sort());
  });

  it("ping-internal asks the caller container to ping each target", async () => {
    const { env } = setup();
    const pingInternal = vi.fn(async (host: string) => ({ host, ok: true, status: "200", ms: 5 }));
    (env.ID_UMS_CONTAINER as unknown as { getByName: unknown }).getByName = vi.fn(() => ({ pingInternal }));
    const res = await worker.fetch(new Request("https://app.example/_internal/ping-internal?from=id-ums&to=id-api,bogus,bi-jobs"), env);
    const json = (await res.json()) as { from: string; results: { host: string }[] };
    expect(json.from).toBe("id-ums");
    expect(json.results.map((r) => r.host)).toEqual(["id-api", "bi-jobs"]);
  });

  it("restart requires the admin token and restarts the requested containers", async () => {
    const { env } = setup();
    const restartContainer = vi.fn(async () => true);
    (env.ID_API_CONTAINER as unknown as { getByName: unknown }).getByName = vi.fn(() => ({ restartContainer }));
    const call = (e: MultiEnv, token?: string) =>
      worker.fetch(new Request("https://app.example/_internal/restart?host=id-api", { method: "POST", headers: token ? { "X-Admin-Token": token } : {} }), e);
    expect((await call(env, "x")).status).toBe(403); // secret not configured
    const withToken = { ...env, ADMIN_TOKEN: "s3cret" } as MultiEnv;
    expect((await call(withToken, "wrong")).status).toBe(403);
    const ok = await call(withToken, "s3cret");
    expect(await ok.json()).toEqual({ results: { "id-api": "restarted" } });
    expect(restartContainer).toHaveBeenCalledTimes(1);
  });

  it("caches successful health checks briefly", async () => {
    const { fetch, idApiFetch } = setup();
    await fetch("/api/health-check");
    const res = await fetch("/api/health-check");
    expect(res.status).toBe(200);
    expect(idApiFetch).toHaveBeenCalledTimes(1);
  });

  it("port readiness check only needs a TCP connection, not an HTTP answer", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn((_addr: string) => ({ opened: Promise.resolve(), close }));
    const ums = new IdUmsContainer({ container: { running: true, getTcpPort: () => ({ connect }) } } as never, {} as never);
    await expect(ums.waitForPort({ portToCheck: 80, retries: 3 })).resolves.toBe(0);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("ping:80");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("performance diagnostics", () => {
  it("percentile uses nearest-rank", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it("forwardInternal adds no timing and records nothing unless DIAG_ENABLED=true", async () => {
    const { env } = setup();
    const res = await forwardInternal(new Request("http://id-api/api/x"), env);
    expect(res.headers.get("Server-Timing")).toBeNull();
    expect(internalStatsReport()["id-api"]).toBeUndefined();
  });

  it("forwardInternal records stats and Server-Timing when DIAG_ENABLED=true", async () => {
    const { env } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await forwardInternal(new Request("http://bi-api/bi/api/x"), { ...env, DIAG_ENABLED: "true" });
    expect(res.headers.get("Server-Timing")).toContain("internal-forward");
    expect(internalStatsReport()["bi-api"].total.n).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ diag: "internal", host: "bi-api", status: 200 });
    log.mockRestore();
  });

  it("diag endpoints require the admin token and validate input", async () => {
    const { env } = setup();
    const call = (path: string, token?: string) =>
      worker.fetch(new Request("https://app.example" + path, { headers: token ? { "X-Admin-Token": token } : {} }), { ...env, ADMIN_TOKEN: "secret" });
    expect((await call("/_internal/diag/stats")).status).toBe(403);
    expect((await call("/_internal/diag/stats", "wrong")).status).toBe(403);
    expect((await call("/_internal/diag/stats", "secret")).status).toBe(200);
    expect((await call("/_internal/diag/curl?from=bad", "secret")).status).toBe(400);
    expect((await call("/_internal/diag/curl?from=id-web&to=id-api&path=/a;rm", "secret")).status).toBe(400);
    expect((await call("/_internal/diag/tcp?from=id-web&host=a;b&port=5432", "secret")).status).toBe(400);
    expect((await worker.fetch(new Request("https://app.example/_internal/diag/stats"), env)).status).toBe(403);
  });
});

describe("diag curl local mode", () => {
  it("calls loopback inside the container with forwarded headers, not the internal host", async () => {
    const { env } = setup();
    const diagExec = vi.fn(async (_s: string) => ({ ok: true, out: "200 0.001 0.001 0.002 0.003" }));
    const e = { ...env, ADMIN_TOKEN: "secret", ID_API_CONTAINER: { getByName: vi.fn(() => ({ diagExec })) } as never };
    const res = await worker.fetch(new Request("https://app.example/_internal/diag/curl?from=id-api&local=1&path=/api/health-check&n=1", { headers: { "X-Admin-Token": "secret" } }), e);
    expect(res.status).toBe(200);
    const script = diagExec.mock.calls[0][0];
    expect(script).toContain("http://127.0.0.1:80/api/health-check");
    expect(script).toContain("X-Forwarded-Host: app.example");
    expect(script).not.toContain("http://id-api");
  });
});

describe("Durable Object placement", () => {
  it("defaults to enam, accepts valid hints, falls back to apac on junk, and none disables", () => {
    expect(locationHintFor({})).toBe("enam");
    expect(locationHintFor({ DO_LOCATION_HINT: "APAC-SE" })).toBe("apac-se");
    expect(locationHintFor({ DO_LOCATION_HINT: "apac" })).toBe("apac");
    expect(locationHintFor({ DO_LOCATION_HINT: "mars" })).toBe("enam");
    expect(locationHintFor({ DO_LOCATION_HINT: "none" })).toBeUndefined();
  });

  it("passes the same hint for every service, public and internal", async () => {
    const { env, fetch } = setup();
    for (const p of ["/", "/api/x", "/ums/x", "/bi", "/bi/api/x", "/bi/jobs/x", "/bi/designer", "/etlservice/x", "/aiservice/x", "/mcp"]) await fetch(p);
    await forwardInternal(new Request("http://id-api/api/x"), env);
    const all = [env.ID_WEB_CONTAINER, env.ID_API_CONTAINER, env.ID_UMS_CONTAINER, env.BI_WEB_CONTAINER, env.BI_API_CONTAINER,
      env.BI_JOBS_CONTAINER, env.BI_DESIGNER_CONTAINER, env.BI_ETL_CONTAINER, env.BOLD_AI_CONTAINER, env.BOLD_MCP_CONTAINER];
    for (const ns of all) {
      const calls = (ns.getByName as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c[1]).toEqual({ locationHint: "enam" });
    }
  });

  it("DO_NAME_SUFFIX renames objects consistently; unknown hosts return undefined", () => {
    const { env } = setup();
    serviceStub({ ...env, DO_NAME_SUFFIX: "v2", DO_LOCATION_HINT: "none" }, "bi-web");
    expect((env.BI_WEB_CONTAINER.getByName as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["bi-web-v2", undefined]);
    expect(serviceStub(env, "nope")).toBeUndefined();
  });
});

describe("wrangler placement config", () => {
  it("constrains all 10 containers to ENAM and keeps one instance each", () => {
    const cfg = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    expect(cfg.containers).toHaveLength(10);
    for (const c of cfg.containers) {
      expect(c.constraints).toEqual({ regions: ["ENAM"] });
      expect(c.max_instances).toBe(1);
    }
  });
});

describe("static asset caching", () => {
  const on = (o: Partial<MultiEnv> = {}) => ({ STATIC_CACHE: "true", ...o }) as MultiEnv;
  const req = (p: string, init?: RequestInit) => new Request("https://app.example" + p, init);

  it("is off unless STATIC_CACHE=true", () => {
    expect(staticCacheEligible(req("/bi/cdn/scripts/a.js?v=x"), {} as MultiEnv)).toBe(false);
  });
  it("allows only listed static GET/HEAD paths", () => {
    for (const p of ["/bi/cdn/scripts/a.min.js?v=abc", "/bi/designer/cultures/x.js?version=17.1.30", "/bi/js/localizationcontent.js?v=17.1.30&c=en-US"])
      expect(staticCacheEligible(req(p), on())).toBe(true);
    for (const p of ["/bi/site/site1/content/images/favicon.ico", "/bi/api/x", "/ums/a.js", "/bi/cdn/", "/bi//cdn/a.js", "/bi/cdn/../site/x", "/api/health-check", "/"])
      expect(staticCacheEligible(req(p), on())).toBe(false);
    expect(staticCacheEligible(req("/bi/cdn/a.js", { method: "POST" }), on())).toBe(false);
    expect(staticCacheEligible(req("/bi/cdn/a.js", { headers: { Range: "bytes=0-1" } }), on())).toBe(false);
  });
  it("sets TTL by version type", () => {
    expect(staticCacheTtl(new URL("https://a/bi/cdn/a.js?v=Ser7ThB3"), on())).toBe(2592000);
    expect(staticCacheTtl(new URL("https://a/bi/cdn/a.js?version=17.1.30"), on())).toBe(86400);
    expect(staticCacheTtl(new URL("https://a/bi/cdn/a.woff"), on())).toBe(3600);
    expect(staticCacheTtl(new URL("https://a/bi/cdn/a.woff"), on({ STATIC_CACHE_UNVERSIONED_TTL: "0" }))).toBe(0);
  });
  it("caches only clean 200 static responses", () => {
    const u = new URL("https://a/bi/cdn/a.js?v=abc");
    const good = applyStaticCachePolicy(new Response("x", { headers: { "Content-Type": "text/javascript" } }), u, on());
    expect(good.headers.get("Cache-Control")).toContain("public, max-age=2592000");
    const bad = [
      new Response("x", { status: 500, headers: { "Content-Type": "text/javascript" } }),
      new Response("x", { status: 302, headers: { "Content-Type": "text/javascript" } }),
      new Response("x", { headers: { "Content-Type": "text/html" } }),
      new Response("x", { headers: { "Content-Type": "text/javascript", "Set-Cookie": "a=b" } }),
      new Response("x", { headers: { "Content-Type": "text/javascript", Vary: "*" } }),
    ];
    for (const r of bad) expect(applyStaticCachePolicy(r, u, on()).headers.get("Cache-Control")).toBe("no-store");
  });
  it("gateway strips Cookie/Authorization before the cached entrypoint, and leaves other paths alone", async () => {
    const { env, biWebFetch } = setup();
    const seen: Request[] = [];
    const ctx = { exports: { StaticAssets: { fetch: async (r: Request) => (seen.push(r), new Response("js", { headers: { "Content-Type": "text/javascript" } })) } } };
    const e = { ...env, STATIC_CACHE: "true" } as MultiEnv;
    const h = { Cookie: "s=1", Authorization: "Bearer t" };
    await worker.fetch(new Request("https://app.example/bi/cdn/scripts/a.js?v=abc", { headers: h }), e, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("Cookie")).toBeNull();
    expect(seen[0].headers.get("Authorization")).toBeNull();
    await worker.fetch(new Request("https://app.example/bi/site/site1/x.ico", { headers: h }), e, ctx);
    expect(seen).toHaveLength(1);
    expect(biWebFetch).toHaveBeenCalledTimes(1);
  });
});
