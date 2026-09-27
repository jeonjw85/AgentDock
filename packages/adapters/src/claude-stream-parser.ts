import type { UsageMetrics } from "@agentdock/core";

/**
 * Parser for Claude Code's `--output-format stream-json` event stream.
 *
 * The stream is newline-delimited JSON. Relevant event shapes (confirmed
 * against the real CLI):
 *
 *   { "type": "system", "subtype": "init" | "hook_started" | "hook_response", ... }
 *   { "type": "assistant", "message": {
 *        "content": [ { "type": "text", "text": ... }
 *                   | { "type": "tool_use", "name": ..., "input": ... } ],
 *        "usage": { "input_tokens", "output_tokens",
 *                   "cache_creation_input_tokens", "cache_read_input_tokens" }
 *     }, "error"?: string, "is_api_error_message"?: boolean }
 *   { "type": "result", "subtype": "success" | ...,
 *        "is_error": boolean, "total_cost_usd": number,
 *        "usage": { ... }, "result": string, "api_error_status"?: number }
 *
 * This parser is intentionally pure: it consumes text chunks and reports
 * structured observations via callbacks, so it can be unit-tested against
 * recorded fixtures without spawning the CLI.
 */

export interface ClaudeParserCallbacks {
  onToolCall?: (tool: string, input?: unknown) => void;
  onText?: (text: string) => void;
  onUsageDelta?: (usage: Partial<UsageMetrics>) => void;
}

export interface ClaudeResult {
  /** True when a `result` event arrived with is_error === false. */
  success: boolean;
  /** Final assistant/result text, if any. */
  summary?: string;
  /** Total cost reported by the terminal `result` event. */
  costUsd: number;
  /** API error status (e.g. 403) if the run failed at the API layer. */
  apiErrorStatus?: number;
  /** Error kind reported by an assistant error message, if any. */
  error?: string;
}

interface ClaudeUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function usageDelta(u: ClaudeUsageShape | undefined): Partial<UsageMetrics> {
  if (!u) return {};
  const input =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return { inputTokens: input, outputTokens: u.output_tokens ?? 0 };
}

export class ClaudeStreamParser {
  #buffer = "";
  #cb: ClaudeParserCallbacks;
  #result: ClaudeResult = { success: false, costUsd: 0 };

  constructor(cb: ClaudeParserCallbacks = {}) {
    this.#cb = cb;
  }

  /** Feed a raw chunk of stdout. Processes any complete JSON lines within. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (line) this.#handleLine(line);
    }
  }

  /** Flush any trailing partial line (call after the stream ends). */
  end(): void {
    const line = this.#buffer.trim();
    this.#buffer = "";
    if (line) this.#handleLine(line);
  }

  /** The accumulated result. Valid after the `result` event / end(). */
  get result(): ClaudeResult {
    return this.#result;
  }

  #handleLine(line: string): void {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON noise
    }
    const type = evt["type"];
    if (type === "assistant") this.#handleAssistant(evt);
    else if (type === "result") this.#handleResult(evt);
  }

  #handleAssistant(evt: Record<string, unknown>): void {
    const message = evt["message"] as Record<string, unknown> | undefined;
    if (evt["error"]) this.#result.error = String(evt["error"]);

    const content = (message?.["content"] as unknown[]) ?? [];
    for (const item of content) {
      const c = item as Record<string, unknown>;
      if (c["type"] === "tool_use") {
        this.#cb.onToolCall?.(String(c["name"] ?? "tool"), c["input"]);
      } else if (c["type"] === "text" && typeof c["text"] === "string") {
        this.#cb.onText?.(c["text"]);
      }
    }

    const delta = usageDelta(message?.["usage"] as ClaudeUsageShape | undefined);
    if (delta.inputTokens || delta.outputTokens) this.#cb.onUsageDelta?.(delta);
  }

  #handleResult(evt: Record<string, unknown>): void {
    const isError = evt["is_error"] === true;
    this.#result.success = !isError;
    this.#result.costUsd = Number(evt["total_cost_usd"] ?? 0);
    if (typeof evt["result"] === "string") this.#result.summary = evt["result"] as string;
    if (evt["api_error_status"] != null) {
      this.#result.apiErrorStatus = Number(evt["api_error_status"]);
    }
  }
}
