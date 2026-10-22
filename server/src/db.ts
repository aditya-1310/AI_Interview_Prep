// Single mongoose connection shared by the app and the integration tests.
import mongoose from 'mongoose';
import { config } from './config';

export interface ConnectOptions {
  serverSelectionTimeoutMS?: number;
  connectTimeoutMS?: number;
}

/** Swap the database name in a Mongo URI, keeping credentials and options. */
export function withDatabaseName(uri: string, name: string): string {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;
  const prefix = uri.slice(0, schemeEnd + 3);
  const rest = uri.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  if (slash === -1) return `${prefix}${rest}/${name}`;
  const head = `${prefix}${rest.slice(0, slash)}`;
  let tail = rest.slice(slash + 1);
  const queryAt = tail.indexOf('?');
  const query = queryAt >= 0 ? tail.slice(queryAt) : '';
  if (queryAt >= 0) tail = tail.slice(0, queryAt);
  // Whatever db name was there (possibly empty = default db) is replaced.
  return `${head}/${name}${query}`;
}

export async function connectDb(
  uri: string = config.mongoUri,
  opts: ConnectOptions = {},
): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 8_000,
    connectTimeoutMS: opts.connectTimeoutMS ?? 10_000,
    socketTimeoutMS: 30_000,
    maxPoolSize: 10,
  });
}

export async function closeDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
}
