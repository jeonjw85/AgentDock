import { describe, it, expect } from "vitest";
import { ClaudeStreamParser } from "./claude-stream-parser.js";

/**
 * Fixtures below mirror the *real* Claude Code stream-json schema captured from
 * the CLI (`claude -p ... --output-format stream-json --verbose`).
 */

// A successful run: init → assistant with a tool_use + usage → result.
const SUCCESS_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll create the file." },
        { type: "tool_use", name: "Write", input: { path: "hello.txt", content: "hi" } },
      ],
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 10,
      },
    },
    session_id: "s1",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0234,
    usage: { input_tokens: 1260, output_tokens: 340 },
    result: "Created hello.txt",
  }),
].join("\n") + "\n";

// The real 403 failure captured from this environment.
const AUTH_FAIL_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Failed to authenticate. API Error: 403 Access to model denied.",
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    error: "authentication_failed",
    is_api_error_message: true,
    session_id: "s2",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    total_cost_usd: 0,
    api_error_status: 403,
    result: "Failed to authenticate. API Error: 403 Access to model denied.",
  }),
].join("\n") + "\n";

describe("ClaudeStreamParser", () => {
  it("parses a successful run: tool calls, usage, cost, success", () => {
    const toolCalls: string[] = [];
    let inTok = 0;
    let outTok = 0;
    const parser = new ClaudeStreamParser({
      onToolCall: (t) => toolCalls.push(t),
      onUsageDelta: (u) => {
        inTok += u.inputTokens ?? 0;
        outTok += u.outputTokens ?? 0;
      },
    });
    parser.push(SUCCESS_STREAM);
    parser.end();

    expect(toolCalls).toEqual(["Write"]);
    // input = 1200 + 50 (cache_creation) + 10 (cache_read) = 1260
    expect(inTok).toBe(1260);
    expect(outTok).toBe(340);
    expect(parser.result.success).toBe(true);
    expect(parser.result.costUsd).toBeCloseTo(0.0234);
    expect(parser.result.summary).toBe("Created hello.txt");
  });

  it("parses the real 403 auth failure as unsuccessful with status", () => {
    const parser = new ClaudeStreamParser();
    parser.push(AUTH_FAIL_STREAM);
    parser.end();
    expect(parser.result.success).toBe(false);
    expect(parser.result.apiErrorStatus).toBe(403);
    expect(parser.result.error).toBe("authentication_failed");
  });

  it("handles chunk boundaries splitting a JSON line mid-way", () => {
    const toolCalls: string[] = [];
    const parser = new ClaudeStreamParser({ onToolCall: (t) => toolCalls.push(t) });
    // Feed the stream one character at a time to stress the line buffer.
    for (const ch of SUCCESS_STREAM) parser.push(ch);
    parser.end();
    expect(toolCalls).toEqual(["Write"]);
    expect(parser.result.success).toBe(true);
  });

  it("ignores non-JSON noise lines", () => {
    const parser = new ClaudeStreamParser();
    parser.push("not json\n");
    parser.push('{"type":"result","is_error":false,"total_cost_usd":1}\n');
    parser.end();
    expect(parser.result.success).toBe(true);
    expect(parser.result.costUsd).toBe(1);
  });
});
