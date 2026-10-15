import { getSql } from './client.js'
import type { DataStore } from './port.js'
import { PostgresStore } from './postgres.js'

export function getStore(connectionString: string): Promise<DataStore> {
  return Promise.resolve(new PostgresStore(getSql(connectionString)))
}
