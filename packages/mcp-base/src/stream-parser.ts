import split2 from "split2";
import type { Transform } from "node:stream";

/**
 * Creates a transform stream that splits input on newlines and parses each line as JSON.
 * Emits parsed objects. Malformed lines emit an 'error' event on the stream.
 */
export function createNdjsonParser(): Transform {
  return split2(JSON.parse);
}
