import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { IdUmsContainer, MultiEnv, buildContainerEnv } from "./worker";

function setup() {
  const idWebFetch = vi.fn(async () => new Response("id-web-response"));
  const idApiFetch = vi.fn(async () => new Response("id-api-response"));
  const idUmsFetch = vi.fn(async () => new Response("id-ums-response"));

  const biWebFetch = vi.fn(async () => new Response("bi-web-response"));
  const biApiFetch = vi.fn(async () => new Response("bi-api-response"));
  const biJobsFetch = vi.fn(async () => new Response("bi-jobs-response"));
  const biDesignerFetch = vi.fn(async () => new Response("bi-designer-response"));

  const env: MultiEnv = {
    BI_WEB_CONTAINER: { getByName: vi.fn(() => ({ fetch: biWebFetch })) } as never,
    BI_API_CONTAINER: { getByName: vi.fn(() => ({ fetch: biApiFetch })) } as never,
    BI_JOBS_CONTAINER: { getByName: vi.fn(() => ({ fetch: biJobsFetch })) } as never,
    BI_DESIGNER_CONTAINER: { getByName: vi.fn(() => ({ fetch: biDesignerFetch })) } as never,
    ID_WEB_CONTAINER: { getByName: vi.fn(() => ({ fetch: idWebFetch })) } as never,
    ID_API_CONTAINER: { getByName: vi.fn(() => ({ fetch: idApiFetch })) } as never,
    ID_UMS_CONTAINER: { getByName: vi.fn(() => ({ fetch: idUmsFetch })) } as never,
  };

  const fetch = (path: string, init?: RequestInit) =>
    worker.fetch(new Request("https://app.example" + path, init), env);

  return { env, fetch, idWebFetch, idApiFetch, idUmsFetch, biWebFetch, biApiFetch, biJobsFetch, biDesignerFetch };
}

describe("multi routing tests", () => {
  it("routes /_internal/health without hitting containers", async () => {
    const { fetch, env } = setup();
    const res = await fetch("/_internal/health");
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; services: string[] };
    expect(json.ok).toBe(true);
    expect(json.services).toEqual(["id-web", "id-api", "id-ums", "bi-web", "bi-api", "bi-jobs", "bi-designer"]);
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

  it("returns 503 for services that are not deployed, without touching containers", async () => {
    const { fetch, idWebFetch, idApiFetch, idUmsFetch } = setup();
    for (const p of ["/aiservice", "/etlservice/x", "/mcp"]) {
      expect((await fetch(p)).status).toBe(503);
    }
    expect(idWebFetch).not.toHaveBeenCalled();
    expect(idApiFetch).not.toHaveBeenCalled();
    expect(idUmsFetch).not.toHaveBeenCalled();
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

  it("builds container env: S3 for all services, database only for UMS", () => {
    const env = {
      BOLD_SERVICES_AMAZON_BUCKET_NAME: "bkt",
      BOLD_SERVICES_AWS_REGION: "us-east-1",
      BOLD_SERVICES_AWS_ACCESS_KEY_ID: "id",
      BOLD_SERVICES_AWS_SECRET_ACCESS_KEY: "secret",
      BOLD_SERVICES_DB_HOST: "db.example",
      BOLD_SERVICES_DB_PASSWORD: "pw",
    } as MultiEnv;
    const bi = buildContainerEnv("https://app.example/bi", env, false);
    expect(bi).toMatchObject({
      APP_BASE_URL: "https://app.example",
      BOLD_SERVICES_STORAGETYPE: "3",
      BOLD_SERVICES_AMAZON_BUCKET_NAME: "bkt",
      BOLD_SERVICES_AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(bi).not.toHaveProperty("BOLD_SERVICES_DB_HOST");
    const ums = buildContainerEnv("https://app.example/ums", env, true);
    expect(ums).toMatchObject({ BOLD_SERVICES_DB_TYPE: "postgresql", BOLD_SERVICES_DB_HOST: "db.example", BOLD_SERVICES_DB_PASSWORD: "pw" });
    expect(buildContainerEnv("https://a/", {} as MultiEnv, false)).not.toHaveProperty("BOLD_SERVICES_STORAGETYPE");
  });

  it("caches successful health checks briefly", async () => {
    const { fetch, idApiFetch } = setup();
    await fetch("/api/health-check");
    const res = await fetch("/api/health-check");
    expect(res.status).toBe(200);
    expect(idApiFetch).toHaveBeenCalledTimes(1);
  });

  it("port readiness check treats a redirect as ready and does not follow it", async () => {
    const portFetch = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 302 }));
    const ums = new IdUmsContainer(
      { container: { running: true, getTcpPort: () => ({ fetch: portFetch }) } } as never,
      {} as never,
    );
    await expect(ums.waitForPort({ portToCheck: 80, retries: 3 })).resolves.toBe(0);
    expect(portFetch).toHaveBeenCalledTimes(1);
    expect(portFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
});
