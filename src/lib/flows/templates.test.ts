import { describe, it, expect } from "vitest";
import { listFlowTemplates } from "./templates";
import { validateFlowForActivation } from "./validate";

describe("flow templates — activation validity", () => {
  for (const template of listFlowTemplates()) {
    it(`"${template.slug}" has no activation errors`, () => {
      const issues = validateFlowForActivation(
        {
          name: template.name,
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config as Record<string, unknown>,
          entry_node_id: template.entry_node_id,
        },
        template.nodes.map((n) => ({
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config as Record<string, unknown>,
        })),
      );
      const errors = issues.filter((i) => i.severity === "error");
      expect(errors).toEqual([]);
    });
  }
});
