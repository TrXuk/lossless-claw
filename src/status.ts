import type { LcmConfig } from "./db/config.js";

export type LcmStatusContext = {
  config: LcmConfig;
  backend: "sqlite" | "mongodb";
  fts5Available?: boolean;
};

/**
 * Build a human-readable status message for the lossless-claw plugin.
 * Used when reporting plugin status to OpenClaw's logger.
 */
export function buildLcmStatusMessage(ctx: LcmStatusContext): string {
  const { config, backend } = ctx;
  const parts: string[] = [];

  parts.push(`enabled=${config.enabled}`);
  parts.push(`backend=${backend}`);

  if (backend === "sqlite") {
    parts.push(`db=${config.databasePath}`);
    const fts5 = ctx.fts5Available;
    parts.push(
      `search=full_text${fts5 === true ? " (FTS5)" : fts5 === false ? " (LIKE)" : ""}`,
    );
    parts.push("hybrid/semantic→full_text");
  } else {
    parts.push(`db=${config.mongodbDatabase}`);
    parts.push("search=full_text (Atlas), hybrid (Atlas+Vector), semantic (Vector)");
    parts.push(`atlasIndexes=${config.autoCreateAtlasIndexes ? "auto-create" : "manual"}`);
  }

  parts.push(`threshold=${config.contextThreshold}`);
  return `[lossless-claw] Plugin loaded: ${parts.join(", ")}`;
}
