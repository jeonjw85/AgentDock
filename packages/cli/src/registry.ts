import {
  AdapterRegistry,
  ClaudeCodeAdapter,
  MockAdapter,
} from "@agentdock/adapters";

/**
 * Builds the default adapter registry.
 *
 * By default it ships with mock worker/reviewer adapters so the CLI runs fully
 * offline with no external agent installed.
 *
 * Real agents are always *registered* (so you can target them explicitly with
 * `--agent claude-code`), but the mocks remain the role defaults unless you opt
 * in by setting `AGENTDOCK_DEFAULT_AGENT=claude-code`, which makes the real
 * agent the first-registered (and therefore role-preferred) adapter.
 *
 * See docs/adapters.md to add Codex, OpenCode, Gemini, or a custom agent.
 */
export function buildDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  const preferReal = process.env["AGENTDOCK_DEFAULT_AGENT"] === "claude-code";

  const claude = new ClaudeCodeAdapter();

  if (preferReal) {
    // Registered first → chosen by AdapterRegistry.pickForRole for its roles.
    registry.register(claude);
  }

  registry.register(new MockAdapter({ id: "mock-worker", name: "Mock Worker", roles: ["work"] }));
  registry.register(
    new MockAdapter({ id: "mock-reviewer", name: "Mock Reviewer", roles: ["review", "plan"] }),
  );

  if (!preferReal) {
    // Still available for explicit `--agent claude-code` targeting.
    registry.register(claude);
  }

  return registry;
}
