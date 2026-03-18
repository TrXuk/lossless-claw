/**
 * Extract tool call/result pairs from agent messages for episodic audit logging.
 */

type AgentMessageLike = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolUseId?: string;
  toolName?: string;
  command?: string;
  output?: string;
};

const TOOL_CALL_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
]);

function extractToolCallId(block: { id?: unknown; call_id?: unknown }): string | null {
  if (typeof block.id === "string" && block.id) return block.id;
  if (typeof block.call_id === "string" && block.call_id) return block.call_id;
  return null;
}

function toJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type ExtractedAuditEvent = {
  toolCallId: string;
  tool: string;
  input: string | null;
  output: string | null;
  isError: boolean;
};

/**
 * Extract tool call/result pairs from a batch of messages.
 * Pairs assistant tool_call blocks with following toolResult messages by toolCallId.
 * Message order is typically: assistant (tool calls) -> toolResult -> toolResult -> ...
 */
export function extractToolEventsFromMessages(
  messages: AgentMessageLike[],
): ExtractedAuditEvent[] {
  const results: ExtractedAuditEvent[] = [];
  const pendingToolCalls: Array<{ id: string; tool: string; input: string | null }> = [];

  for (const msg of messages) {
    if ("command" in msg && "output" in msg && (!("content" in msg) || !Array.isArray((msg as { content?: unknown }).content) || (msg as { content: unknown[] }).content.length === 0)) {
      const cmd = (msg as { command?: string }).command ?? "";
      const out = (msg as { output?: string }).output ?? "";
      results.push({
        toolCallId: `bash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        tool: "bash",
        input: cmd,
        output: out,
        isError: false,
      });
      continue;
    }

    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const rec = block as {
          type?: string;
          id?: unknown;
          call_id?: unknown;
          name?: string;
          arguments?: unknown;
          input?: unknown;
        };
        const id = extractToolCallId(rec);
        if (!id || !rec.type || !TOOL_CALL_TYPES.has(rec.type)) continue;

        const tool = rec.name ?? (msg as { toolName?: string }).toolName ?? "unknown";
        const input =
          rec.arguments !== undefined
            ? toJson(rec.arguments)
            : rec.input !== undefined
              ? toJson(rec.input)
              : null;
        pendingToolCalls.push({ id, tool, input });
      }
      continue;
    }

    if (role === "toolResult" || role === "tool") {
      const callId =
        (typeof msg.toolCallId === "string" && msg.toolCallId) ||
        (typeof (msg as { toolUseId?: string }).toolUseId === "string" &&
          (msg as { toolUseId: string }).toolUseId);
      if (!callId) continue;

      const idx = pendingToolCalls.findIndex((p) => p.id === callId);
      if (idx === -1) continue;

      const pending = pendingToolCalls.splice(idx, 1)[0];
      let output = "";
      let isError = !!(msg as { isError?: boolean }).isError;
      if (typeof (msg as { output?: string }).output === "string") {
        output = (msg as { output: string }).output;
      } else if (typeof msg.content === "string") {
        output = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const b = block as { type?: string; text?: string };
            if (b.type === "text" && typeof b.text === "string") {
              output = b.text;
              break;
            }
          }
        }
      }

      results.push({
        toolCallId: callId,
        tool: pending.tool,
        input: pending.input,
        output,
        isError,
      });
    }
  }

  return results;
}
