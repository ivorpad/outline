import Router from "koa-router";
import { Op, literal } from "sequelize";
import env from "@server/env";
import { AuthorizationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { Document } from "@server/models";
import { presentDocument, presentPolicies } from "@server/presenters";
import IndexDocumentTask from "@server/queues/tasks/IndexDocumentTask";
import type { APIContext } from "@server/types";
import {
  VectorAIRetriever,
  ensureCollection,
  searchDocuments,
} from "@server/utils/aiIndexer";
import { cannot } from "@server/policies";
import * as T from "./schema";

const router = new Router();

router.post(
  "aiAnswers.reindex",
  auth(),
  validate(T.AiAnswersReindexSchema),
  async (ctx: APIContext<T.AiAnswersReindexReq>) => {
    const { user } = ctx.state.auth;
    if (!user.isAdmin) {
      throw AuthorizationError("Only admins can rebuild the AI index");
    }
    if (!env.AI_ANSWERS_ENABLED) {
      throw AuthorizationError("AI answers is disabled — set AI_ANSWERS_ENABLED=true");
    }

    await ensureCollection();
    const force = ctx.input.body?.force === true;

    const baseWhere = {
      teamId: user.teamId,
      publishedAt: { [Op.ne]: null },
      archivedAt: null,
      deletedAt: null,
    };

    const [staleDocs, totalCount] = await Promise.all([
      Document.findAll({
        attributes: ["id"],
        where: force
          ? baseWhere
          : {
              ...baseWhere,
              [Op.and]: literal(
                '("document"."aiIndexedAt" IS NULL OR "document"."aiIndexedAt" < "document"."updatedAt")'
              ),
            },
      }),
      Document.count({ where: baseWhere }),
    ]);

    for (const doc of staleDocs) {
      await new IndexDocumentTask().schedule({ documentId: doc.id });
    }

    Logger.info(
      "ai",
      `Queued reindex for ${staleDocs.length}/${totalCount} documents (force=${force})`
    );
    ctx.body = {
      ok: true,
      queued: staleDocs.length,
      total: totalCount,
      skipped: totalCount - staleDocs.length,
      force,
    };
  }
);

router.post(
  "aiAnswers.ask",
  auth(),
  validate(T.AiAnswersAskSchema),
  async (ctx: APIContext<T.AiAnswersAskReq>) => {
    const { user } = ctx.state.auth;
    if (!env.AI_ANSWERS_ENABLED) {
      throw AuthorizationError("AI answers is disabled");
    }

    const retriever = new VectorAIRetriever(
      user.teamId,
      ctx.input.body.limit ?? 6
    );
    const docs = await retriever.invoke(ctx.input.body.query);
    const hits = docs.map((d) => ({
      documentId: String(d.metadata.documentId ?? ""),
      title: String(d.metadata.title ?? ""),
      url: String(d.metadata.url ?? ""),
      text: d.pageContent,
      score: Number(d.metadata.score ?? 0),
    }));

    if (hits.length === 0) {
      ctx.body = {
        answer:
          "I couldn't find any documents in your workspace that match this question. Try rephrasing, or index more documents from Settings → AI.",
        citations: [],
        grounded: false,
      };
      return;
    }
    if (!env.LITELLM_URL || !env.LITELLM_API_KEY) {
      ctx.body = { answer: null, citations: hits, grounded: false };
      return;
    }

    const context = hits
      .map(
        (h, i) =>
          `[${i + 1}] ${h.title}\n${h.text.slice(0, 1500)}`
      )
      .join("\n\n---\n\n");

    const res = await fetch(`${env.LITELLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LITELLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_ANSWER_MODEL,
        messages: [
          {
            role: "system",
            content: [
              "You are a documentation assistant for this workspace.",
              "You may ONLY answer using the numbered context excerpts below.",
              "Cite every claim inline with [1], [2], ... matching the source number.",
              "If the context does not contain the answer, respond exactly with:",
              '"I couldn\'t find that in the indexed documents."',
              "Do NOT use any outside knowledge. Do NOT speculate, infer, or invent facts.",
              "Do NOT mention training data, your model, or general knowledge.",
              "If the question is off-topic for this workspace, refuse and suggest searching.",
            ].join("\n"),
          },
          {
            role: "user",
            content: `Question: ${ctx.input.body.query}\n\nContext:\n${context}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      Logger.error("AI answer LLM failed", new Error(`${res.status}: ${body}`));
      ctx.body = { answer: null, citations: hits, error: "llm_failed" };
      return;
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    ctx.body = {
      answer: data.choices[0]?.message.content ?? null,
      citations: hits,
      grounded: true,
    };
  }
);

router.post(
  "aiAnswers.search",
  auth(),
  validate(T.AiAnswersSearchSchema),
  async (ctx: APIContext<T.AiAnswersSearchReq>) => {
    const { user } = ctx.state.auth;
    if (!env.AI_ANSWERS_ENABLED) {
      throw AuthorizationError("AI answers is disabled");
    }
    const hits = await searchDocuments(
      ctx.input.body.query,
      user.teamId,
      ctx.input.body.limit ?? 20
    );

    const docs = hits.length
      ? await Document.withMembershipScope(user.id, {
          includeDrafts: false,
        }).findAll({
          where: { id: hits.map((h) => h.documentId) },
          paranoid: true,
        })
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));

    const visibleDocs = [];
    const results = [];
    for (const hit of hits) {
      const doc = byId.get(hit.documentId);
      if (!doc || cannot(user, "read", doc)) {
        continue;
      }
      visibleDocs.push(doc);
      results.push({
        id: doc.id,
        ranking: hit.score,
        context: hit.snippet,
        document: await presentDocument(ctx, doc),
      });
    }

    ctx.body = {
      pagination: { offset: 0, limit: results.length, total: results.length },
      data: results,
      policies: presentPolicies(user, visibleDocs),
    };
  }
);

router.post(
  "aiAnswers.status",
  auth(),
  validate(T.AiAnswersStatusSchema),
  async (ctx: APIContext<T.AiAnswersStatusReq>) => {
    const { user } = ctx.state.auth;
    const baseWhere = {
      teamId: user.teamId,
      publishedAt: { [Op.ne]: null },
      archivedAt: null,
      deletedAt: null,
    };
    const [total, indexed, stale] = await Promise.all([
      Document.count({ where: baseWhere }),
      Document.count({
        where: {
          ...baseWhere,
          [Op.and]: literal(
            '("document"."aiIndexedAt" IS NOT NULL AND "document"."aiIndexedAt" >= "document"."updatedAt")'
          ),
        },
      }),
      Document.count({
        where: {
          ...baseWhere,
          [Op.and]: literal(
            '("document"."aiIndexedAt" IS NULL OR "document"."aiIndexedAt" < "document"."updatedAt")'
          ),
        },
      }),
    ]);
    ctx.body = {
      enabled: env.AI_ANSWERS_ENABLED,
      total,
      indexed,
      pending: stale,
    };
  }
);

export default router;
