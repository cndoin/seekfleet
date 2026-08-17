import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { startDashboardServer, type DashboardServerHandle } from "../src/dashboard-server.js";

let handle: DashboardServerHandle | undefined;

function httpRequest(
  url: string,
  opts: { method?: string; authorization?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: opts.method,
        headers: opts.authorization ? { authorization: opts.authorization } : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("DashboardServer", () => {
  it("rejects invalid ports before binding", async () => {
    await expect(
      startDashboardServer({
        port: 70_000,
        getSnapshot: () => ({ generatedAt: 1, uptimeMs: 2, clusters: [], sessions: [] }),
      }),
    ).rejects.toThrow("dashboard port");
  });

  it("protects snapshots with a bearer token", async () => {
    handle = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      getSnapshot: () => ({ generatedAt: 1, uptimeMs: 2, clusters: [], sessions: [] }),
    });
    const base = `http://127.0.0.1:${handle.port}`;
    expect((await httpRequest(base + "/health")).status).toBe(200);
    const html = (await httpRequest(base + "/")).text;
    expect(html).toContain("SeekFleet Control");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(() => new Function(script ?? "")).not.toThrow();
    expect((await httpRequest(base + "/api/snapshot")).status).toBe(401);
    const response = await httpRequest(base + "/api/snapshot", { authorization: "Bearer test-token" });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { ok: boolean; data: { uptimeMs: number } };
    expect(body.ok).toBe(true);
    expect(body.data.uptimeMs).toBe(2);
  });

  it("routes protected control actions", async () => {
    let cancelled = "";
    handle = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      token: "control-token",
      getSnapshot: () => ({ generatedAt: 1, uptimeMs: 2, clusters: [], sessions: [] }),
      cancelSession: (runId) => {
        cancelled = runId;
        return true;
      },
    });
    const response = await httpRequest(`http://127.0.0.1:${handle.port}/api/sessions/run-1/cancel`, {
      method: "POST",
      authorization: "Bearer control-token",
    });
    expect(response.status).toBe(200);
    expect(cancelled).toBe("run-1");
  });
});
