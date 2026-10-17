import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Guard } from "typebox/guard";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchCatalogSession,
  type ToolSearchConfig,
  type ToolSearchRequest,
} from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

const TOOL_SEARCH_SELECTOR_KEYS = ["id", "toolId", "name"] as const;

/** Wrapper keys an agent may nest real tool arguments under. */
const TOOL_SEARCH_WRAPPER_KEYS = ["args", "input"] as const;

/**
 * Maximum envelope levels unwrapped before refusing to guess. Each level is one
 * `args`/`input` wrapper, so `{id, args:{args:{payload}}}` (the form live models
 * actually emit) is exactly at the cap and three or more levels is a malformed
 * call that fails loudly instead of silently reaching the target tool with the
 * payload still buried. See data/build-checklists/79306758-f47d-4308-bcb2-7de7c1eaa4c1.json.
 */
const MAX_TOOL_SEARCH_ENVELOPE_DEPTH = 2;

type EnvelopeLevel = { key: string; record: Record<string, unknown> };

/**
 * A wrapper only counts as an envelope when it is a non-empty record. The
 * empty-wrapper special case is deliberate: some local models emit an empty
 * `args`/`input` while flattening the real arguments to the top level, so an
 * empty wrapper means "absent", never "unwrap me".
 */
function readEnvelopeLevel(value: Record<string, unknown>): EnvelopeLevel | undefined {
  for (const key of TOOL_SEARCH_WRAPPER_KEYS) {
    const nested = value[key];
    if (isRecord(nested) && Object.keys(nested).length > 0) {
      return { key, record: nested };
    }
  }
  return undefined;
}

/**
 * Unwrap repeated `args`/`input` envelopes, tracking the dotted path of each
 * level so a too-deep call is reported honestly. The error names the depth and
 * where the next wrapper was found, because "missing property" errors about a
 * payload the caller did send are what drive retry storms against the same shape.
 */
function unwrapToolSearchEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  let input = value;
  const path: string[] = [];
  for (;;) {
    const next = readEnvelopeLevel(input);
    if (!next) {
      return input;
    }
    if (path.length >= MAX_TOOL_SEARCH_ENVELOPE_DEPTH) {
      throw new ToolInputError(
        `Envelope nests deeper than the supported maximum of ${MAX_TOOL_SEARCH_ENVELOPE_DEPTH} levels: the next wrapper is found at ${[...path, next.key].join(".")} (depth ${path.length + 1}). Send the tool arguments once, directly under args.`,
      );
    }
    path.push(next.key);
    input = next.record;
  }
}

function readToolSearchSelector(params: Record<string, unknown>): string | undefined {
  const value = params.id ?? params.toolId ?? params.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readToolSearchId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = readToolSearchSelector(params);
  if (value === undefined) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

export function readToolSearchCallArgs(
  args: unknown,
  catalog?: ToolSearchCatalogSession,
): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const dottedInput = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key.startsWith("args.") && key.length > 5)
      .map(([key, value]) => [key.slice(5), value]),
  );
  const nestedInput = params.args ?? params.input;
  // Some local models emit an empty args/input wrapper while flattening the real
  // arguments to the top level. Treat an empty wrapper as absent so the fallback
  // below preserves those parameters instead of returning {}.
  const nestedInputIsEmpty = isRecord(nestedInput) && Object.keys(nestedInput).length === 0;
  if (nestedInput != null && !nestedInputIsEmpty) {
    // Depth-aware: a doubly (or triply) wrapped call must land the real payload at
    // the top level, otherwise the target tool reports a missing property the caller
    // did send and the caller retries the same shape forever.
    const merged = { ...dottedInput, ...unwrapToolSearchEnvelope(params) };
    return {
      id: readToolSearchId(params),
      input: isRecord(nestedInput) ? merged : nestedInput,
    };
  }

  const matchingSelectors = catalog
    ? TOOL_SEARCH_SELECTOR_KEYS.flatMap((key) => {
        const value = params[key];
        if (typeof value !== "string") {
          return [];
        }
        const matches = catalog.entries.filter(
          (entry) => entry.id === value || entry.name === value,
        );
        return matches.length > 0 ? [{ key, matches }] : [];
      })
    : [];
  const matchedToolIds = new Set(
    matchingSelectors.flatMap(({ matches }) => matches.map((entry) => entry.id)),
  );
  if (matchedToolIds.size > 1) {
    throw new ToolInputError(
      "Ambiguous tool selectors: pass the target tool id and nest target arguments under args.",
    );
  }
  const matchingSelector = matchingSelectors[0]?.key;
  const selector = matchingSelector ?? TOOL_SEARCH_SELECTOR_KEYS.find((key) => params[key] != null);
  const id = readToolSearchId(selector ? { [selector]: params[selector] } : params);

  // Remove every alias that actually identifies the selected catalog tool;
  // unmatched id/name fields can still be required arguments of that tool.
  // A selector is only routing metadata once a catalog match confirmed it —
  // stripping an unmatched key would silently delete a payload `id` (a card
  // UUID, for example) and leave the target tool missing its required property.
  const wrapperKeys = new Set<string>([
    "args",
    "input",
    ...matchingSelectors.map(({ key }) => key),
  ]);
  const targetInputEntries = Object.entries(params).filter(([key]) => !wrapperKeys.has(key));
  const flattenedInput = Object.fromEntries(
    targetInputEntries.filter(([key]) => !(key.startsWith("args.") && key.length > 5)),
  );
  return { id, input: { ...dottedInput, ...flattenedInput } };
}

export function prepareToolSearchDispatcherArguments(args: unknown): unknown {
  if (!isRecord(args) || TOOL_SEARCH_SELECTOR_KEYS.some((key) => Object.hasOwn(args, key))) {
    return args;
  }
  const nestedInput = args.args ?? args.input;
  if (!isRecord(nestedInput)) {
    return args;
  }
  const selectorValue = readToolSearchSelector(nestedInput);
  if (selectorValue === undefined) {
    return args;
  }
  const { args: _wrappedArgs, input: _wrappedInput, ...outerRest } = args;
  return { ...outerRest, ...nestedInput, id: selectorValue };
}

export function readToolSearchLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readBatchToolSearchQuery(value: unknown, field: string, maxGraphemes?: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${field} must be a non-empty string.`);
  }
  const query = value.trim();
  if (maxGraphemes !== undefined && !Guard.IsMaxLength(query, maxGraphemes)) {
    throw new ToolInputError(`${field} must not exceed ${maxGraphemes} characters.`);
  }
  return query;
}

function readToolSearchArgs(
  params: Record<string, unknown>,
  config: ToolSearchConfig,
): { query: string; limit: number } {
  const query = params.query;
  if (typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const options = isRecord(params.options) ? params.options : undefined;
  return {
    query,
    limit: readToolSearchLimit(params.limit ?? options?.limit, config),
  };
}

type BatchToolSearchEntry = { query: string; limit: number };

function readBatchToolSearchEntry(
  value: unknown,
  index: number,
  config: ToolSearchConfig,
): BatchToolSearchEntry {
  if (!isRecord(value)) {
    throw new ToolInputError(`queries[${index}] must be an object.`);
  }
  const query = readBatchToolSearchQuery(
    value.query,
    `queries[${index}].query`,
    MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  );
  try {
    return { query, limit: readToolSearchLimit(value.limit, config) };
  } catch (error) {
    if (error instanceof ToolInputError) {
      throw new ToolInputError(`queries[${index}].${error.message}`);
    }
    throw error;
  }
}

function readBatchToolSearchRequest(
  searches: BatchToolSearchEntry[],
  config: ToolSearchConfig,
): ToolSearchRequest {
  if (searches.length > MAX_TOOL_SEARCH_BATCH_QUERIES) {
    throw new ToolInputError(
      `queries may contain at most ${MAX_TOOL_SEARCH_BATCH_QUERIES} entries.`,
    );
  }
  const requestedResults = searches.reduce((total, search) => total + search.limit, 0);
  if (requestedResults > MAX_TOOL_SEARCH_RESULTS) {
    throw new ToolInputError(
      `batch queries resolve to ${requestedResults} results, but may request at most ${MAX_TOOL_SEARCH_RESULTS} in total. An omitted limit counts as ${config.searchDefaultLimit}; set smaller per-query limits and retry.`,
    );
  }
  const serializedQueries = JSON.stringify(searches.map((search) => search.query));
  const serializedQueryBytes = new TextEncoder().encode(serializedQueries).byteLength;
  if (serializedQueryBytes > MAX_TOOL_SEARCH_BATCH_QUERY_BYTES) {
    throw new ToolInputError(
      `serialized batch query text may use at most ${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes.`,
    );
  }
  return { kind: "batch", searches };
}

/** Normalize scalar and batch shapes without dropping independent searches. */
export function readToolSearchRequest(args: unknown, config: ToolSearchConfig): ToolSearchRequest {
  const params = asToolParamsRecord(args);
  const query = params.query ?? undefined;
  const queries = params.queries ?? undefined;
  const hasQuery = query !== undefined;
  const hasQueries = queries !== undefined;
  if (!hasQuery && !hasQueries) {
    throw new ToolInputError("provide query or queries.");
  }
  if (hasQueries && !Array.isArray(queries)) {
    throw new ToolInputError("queries must be a non-empty array.");
  }
  const batchEntries = Array.isArray(queries) ? queries : [];
  if (hasQuery && typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const singleQuery = typeof query === "string" && query.trim() ? query : undefined;
  if (batchEntries.length === 0) {
    if (singleQuery === undefined && hasQueries) {
      throw new ToolInputError("queries must be a non-empty array.");
    }
    return { kind: "single", search: readToolSearchArgs(params, config) };
  }
  if (singleQuery === undefined && (params.limit != null || params.options !== undefined)) {
    throw new ToolInputError("set limit on each batch query, not on the batch request.");
  }
  const searches = batchEntries.map((value, index) =>
    readBatchToolSearchEntry(value, index, config),
  );
  if (singleQuery !== undefined) {
    // Even identical text is an independent search with its own limit and budget.
    const single = readToolSearchArgs(params, config);
    searches.unshift({ query: single.query.trim(), limit: single.limit });
  }
  return readBatchToolSearchRequest(searches, config);
}
