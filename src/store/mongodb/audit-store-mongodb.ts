import type { Collection, Db } from "mongodb";
import { buildLikeSearchPlan, createFallbackSnippet } from "../full-text-fallback.js";
import type {
  AuditEventRecord,
  AuditSearchInput,
  AuditSearchResult,
  CreateAuditEventInput,
} from "../audit-store.js";

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

export class AuditStoreMongoDB {
  private collection: Collection;
  private counters: Collection;

  constructor(db: Db) {
    this.collection = db.collection("audit_events");
    this.counters = db.collection("counters");
  }

  async insertEvent(input: CreateAuditEventInput): Promise<AuditEventRecord> {
    const eventId = await getNextId(this.counters, "audit_event_id");
    const now = new Date();
    const doc = {
      eventId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      type: input.type ?? "tool_call",
      tool: input.tool,
      input: input.input ?? null,
      output: input.output ?? null,
      toolCallId: input.toolCallId ?? null,
      isError: input.isError === true,
      ts: now,
      createdAt: now,
    };
    await this.collection.insertOne(doc);
    return {
      eventId,
      sessionId: doc.sessionId,
      conversationId: doc.conversationId,
      type: doc.type,
      tool: doc.tool,
      input: doc.input,
      output: doc.output,
      toolCallId: doc.toolCallId,
      isError: doc.isError,
      createdAt: now,
    };
  }

  async searchEvents(input: AuditSearchInput): Promise<AuditSearchResult[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const filter: Record<string, unknown> = {};

    if (input.conversationId != null) {
      filter.conversationId = input.conversationId;
    }
    if (input.sessionId != null && input.sessionId.trim()) {
      filter.sessionId = input.sessionId.trim();
    }
    if (input.tool != null && input.tool.trim()) {
      filter.tool = input.tool.trim();
    }
    if (input.since || input.before) {
      const tsFilter: Record<string, Date> = {};
      if (input.since) tsFilter.$gte = input.since;
      if (input.before) tsFilter.$lt = input.before;
      filter.ts = tsFilter;
    }

    const query = input.query?.trim();
    if (query) {
      const plan = buildLikeSearchPlan("content", query);
      if (plan.terms.length > 0) {
        const regexPattern = plan.terms
          .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        const regex = new RegExp(regexPattern, "i");
        filter.$or = [
          { input: regex },
          { output: regex },
        ];
      }
    }

    const cursor = this.collection
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit);
    const docs = await cursor.toArray();

    const plan = query ? buildLikeSearchPlan("content", query) : null;
    return docs.map((d) => {
      const inputStr = (d.input as string) ?? "";
      const outputStr = (d.output as string) ?? "";
      const searchable = `${inputStr} ${outputStr}`.trim();
      const snippet = plan && plan.terms.length > 0
        ? createFallbackSnippet(searchable, plan.terms)
        : searchable.slice(0, 200) || "(no content)";
      const eventId = (d.eventId as number) ?? 0;
      const ts = d.ts ?? d.createdAt;
      return {
        eventId,
        conversationId: d.conversationId as number,
        sessionId: (d.sessionId as string) ?? "",
        tool: (d.tool as string) ?? "unknown",
        input: (d.input as string) ?? null,
        output: (d.output as string) ?? null,
        isError: (d.isError as boolean) ?? false,
        snippet,
        createdAt: ts ? new Date(ts as Date) : new Date(),
      };
    });
  }
}
