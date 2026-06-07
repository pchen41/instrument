import { z } from 'zod';
import { uuid } from './common';

// ai_model_calls.tool_calls_redacted[] — bounded MCP/tool-call summaries. Cited
// tool results still become evidence_items; this is the redacted trace only
// (folds mcp_tool_invocations). No secrets, no raw payloads.
export const toolCallRedacted = z
  .object({
    server: z.string().min(1), // MCP server FQN/name, e.g. github / datadog / instrument-investigation
    tool: z.string().min(1),
    arguments_summary: z.string().nullish(),
    result_summary: z.string().nullish(),
    ok: z.boolean().nullish(),
    evidence_id: uuid.nullish(),
  })
  .strict();
export type ToolCallRedacted = z.infer<typeof toolCallRedacted>;
