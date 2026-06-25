import { CURRENT_RUN_SCHEMA_VERSION, getRunSchemaVersion } from "../schema/run-record.js";

export const CURRENT_TRACE_SCHEMA_VERSION = CURRENT_RUN_SCHEMA_VERSION;
export { CURRENT_RUN_SCHEMA_VERSION, getRunSchemaVersion };

export function getTraceSchemaVersion(run: { schemaVersion?: number; version?: number }): number {
  return getRunSchemaVersion(run);
}
