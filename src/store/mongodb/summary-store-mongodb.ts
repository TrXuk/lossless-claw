import type { Collection, Db } from "mongodb";
import { buildLikeSearchPlan, createFallbackSnippet } from "../full-text-fallback.js";
import { mergeWithRRF } from "./search-utils.js";
import type {
  ContextItemRecord,
  ContextItemType,
  CreateLargeFileInput,
  CreateSummaryInput,
  LargeFileRecord,
  SummaryKind,
  SummaryRecord,
  SummarySearchInput,
  SummarySearchResult,
  SummarySubtreeNodeRecord,
} from "../summary-store.js";

function toSummaryRecord(doc: {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  fileIds: string[] | string;
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  createdAt: Date;
}): SummaryRecord {
  const fileIds = Array.isArray(doc.fileIds) ? doc.fileIds : [];
  return {
    summaryId: doc.summaryId,
    conversationId: doc.conversationId,
    kind: doc.kind,
    depth: doc.depth,
    content: doc.content,
    tokenCount: doc.tokenCount,
    fileIds,
    earliestAt: doc.earliestAt,
    latestAt: doc.latestAt,
    descendantCount: doc.descendantCount ?? 0,
    descendantTokenCount: doc.descendantTokenCount ?? 0,
    sourceMessageTokenCount: doc.sourceMessageTokenCount ?? 0,
    createdAt: doc.createdAt,
  };
}

export class SummaryStoreMongoDB {
  private summaries: Collection;
  private summaryMessages: Collection;
  private summaryParents: Collection;
  private contextItems: Collection;
  private largeFiles: Collection;
  private messages: Collection;
  private readonly fts5Available: boolean;
  private readonly searchIndexSummaries: string;
  private readonly vectorSearchIndexSummaries: string;

  constructor(
    db: Db,
    options?: {
      fts5Available?: boolean;
      searchIndexMessages?: string;
      searchIndexSummaries?: string;
      vectorSearchIndexMessages?: string;
      vectorSearchIndexSummaries?: string;
    },
  ) {
    this.summaries = db.collection("summaries");
    this.summaryMessages = db.collection("summary_messages");
    this.summaryParents = db.collection("summary_parents");
    this.contextItems = db.collection("context_items");
    this.largeFiles = db.collection("large_files");
    this.messages = db.collection("messages");
    this.fts5Available = options?.fts5Available ?? true;
    this.searchIndexSummaries = options?.searchIndexSummaries ?? "lcm_summaries_search";
    this.vectorSearchIndexSummaries = options?.vectorSearchIndexSummaries ?? "lcm_summaries_vector";
  }

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const depth =
      typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0
        ? Math.floor(input.depth)
        : input.kind === "leaf"
          ? 0
          : 1;
    const descendantCount = Math.max(0, Math.floor(input.descendantCount ?? 0));
    const descendantTokenCount = Math.max(0, Math.floor(input.descendantTokenCount ?? 0));
    const sourceMessageTokenCount = Math.max(0, Math.floor(input.sourceMessageTokenCount ?? 0));
    const now = new Date();
    const doc = {
      summaryId: input.summaryId,
      conversationId: input.conversationId,
      kind: input.kind,
      depth,
      content: input.content,
      tokenCount: input.tokenCount,
      fileIds: input.fileIds ?? [],
      earliestAt: input.earliestAt ?? null,
      latestAt: input.latestAt ?? null,
      descendantCount,
      descendantTokenCount,
      sourceMessageTokenCount,
      createdAt: now,
    };
    await this.summaries.insertOne(doc);
    return toSummaryRecord(doc);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const doc = await this.summaries.findOne({ summaryId });
    return doc ? toSummaryRecord(doc) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const docs = await this.summaries
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map(toSummaryRecord);
  }

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const ops = messageIds.map((messageId, ordinal) => ({
      updateOne: {
        filter: { summaryId, messageId },
        update: { $setOnInsert: { summaryId, messageId, ordinal } },
        upsert: true,
      },
    }));
    await this.summaryMessages.bulkWrite(ops);
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) return;
    const ops = parentSummaryIds.map((parentSummaryId, ordinal) => ({
      updateOne: {
        filter: { summaryId, parentSummaryId },
        update: { $setOnInsert: { summaryId, parentSummaryId, ordinal } },
        upsert: true,
      },
    }));
    await this.summaryParents.bulkWrite(ops);
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const docs = await this.summaryMessages
      .find({ summaryId })
      .sort({ ordinal: 1 })
      .project({ messageId: 1 })
      .toArray();
    return docs.map((d) => d.messageId);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const links = await this.summaryParents
      .find({ parentSummaryId })
      .sort({ ordinal: 1 })
      .toArray();
    if (links.length === 0) return [];
    const summaryIds = links.map((l) => l.summaryId);
    const docs = await this.summaries.find({ summaryId: { $in: summaryIds } }).toArray();
    const byId = new Map(docs.map((d) => [d.summaryId, d]));
    return links.map((l) => toSummaryRecord(byId.get(l.summaryId)!));
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const links = await this.summaryParents
      .find({ summaryId })
      .sort({ ordinal: 1 })
      .toArray();
    if (links.length === 0) return [];
    const parentIds = links.map((l) => l.parentSummaryId);
    const docs = await this.summaries.find({ summaryId: { $in: parentIds } }).toArray();
    const byId = new Map(docs.map((d) => [d.summaryId, d]));
    return links.map((l) => toSummaryRecord(byId.get(l.parentSummaryId)!));
  }

  async getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]> {
    const visited = new Set<string>();
    const output: SummarySubtreeNodeRecord[] = [];
    const queue: Array<{ id: string; depthFromRoot: number; parentId: string | null; path: string }> = [
      { id: summaryId, depthFromRoot: 0, parentId: null, path: "" },
    ];

    while (queue.length > 0) {
      const { id, depthFromRoot, parentId, path } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const doc = await this.summaries.findOne({ summaryId: id });
      if (!doc) continue;

      const childLinks = await this.summaryParents.find({ parentSummaryId: id }).sort({ ordinal: 1 }).toArray();
      const childCount = childLinks.length;

      output.push({
        ...toSummaryRecord(doc),
        depthFromRoot,
        parentSummaryId: parentId,
        path,
        childCount,
      });

      for (let i = 0; i < childLinks.length; i++) {
        const childPath = path ? `${path}.${String(i).padStart(4, "0")}` : String(i).padStart(4, "0");
        queue.push({
          id: childLinks[i].summaryId,
          depthFromRoot: depthFromRoot + 1,
          parentId: id,
          path: childPath,
        });
      }
    }

    return output.sort((a, b) => {
      if (a.depthFromRoot !== b.depthFromRoot) return a.depthFromRoot - b.depthFromRoot;
      return a.path.localeCompare(b.path);
    });
  }

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const docs = await this.contextItems
      .find({ conversationId })
      .sort({ ordinal: 1 })
      .toArray();
    return docs.map((d) => ({
      conversationId: d.conversationId,
      ordinal: d.ordinal,
      itemType: d.itemType as ContextItemType,
      messageId: d.messageId ?? null,
      summaryId: d.summaryId ?? null,
      createdAt: d.createdAt,
    }));
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const maxOrd = options?.maxOrdinalExclusive;
    const match: Record<string, unknown> = { conversationId, itemType: "summary" };
    if (typeof maxOrd === "number" && Number.isFinite(maxOrd)) {
      match.ordinal = { $lt: maxOrd };
    }
    const items = await this.contextItems.find(match).toArray();
    const summaryIds = items.map((i) => i.summaryId).filter(Boolean);
    if (summaryIds.length === 0) return [];
    const summaries = await this.summaries.find({ summaryId: { $in: summaryIds } }).toArray();
    const depths = [...new Set(summaries.map((s) => s.depth))].sort((a, b) => a - b);
    return depths;
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const maxDoc = await this.contextItems.findOne(
      { conversationId },
      { sort: { ordinal: -1 }, projection: { ordinal: 1 } },
    );
    const nextOrdinal = (maxDoc?.ordinal ?? -1) + 1;
    await this.contextItems.insertOne({
      conversationId,
      ordinal: nextOrdinal,
      itemType: "message",
      messageId,
      summaryId: null,
      createdAt: new Date(),
    });
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const maxDoc = await this.contextItems.findOne(
      { conversationId },
      { sort: { ordinal: -1 }, projection: { ordinal: 1 } },
    );
    const baseOrdinal = (maxDoc?.ordinal ?? -1) + 1;
    const docs = messageIds.map((messageId, idx) => ({
      conversationId,
      ordinal: baseOrdinal + idx,
      itemType: "message" as const,
      messageId,
      summaryId: null,
      createdAt: new Date(),
    }));
    await this.contextItems.insertMany(docs);
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const maxDoc = await this.contextItems.findOne(
      { conversationId },
      { sort: { ordinal: -1 }, projection: { ordinal: 1 } },
    );
    const nextOrdinal = (maxDoc?.ordinal ?? -1) + 1;
    await this.contextItems.insertOne({
      conversationId,
      ordinal: nextOrdinal,
      itemType: "summary",
      messageId: null,
      summaryId,
      createdAt: new Date(),
    });
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;
    await this.contextItems.deleteMany({
      conversationId,
      ordinal: { $gte: startOrdinal, $lte: endOrdinal },
    });
    await this.contextItems.insertOne({
      conversationId,
      ordinal: startOrdinal,
      itemType: "summary",
      messageId: null,
      summaryId,
      createdAt: new Date(),
    });
    const items = await this.contextItems
      .find({ conversationId })
      .sort({ ordinal: 1 })
      .toArray();
    await this.contextItems.deleteMany({ conversationId });
    const toInsert = items.map((item, i) => ({
      conversationId,
      ordinal: i,
      itemType: item.itemType,
      messageId: item.messageId,
      summaryId: item.summaryId,
      createdAt: item.createdAt,
    }));
    if (toInsert.length > 0) {
      await this.contextItems.insertMany(toInsert);
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const items = await this.contextItems.find({ conversationId }).toArray();
    let total = 0;
    for (const item of items) {
      if (item.itemType === "message" && item.messageId != null) {
        const msg = await this.messages.findOne({ messageId: item.messageId }, { projection: { tokenCount: 1 } });
        total += msg?.tokenCount ?? 0;
      } else if (item.itemType === "summary" && item.summaryId != null) {
        const sum = await this.summaries.findOne({ summaryId: item.summaryId }, { projection: { tokenCount: 1 } });
        total += sum?.tokenCount ?? 0;
      }
    }
    return total;
  }

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "semantic") {
      return this.searchVectorSummaries(input, limit);
    }
    if (input.mode === "hybrid") {
      const keywordInput = { ...input, mode: "full_text" as const };
      const [keywordResults, vectorResults] = await Promise.all([
        this.searchKeywordOrAtlasSummaries(keywordInput, limit),
        this.searchVectorSummaries(input, limit).catch(() => [] as SummarySearchResult[]),
      ]);
      return mergeWithRRF(keywordResults, vectorResults, limit, "summaryId");
    }

    return this.searchKeywordOrAtlasSummaries(input, limit);
  }

  private async searchKeywordOrAtlasSummaries(
    input: SummarySearchInput,
    limit: number,
  ): Promise<SummarySearchResult[]> {
    if (input.mode === "full_text") {
      const plan = buildLikeSearchPlan("content", input.query);
      if (plan.terms.length > 0) {
        const atlas = await this.searchAtlasSearchSummaries(input, limit).catch(() => null);
        if (atlas != null) return atlas;
      }
    }
    return this.searchKeywordSummaries(input, limit);
  }

  private async searchAtlasSearchSummaries(
    input: SummarySearchInput,
    limit: number,
  ): Promise<SummarySearchResult[]> {
    const filterClauses: Record<string, unknown>[] = [];
    if (input.conversationId != null) {
      filterClauses.push({ equals: { path: "conversationId", value: input.conversationId } });
    }
    if (input.since || input.before) {
      const range: Record<string, Date> = {};
      if (input.since) range.gte = input.since;
      if (input.before) range.lt = input.before;
      filterClauses.push({ range: { path: "createdAt", ...range } });
    }

    const searchClause: Record<string, unknown> = {
      index: this.searchIndexSummaries,
      compound: {
        must: [{ text: { query: input.query, path: "content" } }],
        ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
      },
    };

    const pipeline = [
      { $search: searchClause },
      {
        $project: {
          summaryId: 1,
          conversationId: 1,
          kind: 1,
          content: 1,
          createdAt: 1,
          score: { $meta: "searchScore" },
        },
      },
      { $limit: limit },
    ];

    const docs = await this.summaries.aggregate(pipeline).toArray();
    const plan = buildLikeSearchPlan("content", input.query);
    return docs.map((d) => ({
      summaryId: d.summaryId,
      conversationId: d.conversationId,
      kind: d.kind as SummaryKind,
      snippet: createFallbackSnippet(d.content, plan.terms),
      createdAt: d.createdAt,
      rank: typeof d.score === "number" ? d.score : 0,
    }));
  }

  private async searchKeywordSummaries(
    input: SummarySearchInput,
    limit: number,
  ): Promise<SummarySearchResult[]> {
    const filter: Record<string, unknown> = {};
    if (input.conversationId != null) filter.conversationId = input.conversationId;
    if (input.since || input.before) {
      filter.createdAt = {};
      if (input.since) (filter.createdAt as Record<string, Date>).$gte = input.since;
      if (input.before) (filter.createdAt as Record<string, Date>).$lt = input.before;
    }

    if (input.mode === "full_text") {
      const plan = buildLikeSearchPlan("content", input.query);
      if (plan.terms.length === 0) return [];
      const regex = new RegExp(
        plan.terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "i",
      );
      filter.content = regex;
    } else {
      try {
        filter.content = new RegExp(input.query);
      } catch {
        return [];
      }
    }

    const docs = await this.summaries
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    if (input.mode === "full_text") {
      const plan = buildLikeSearchPlan("content", input.query);
      return docs.map((d) => ({
        summaryId: d.summaryId,
        conversationId: d.conversationId,
        kind: d.kind as SummaryKind,
        snippet: createFallbackSnippet(d.content, plan.terms),
        createdAt: d.createdAt,
        rank: 0,
      }));
    }
    const re = new RegExp(input.query);
    return docs
      .filter((d) => re.exec(d.content))
      .map((d) => {
        const match = re.exec(d.content);
        return {
          summaryId: d.summaryId,
          conversationId: d.conversationId,
          kind: d.kind as SummaryKind,
          snippet: match ? match[0] : d.content.slice(0, 80),
          createdAt: d.createdAt,
          rank: 0,
        };
      })
      .slice(0, limit);
  }

  private async searchVectorSummaries(
    input: SummarySearchInput,
    limit: number,
  ): Promise<SummarySearchResult[]> {
    const filter: Record<string, unknown> = {};
    if (input.conversationId != null) filter.conversationId = input.conversationId;
    if (input.since || input.before) {
      filter.createdAt = {};
      if (input.since) (filter.createdAt as Record<string, Date>).$gte = input.since;
      if (input.before) (filter.createdAt as Record<string, Date>).$lt = input.before;
    }

    const pipeline = [
      {
        $vectorSearch: {
          index: this.vectorSearchIndexSummaries,
          path: "content",
          query: { text: input.query },
          limit,
          numCandidates: Math.min(limit * 20, 10000),
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        },
      },
      {
        $project: {
          summaryId: 1,
          conversationId: 1,
          kind: 1,
          content: 1,
          createdAt: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
      { $limit: limit },
    ];

    const docs = await this.summaries.aggregate(pipeline).toArray();

    return docs.map((d) => ({
      summaryId: d.summaryId,
      conversationId: d.conversationId,
      kind: d.kind as SummaryKind,
      snippet: d.content?.slice(0, 80) ?? "",
      createdAt: d.createdAt,
      rank: typeof d.score === "number" ? d.score : 0,
    }));
  }

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    const now = new Date();
    const doc = {
      fileId: input.fileId,
      conversationId: input.conversationId,
      fileName: input.fileName ?? null,
      mimeType: input.mimeType ?? null,
      byteSize: input.byteSize ?? null,
      storageUri: input.storageUri,
      explorationSummary: input.explorationSummary ?? null,
      createdAt: now,
    };
    await this.largeFiles.insertOne(doc);
    return doc as LargeFileRecord;
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const doc = await this.largeFiles.findOne({ fileId });
    return doc as LargeFileRecord | null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const docs = await this.largeFiles
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .toArray();
    return docs as LargeFileRecord[];
  }
}
