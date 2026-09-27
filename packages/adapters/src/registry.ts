import type { TaskRole } from "@agentdock/core";
import type { AgentAdapter } from "./adapter.js";

/** Registry of available agent adapters, keyed by descriptor id. */
export class AdapterRegistry {
  #adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    const id = adapter.descriptor.id;
    if (this.#adapters.has(id)) {
      throw new Error(`Adapter already registered: ${id}`);
    }
    this.#adapters.set(id, adapter);
    return this;
  }

  get(id: string): AgentAdapter | undefined {
    return this.#adapters.get(id);
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  all(): AgentAdapter[] {
    return [...this.#adapters.values()];
  }

  /**
   * Pick a suitable adapter for a role. Prefers adapters that explicitly list
   * the role; falls back to role-agnostic adapters (empty roles list).
   */
  pickForRole(role: TaskRole): AgentAdapter | undefined {
    const all = this.all();
    return (
      all.find((a) => a.descriptor.roles.includes(role)) ??
      all.find((a) => a.descriptor.roles.length === 0)
    );
  }
}
