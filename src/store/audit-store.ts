import type { DatabaseSync } from "node:sqlite";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";

export type ConversationId = number;
export type AuditEventId = number;

export type CreateAuditEventInput = {
  sessionId: string;
  conversationId: ConversationId;
  type: string;
  tool: string;
  input?: string | null;
  output?: string | null;
  toolCallId?: string | null;
  isError?: boolean;
};

export type AuditEventRecord = {
  eventId: AuditEventId;
  sessionId: string;
  conversationId: ConversationId;
  type: string;
  tool: string;
  input: string | null;
  output: string | null;
  toolCallId: string | null;
  isError: boolean;
  createdAt: Date;
};

export type AuditSearchInput = {
  query: string;
  mode: "regex" | "full_text";
  conversationId?: ConversationId;
  sessionId?: string;
  tool?: string;
  since?: Date;
  before?: Date;
  limit?: number;
};

export type AuditSearchResult = {
  eventId: AuditEventId;
  conversationId: ConversationId;
  sessionId: string;
  tool: string;
  input: string | null;
  output: string | null;
  isError: boolean;
  snippet: string;
  createdAt: Date;
};

export type AuditEventStore = {
  insertEvent(input: CreateAuditEventInput): Promise<AuditEventRecord>;
  searchEvents(input: AuditSearchInput): Promise<AuditSearchResult[]>;
};

// ── SQLite implementation ────────────────────────────────────────────────────

export class AuditStoreSqlite implements AuditEventStore {
  constructor(private db: DatabaseSync) {}

  insertEvent(input: CreateAuditEventInput): Promise<AuditEventRecord> {
    const stmt = this.db.prepare(`
      INSERT INTO audit_events (session_id, conversation_id, type, tool, input, output, tool_call_id, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.sessionId,
      input.conversationId,
      input.type ?? "tool_call",
      input.tool,
      input.input ?? null,
      input.output ?? null,
      input.toolCallId ?? null,
      input.isError === true ? 1 : 0,
    );
    const eventId = result.lastInsertRowid as number;
    const row = this.db.prepare("SELECT * FROM audit_events WHERE event_id = ?").get(eventId) as {
      event_id: number;
      session_id: string;
      conversation_id: number;
      type: string;
      tool: string;
      input: string | null;
      output: string | null;
      tool_call_id: string | null;
      is_error: number;
      created_at: string;
    };
    return Promise.resolve({
      eventId: row.event_id,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      type: row.type,
      tool: row.tool,
      input: row.input,
      output: row.output,
      toolCallId: row.tool_call_id,
      isError: row.is_error !== 0,
      createdAt: new Date(row.created_at),
    });
  }

  searchEvents(input: AuditSearchInput): Promise<AuditSearchResult[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (input.conversationId != null) {
      conditions.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (input.sessionId != null && input.sessionId.trim()) {
      conditions.push("session_id = ?");
      args.push(input.sessionId.trim());
    }
    if (input.tool != null && input.tool.trim()) {
      conditions.push("tool = ?");
      args.push(input.tool.trim());
    }
    if (input.since) {
      conditions.push("created_at >= ?");
      args.push(input.since.toISOString());
    }
    if (input.before) {
      conditions.push("created_at < ?");
      args.push(input.before.toISOString());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const baseQuery = `SELECT event_id, conversation_id, session_id, tool, input, output, is_error, created_at FROM audit_events ${whereClause}`;

    const query = input.query?.trim();
    if (!query) {
      const stmt = this.db.prepare(
        `${baseQuery} ORDER BY created_at DESC LIMIT ?`,
      );
      const rows = stmt.all(...args, limit) as Array<{
        event_id: number;
        conversation_id: number;
        session_id: string;
        tool: string;
        input: string | null;
        output: string | null;
        is_error: number;
        created_at: string;
      }>;
      return Promise.resolve(rows.map((r) => toSearchResult(r)));
    }

    const plan = buildLikeSearchPlan("COALESCE(input, '') || ' ' || COALESCE(output, '')", query);
    if (plan.terms.length === 0) {
      return Promise.resolve([]);
    }
    const likeConditions = plan.terms
      .map((_, i) => `(LOWER(COALESCE(input, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(output, '')) LIKE ? ESCAPE '\\')`)
      .join(" AND ");
    const likeArgs = plan.args.flatMap((a) => [a, a]);
    const fullWhere = conditions.length > 0
      ? `WHERE (${conditions.join(" AND ")}) AND (${likeConditions})`
      : `WHERE ${likeConditions}`;
    const stmt = this.db.prepare(
      `SELECT event_id, conversation_id, session_id, tool, input, output, is_error, created_at FROM audit_events ${fullWhere} ORDER BY created_at DESC LIMIT ?`,
    );
    const rows = stmt.all(...args, ...likeArgs, limit) as Array<{
      event_id: number;
      conversation_id: number;
      session_id: string;
      tool: string;
      input: string | null;
      output: string | null;
      is_error: number;
      created_at: string;
    }>;
    return Promise.resolve(
      rows.map((r) => {
        const searchable = `${r.input ?? ""} ${r.output ?? ""}`.trim();
        const snippet = createFallbackSnippet(searchable, plan.terms);
        return toSearchResult(r, snippet);
      }),
    );
  }
}

function toSearchResult(
  row: {
    event_id: number;
    conversation_id: number;
    session_id: string;
    tool: string;
    input: string | null;
    output: string | null;
    is_error: number;
    created_at: string;
  },
  snippet?: string,
): AuditSearchResult {
  const searchable = `${row.input ?? ""} ${row.output ?? ""}`.trim();
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    tool: row.tool,
    input: row.input,
    output: row.output,
    isError: row.is_error !== 0,
    snippet: snippet ?? (searchable.slice(0, 200) || "(no content)"),
    createdAt: new Date(row.created_at),
  };
}
