import { MongoClient, type Db } from "mongodb";

type ConnectionEntry = {
  client: MongoClient;
  db: Db;
  refs: number;
};

const _connections = new Map<string, ConnectionEntry>();

export async function getMongoDb(
  uri: string,
  database: string,
): Promise<{ client: MongoClient; db: Db }> {
  const key = `${uri}::${database}`;
  const existing = _connections.get(key);
  if (existing) {
    existing.refs += 1;
    return { client: existing.client, db: existing.db };
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(database);
  _connections.set(key, { client, db, refs: 1 });
  return { client, db };
}

export async function closeMongoDb(uri?: string, database?: string): Promise<void> {
  if (typeof uri === "string" && uri.trim() && typeof database === "string" && database.trim()) {
    const key = `${uri}::${database}`;
    const entry = _connections.get(key);
    if (!entry) {
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      await entry.client.close();
      _connections.delete(key);
    }
    return;
  }

  for (const entry of _connections.values()) {
    await entry.client.close();
  }
  _connections.clear();
}
