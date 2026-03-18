import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { VoyageAtlasEmbeddingService } from "../../embeddings/voyage-atlas.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "../full-text-fallback.js";
import { mergeWithRRF } from "./search-utils.js";
import type {
  ConversationId,
  ConversationRecord,
  CreateConversationInput,
  CreateMessageInput,
  CreateMessagePartInput,
  MessageId,
  MessagePartRecord,
  MessageRecord,
  MessageRole,
  MessageSearchInput,
  MessageSearchResult,
} from "../conversation-store.js";

async function getNextId(collection: Collection, name: string): Promise<number> {
  const result = await collection.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const value = result?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Failed to get next ${name} from counters`);
  }
  return value;
}

export class ConversationStoreMongoDB {
  private conversations: Collection;
  private messages: Collection;
  private messageParts: Collection;
  private counters: Collection;
  private summaryMessages: Collection;
  private contextItems: Collection;
  private readonly fts5Available: boolean;
  private readonly searchIndexMessages: string;
  private readonly vectorSearchIndexMessages: string;
  private readonly embeddingService?: VoyageAtlasEmbeddingService;
  private readonly embeddingMode: "auto" | "manual";
  private readonly vectorSearchSummariesOnly: boolean;

  constructor(
    db: Db,
    options?: {
      fts5Available?: boolean;
      searchIndexMessages?: string;
      searchIndexSummaries?: string;
      vectorSearchIndexMessages?: string;
      vectorSearchIndexSummaries?: string;
      embeddingService?: VoyageAtlasEmbeddingService;
      embeddingMode?: "auto" | "manual";
      vectorSearchSummariesOnly?: boolean;
    },
  ) {
    this.conversations = db.collection("conversations");
    this.messages = db.collection("messages");
    this.messageParts = db.collection("message_parts");
    this.counters = db.collection("counters");
    this.summaryMessages = db.collection("summary_messages");
    this.contextItems = db.collection("context_items");
    this.fts5Available = options?.fts5Available ?? true;
    this.searchIndexMessages = options?.searchIndexMessages ?? "lcm_messages_search";
    this.vectorSearchIndexMessages = options?.vectorSearchIndexMessages ?? "lcm_messages_vector";
    this.embeddingService = options?.embeddingService;
    this.embeddingMode = options?.embeddingMode ?? "auto";
    this.vectorSearchSummariesOnly = options?.vectorSearchSummariesOnly ?? false;
  }

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    const client = this.conversations.db.client;
    const session = client.startSession();
    let result: T;
    try {
      await session.withTransaction(async () => {
        result = await operation();
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const conversationId = await getNextId(this.counters, "conversation_id");
    const now = new Date();
    const doc = {
      conversationId,
      sessionId: input.sessionId,
      title: input.title ?? null,
      bootstrappedAt: null as Date | null,
      createdAt: now,
      updatedAt: now,
    };
    await this.conversations.insertOne(doc);
    return {
      conversationId,
      sessionId: doc.sessionId,
      title: doc.title,
      bootstrappedAt: doc.bootstrappedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const doc = await this.conversations.findOne({ conversationId });
    return doc ? this.toConversationRecord(doc) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const doc = await this.conversations.findOne(
      { sessionId },
      { sort: { createdAt: -1 } },
    );
    return doc ? this.toConversationRecord(doc) : null;
  }

  async getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord> {
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) return existing;
    return this.createConversation({ sessionId, title });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    const conv = await this.conversations.findOne({ conversationId });
    const bootstrappedAt = conv?.bootstrappedAt ?? new Date();
    const now = new Date();
    await this.conversations.updateOne(
      { conversationId },
      { $set: { bootstrappedAt, updatedAt: now } },
    );
  }

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const messageId = await getNextId(this.counters, "message_id");
    const now = new Date();
    const doc: Record<string, unknown> = {
      messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      role: input.role,
      content: input.content,
      tokenCount: input.tokenCount,
      createdAt: now,
    };
    if (
      this.embeddingService &&
      !this.vectorSearchSummariesOnly &&
      input.content?.trim()
    ) {
      try {
        doc.content_embedding = await this.embeddingService.embedText(input.content);
      } catch (err) {
        console.warn("[lossless-claw] Failed to embed message, inserting without embedding:", err);
      }
    }
    await this.messages.insertOne(doc);
    return this.toMessageRecord(doc);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) return [];
    const records: MessageRecord[] = [];
    for (const input of inputs) {
      records.push(await this.createMessage(input));
    }
    return records;
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const filter: Record<string, unknown> = { conversationId, seq: { $gt: afterSeq } };
    const cursor = this.messages
      .find(filter)
      .sort({ seq: 1 })
      .limit(opts?.limit ?? 0);
    const docs = await cursor.toArray();
    return docs.map((d) => this.toMessageRecord(d));
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const doc = await this.messages.findOne(
      { conversationId },
      { sort: { seq: -1 } },
    );
    return doc ? this.toMessageRecord(doc) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const doc = await this.messages.findOne({ conversationId, role, content });
    return !!doc;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    return this.messages.countDocuments({ conversationId, role, content });
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const doc = await this.messages.findOne({ messageId });
    return doc ? this.toMessageRecord(doc) : null;
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) return;
    const docs = parts.map((part) => ({
      partId: randomUUID(),
      messageId,
      sessionId: part.sessionId,
      partType: part.partType,
      ordinal: part.ordinal,
      textContent: part.textContent ?? null,
      toolCallId: part.toolCallId ?? null,
      toolName: part.toolName ?? null,
      toolInput: part.toolInput ?? null,
      toolOutput: part.toolOutput ?? null,
      metadata: part.metadata ?? null,
    }));
    await this.messageParts.insertMany(docs);
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const docs = await this.messageParts
      .find({ messageId })
      .sort({ ordinal: 1 })
      .toArray();
    return docs.map((d) => ({
      partId: d.partId,
      messageId: d.messageId,
      sessionId: d.sessionId,
      partType: d.partType,
      ordinal: d.ordinal,
      textContent: d.textContent ?? null,
      toolCallId: d.toolCallId ?? null,
      toolName: d.toolName ?? null,
      toolInput: d.toolInput ?? null,
      toolOutput: d.toolOutput ?? null,
      metadata: d.metadata ?? null,
    }));
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    return this.messages.countDocuments({ conversationId });
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const doc = await this.messages.findOne(
      { conversationId },
      { sort: { seq: -1 }, projection: { seq: 1 } },
    );
    return doc?.seq ?? 0;
  }

  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    let deleted = 0;
    for (const messageId of messageIds) {
      const ref = await this.summaryMessages.findOne({ messageId });
      if (ref) continue;
      await this.contextItems.deleteMany({ itemType: "message", messageId });
      const result = await this.messages.deleteOne({ messageId });
      if (result.deletedCount) {
        await this.messageParts.deleteMany({ messageId });
        deleted++;
      }
    }
    return deleted;
  }

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

    if (this.vectorSearchSummariesOnly) {
      const keywordInput = { ...input, mode: "full_text" as const };
      return this.searchKeywordOrAtlasMessages(keywordInput, limit);
    }
    if (input.mode === "semantic") {
      return this.searchVectorMessages(input, limit);
    }
    if (input.mode === "hybrid") {
      const keywordInput = { ...input, mode: "full_text" as const };
      const [keywordResults, vectorResults] = await Promise.all([
        this.searchKeywordOrAtlasMessages(keywordInput, limit),
        this.searchVectorMessages(input, limit).catch(() => [] as MessageSearchResult[]),
      ]);
      return mergeWithRRF(keywordResults, vectorResults, limit, "messageId");
    }

    return this.searchKeywordOrAtlasMessages(input, limit);
  }

  private async searchKeywordOrAtlasMessages(
    input: MessageSearchInput,
    limit: number,
  ): Promise<MessageSearchResult[]> {
    if (input.mode === "full_text") {
      const plan = buildLikeSearchPlan("content", input.query);
      if (plan.terms.length > 0) {
        const atlas = await this.searchAtlasSearchMessages(input, limit).catch(() => null);
        if (atlas != null) return atlas;
      }
    }
    return this.searchKeywordMessages(input, limit);
  }

  private async searchAtlasSearchMessages(
    input: MessageSearchInput,
    limit: number,
  ): Promise<MessageSearchResult[]> {
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
      index: this.searchIndexMessages,
      compound: {
        must: [{ text: { query: input.query, path: "content" } }],
        ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
      },
    };

    const pipeline = [
      { $search: searchClause },
      {
        $project: {
          messageId: 1,
          conversationId: 1,
          role: 1,
          content: 1,
          createdAt: 1,
          score: { $meta: "searchScore" },
        },
      },
      { $limit: limit },
    ];

    const docs = await this.messages.aggregate(pipeline).toArray();
    const plan = buildLikeSearchPlan("content", input.query);
    return docs.map((d) => ({
      messageId: d.messageId,
      conversationId: d.conversationId,
      role: d.role as MessageRole,
      snippet: createFallbackSnippet(d.content, plan.terms),
      createdAt: d.createdAt,
      rank: typeof d.score === "number" ? d.score : 0,
    }));
  }

  private async searchKeywordMessages(
    input: MessageSearchInput,
    limit: number,
  ): Promise<MessageSearchResult[]> {
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

    const docs = await this.messages
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    if (input.mode === "full_text") {
      const plan = buildLikeSearchPlan("content", input.query);
      return docs.map((d) => ({
        messageId: d.messageId,
        conversationId: d.conversationId,
        role: d.role as MessageRole,
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
          messageId: d.messageId,
          conversationId: d.conversationId,
          role: d.role as MessageRole,
          snippet: match ? match[0] : d.content.slice(0, 80),
          createdAt: d.createdAt,
          rank: 0,
        };
      })
      .slice(0, limit);
  }

  private async searchVectorMessages(
    input: MessageSearchInput,
    limit: number,
  ): Promise<MessageSearchResult[]> {
    const filter: Record<string, unknown> = {};
    if (input.conversationId != null) filter.conversationId = input.conversationId;
    if (input.since || input.before) {
      filter.createdAt = {};
      if (input.since) (filter.createdAt as Record<string, Date>).$gte = input.since;
      if (input.before) (filter.createdAt as Record<string, Date>).$lt = input.before;
    }

    let vectorSearchClause: Record<string, unknown>;
    if (this.embeddingMode === "manual" && this.embeddingService) {
      const queryVector = await this.embeddingService.embedText(input.query);
      if (queryVector.length === 0) return [];
      vectorSearchClause = {
        index: this.vectorSearchIndexMessages,
        path: "content_embedding",
        queryVector,
        limit,
        numCandidates: Math.min(limit * 20, 10000),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      };
    } else {
      vectorSearchClause = {
        index: this.vectorSearchIndexMessages,
        path: "content",
        query: { text: input.query },
        limit,
        numCandidates: Math.min(limit * 20, 10000),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      };
    }

    const pipeline = [
      {
        $vectorSearch: vectorSearchClause,
      },
      {
        $project: {
          messageId: 1,
          conversationId: 1,
          role: 1,
          content: 1,
          createdAt: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
      { $limit: limit },
    ];

    const docs = await this.messages.aggregate(pipeline).toArray();

    return docs.map((d) => ({
      messageId: d.messageId,
      conversationId: d.conversationId,
      role: d.role as MessageRole,
      snippet: d.content?.slice(0, 80) ?? "",
      createdAt: d.createdAt,
      rank: typeof d.score === "number" ? d.score : 0,
    }));
  }

  private toConversationRecord(doc: { conversationId: number; sessionId: string; title: string | null; bootstrappedAt: Date | null; createdAt: Date; updatedAt: Date }): ConversationRecord {
    return {
      conversationId: doc.conversationId,
      sessionId: doc.sessionId,
      title: doc.title,
      bootstrappedAt: doc.bootstrappedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private toMessageRecord(doc: { messageId: number; conversationId: number; seq: number; role: string; content: string; tokenCount: number; createdAt: Date }): MessageRecord {
    return {
      messageId: doc.messageId,
      conversationId: doc.conversationId,
      seq: doc.seq,
      role: doc.role as MessageRole,
      content: doc.content,
      tokenCount: doc.tokenCount,
      createdAt: doc.createdAt,
    };
  }
}
