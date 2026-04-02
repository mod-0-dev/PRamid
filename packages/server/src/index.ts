import Fastify from "fastify";
import {
  restack,
  reorderStack,
  splitStack,
  closePR,
  mergeSinglePR,
  mergeStack,
  syncStack,
  getCurrentBranch,
  checkoutBranch,
  listLocalBranches,
} from "@pramid/core";
import type { VcsClient, MergeStrategy } from "@pramid/core";
import type { RepoRef } from "@pramid/core";

export interface ServerOptions {
  repo: RepoRef;
  client: VcsClient;
  port: number;
  remote: string;
  cwd: string;
  assets: { html: string; js: string; css: string };
}

export async function startServer(options: ServerOptions): Promise<void> {
  const { repo, client, port, remote, cwd, assets } = options;

  const app = Fastify({ logger: false });

  app.get("/api/graph", async (_req, reply) => {
    try {
      const prs = await client.listOpenPRs(repo);
      return reply.send({ prs });
    } catch (err) {
      reply.status(500).send({ error: (err as Error).message });
    }
  });

  app.post("/api/restack", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await restack(client, { repo, startBranch: branch, remote, cwd });

      if (result.conflict) {
        return reply.send({
          ok: false,
          conflict: { branch: result.conflict.pr.headBranch, files: result.conflict.files },
          restacked: result.restacked.length,
        });
      }

      return reply.send({ ok: true, restacked: result.restacked.length });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/reorder", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await reorderStack(client, { repo, branch, remote, cwd });

      if (result.conflict) {
        return reply.send({
          ok: false,
          conflict: { branch: result.conflict.pr.headBranch, files: result.conflict.files },
        });
      }

      return reply.send({
        ok: true,
        promoted: result.promotedPr.number,
        demoted: result.demotedPr.number,
      });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/split", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await splitStack(client, { repo, branch, remote, cwd });

      if (result.conflict) {
        return reply.send({
          ok: false,
          conflict: { branch: result.conflict.pr.headBranch, files: result.conflict.files },
        });
      }

      return reply.send({ ok: true, split: result.splitPr.number });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/close", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await closePR(client, { repo, branch });
      return reply.send({
        ok: true,
        closed: result.closedPr.number,
        retargeted: result.retargeted.length,
      });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/merge", async (req, reply) => {
    const { branch, strategy = "merge" } = req.body as { branch?: string; strategy?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await mergeSinglePR(client, {
        repo,
        branch,
        strategy: strategy as MergeStrategy,
      });
      return reply.send({
        ok: true,
        merged: result.mergedPr.number,
        retargeted: result.retargeted.length,
        warnings: result.warnings,
      });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/merge-stack", async (req, reply) => {
    const { branch, strategy = "merge" } = req.body as { branch?: string; strategy?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await mergeStack(client, {
        repo,
        branch,
        strategy: strategy as MergeStrategy,
      });
      return reply.send({
        ok: !result.failedAt,
        merged: result.merged.length,
        retargeted: result.retargeted.length,
        warnings: result.warnings,
        failedAt: result.failedAt
          ? `#${result.failedAt.pr.number}: ${result.failedAt.error}`
          : undefined,
      });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/sync", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      const result = await syncStack(client, { repo, branch, remote, cwd });

      if (result.conflict) {
        return reply.send({
          ok: false,
          synced: result.synced.length,
          conflict: { branch: result.conflict.pr.headBranch, files: result.conflict.files },
        });
      }

      return reply.send({ ok: true, synced: result.synced.length, baseBranch: result.baseBranch });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/api/branches", async (_req, reply) => {
    try {
      const current = getCurrentBranch(cwd);
      const branches = listLocalBranches(cwd);
      return reply.send({ current, branches });
    } catch (err) {
      reply.status(500).send({ error: (err as Error).message });
    }
  });

  app.post("/api/checkout", async (req, reply) => {
    const { branch } = req.body as { branch?: string };
    if (!branch) return reply.status(400).send({ error: "branch is required" });

    try {
      checkoutBranch(branch, cwd);
      return reply.send({ ok: true, branch });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/assets/index.js", async (_req, reply) => {
    return reply.type("application/javascript").send(assets.js);
  });

  app.get("/assets/index.css", async (_req, reply) => {
    return reply.type("text/css").send(assets.css);
  });

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.type("text/html").send(assets.html);
  });

  await app.listen({ port, host: "127.0.0.1" });
}
