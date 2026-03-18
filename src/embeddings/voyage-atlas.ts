/**
 * Atlas Model API client for Voyage AI embeddings.
 * Uses https://ai.mongodb.com/v1/embeddings with Atlas Model API key.
 * See https://www.mongodb.com/docs/voyageai/management/api-keys/
 */

const ATLAS_EMBEDDINGS_URL = "https://ai.mongodb.com/v1/embeddings";

/** Default dimensions per model when not specified via output_dimension */
const MODEL_DIMENSIONS: Record<string, number> = {
  "voyage-3-large": 1024,
  "voyage-3.5": 1024,
  "voyage-4": 1024,
  "voyage-4-large": 1024,
  "voyage-4-lite": 1024,
  "voyage-4-nano": 1024,
  "voyage-code-3": 1024,
  "voyage-code-2": 1024,
  "voyage-finance-2": 1024,
  "voyage-law-2": 1024,
};

export function getModelDimensions(model: string): number {
  return MODEL_DIMENSIONS[model] ?? 1024;
}

export type VoyageAtlasEmbeddingOptions = {
  apiKey: string;
  model?: string;
  /** Max retries on rate limit or transient errors */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff */
  baseDelayMs?: number;
};

export type VoyageAtlasEmbeddingService = {
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<number[][]>;
  getModelDimensions(): number;
};

export function createVoyageAtlasEmbeddingService(
  options: VoyageAtlasEmbeddingOptions,
): VoyageAtlasEmbeddingService {
  const { apiKey, model = "voyage-3-large", maxRetries = 3, baseDelayMs = 1000 } = options;

  const dims = getModelDimensions(model);

  async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function callEmbeddingApi(input: string[]): Promise<number[][]> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(ATLAS_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ input, model }),
        });

        if (!res.ok) {
          const body = await res.text();
          const msg = `Atlas embeddings API error ${res.status}: ${body}`;
          if (res.status === 429 || res.status >= 500) {
            lastError = new Error(msg);
            if (attempt < maxRetries) {
              const delay = baseDelayMs * Math.pow(2, attempt);
              await sleep(delay);
              continue;
            }
          }
          throw new Error(msg);
        }

        const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        const embeddings = data.data ?? [];
        return embeddings.map((d) => d.embedding ?? []);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error("Embedding request failed");
  }

  return {
    async embedText(text: string): Promise<number[]> {
      if (!text?.trim()) return [];
      const results = await callEmbeddingApi([text]);
      return results[0] ?? [];
    },

    async embedTexts(texts: string[]): Promise<number[][]> {
      const nonEmpty = texts.filter((t) => t?.trim());
      if (nonEmpty.length === 0) return texts.map(() => []);
      const results = await callEmbeddingApi(nonEmpty);
      const out: number[][] = [];
      let j = 0;
      for (const t of texts) {
        if (t?.trim()) {
          out.push(results[j] ?? []);
          j++;
        } else {
          out.push([]);
        }
      }
      return out;
    },

    getModelDimensions(): number {
      return dims;
    },
  };
}
