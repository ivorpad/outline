import { createHash } from "node:crypto";
import { Document as LCDocument } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { Node } from "prosemirror-model";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import { schema, serializer } from "@server/editor";
import { Document } from "@server/models";

const TOKEN_TO_CHAR_RATIO = 4;
const CHUNK_SIZE = 800 * TOKEN_TO_CHAR_RATIO;
const CHUNK_OVERLAP = 150 * TOKEN_TO_CHAR_RATIO;
const EMBED_BATCH_SIZE = 96;

const splitter = new MarkdownTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

let cachedToken: { value: string; expiresAt: number } | null = null;

async function vectorAiToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  if (!env.VECTORAI_URL || !env.VECTORAI_PASSWORD) {
    throw new Error("VECTORAI_URL or VECTORAI_PASSWORD not configured");
  }
  const res = await fetch(`${env.VECTORAI_URL}/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.VECTORAI_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`VectorAI login failed: ${res.status}`);
  }
  const data = (await res.json()) as { token: string; expires_in: number };
  cachedToken = {
    value: data.token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.token;
}

async function vectorAi<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await vectorAiToken();
  const res = await fetch(`${env.VECTORAI_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`VectorAI ${init.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function ensureCollection(): Promise<void> {
  const name = env.VECTORAI_COLLECTION;
  try {
    await vectorAi(`/collections/${name}`);
    return;
  } catch (err) {
    if (!(err as Error).message.includes("404")) {
      throw err;
    }
  }
  await vectorAi(`/collections/${name}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: { size: env.AI_EMBEDDING_DIM, distance: "Cosine" },
      hnsw_config: { m: 16, ef_construct: 200, ef_search: 50 },
    }),
  });
  Logger.info("ai", `Created VectorAI collection ${name}`);
}

async function embedBatch(input: string[]): Promise<number[][]> {
  if (!env.LITELLM_URL || !env.LITELLM_API_KEY) {
    throw new Error("LITELLM_URL or LITELLM_API_KEY not configured");
  }
  const res = await fetch(`${env.LITELLM_URL}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LITELLM_API_KEY}`,
    },
    body: JSON.stringify({ model: env.AI_EMBEDDING_MODEL, input }),
  });
  if (!res.ok) {
    throw new Error(`Embedding ${env.AI_EMBEDDING_MODEL} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function embed(input: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += EMBED_BATCH_SIZE) {
    const slice = input.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(slice);
    out.push(...vectors);
  }
  return out;
}

function pointId(documentId: string, chunkIndex: number): string {
  return createHash("sha1")
    .update(`${documentId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);
}

function headingPath(chunk: string): string {
  const heading = chunk.match(/^(#{1,6}\s+.+)$/m);
  return heading ? heading[1].replace(/^#+\s*/, "") : "";
}

export async function indexDocument(documentId: string): Promise<number> {
  const document = await Document.findByPk(documentId, {
    paranoid: false,
    rejectOnEmpty: true,
  });

  if (document.deletedAt || document.archivedAt || !document.publishedAt) {
    await deleteDocumentChunks(documentId);
    return 0;
  }

  const node = Node.fromJSON(schema, document.content);
  const markdown = `# ${document.title}\n\n${serializer.serialize(node)}`;

  const chunks = await splitter.splitText(markdown);
  if (chunks.length === 0) {
    return 0;
  }

  await deleteDocumentChunks(documentId);

  const vectors = await embed(chunks);

  const points = chunks.map((text, i) => ({
    id: pointId(documentId, i),
    vector: vectors[i],
    payload: {
      documentId,
      teamId: document.teamId,
      collectionId: document.collectionId,
      title: document.title,
      url: document.url,
      chunkIndex: i,
      headingPath: headingPath(text),
      text,
    },
  }));

  await vectorAi(`/collections/${env.VECTORAI_COLLECTION}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });

  document.aiIndexedAt = new Date();
  await document.save({ silent: true, fields: ["aiIndexedAt"] });

  Logger.info("ai", `Indexed document ${documentId} (${chunks.length} chunks)`);
  return chunks.length;
}

export async function deleteDocumentChunks(documentId: string): Promise<void> {
  await vectorAi(`/collections/${env.VECTORAI_COLLECTION}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        must: [{ key: "documentId", match: { value: documentId } }],
      },
    }),
  }).catch((err) => {
    if (!String(err).includes("404")) {
      throw err;
    }
  });
}

export type AnswerHit = {
  documentId: string;
  title: string;
  url: string;
  text: string;
  score: number;
};

export async function searchChunks(
  query: string,
  teamId: string,
  limit = 8
): Promise<AnswerHit[]> {
  const [vector] = await embed([query]);
  const result = await vectorAi<{
    result: Array<{ score: number; payload: Record<string, unknown> }>;
  }>(`/collections/${env.VECTORAI_COLLECTION}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      with_vector: false,
      filter: { must: [{ key: "teamId", match: { value: teamId } }] },
    }),
  });
  return result.result.map((r) => ({
    documentId: String(r.payload.documentId ?? ""),
    title: String(r.payload.title ?? ""),
    url: String(r.payload.url ?? ""),
    text: String(r.payload.text ?? ""),
    score: r.score,
  }));
}

/**
 * LangChain Retriever wrapper around VectorAI so call sites can use the
 * LangChain runnable interface (chains, multi-query, reranking, etc.) instead
 * of the raw searchChunks fetch.
 */
export class VectorAIRetriever extends BaseRetriever {
  public static lc_name() {
    return "VectorAIRetriever";
  }

  public lc_namespace = ["outline", "retrievers", "vectorai"];

  constructor(
    private readonly teamId: string,
    private readonly k = 8
  ) {
    super();
  }

  protected async _getRelevantDocuments(query: string): Promise<LCDocument[]> {
    const hits = await searchChunks(query, this.teamId, this.k);
    return hits.map(
      (h) =>
        new LCDocument({
          pageContent: h.text,
          metadata: {
            documentId: h.documentId,
            title: h.title,
            url: h.url,
            score: h.score,
          },
        })
    );
  }
}

/** Returns *unique* Outline documents ranked by max-chunk score. */
export async function searchDocuments(
  query: string,
  teamId: string,
  limit = 10
): Promise<Array<{ documentId: string; title: string; url: string; score: number; snippet: string }>> {
  const retriever = new VectorAIRetriever(teamId, Math.max(limit * 3, 12));
  const docs = await retriever.invoke(query);
  const best = new Map<
    string,
    { documentId: string; title: string; url: string; score: number; snippet: string }
  >();
  for (const d of docs) {
    const id = String(d.metadata.documentId);
    if (!id) {
      continue;
    }
    const existing = best.get(id);
    const score = Number(d.metadata.score ?? 0);
    if (!existing || existing.score < score) {
      best.set(id, {
        documentId: id,
        title: String(d.metadata.title ?? ""),
        url: String(d.metadata.url ?? ""),
        score,
        snippet: d.pageContent.slice(0, 280),
      });
    }
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
