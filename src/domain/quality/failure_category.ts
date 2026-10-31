/**
 * What kind of failure a repair is answering, as the Debug brief classifies it. Debug knowledge and
 * Debug-segment Rules are scoped by the same categories.
 */
export const DEBUG_FAILURE_CATEGORIES = [
  'test_failure', 'syntax_error', 'import_error', 'dependency_error', 'network_api_failure', 'missing_output',
  'tool_loop', 'permission_denied', 'llm_provider', 'exception', 'unknown',
] as const;
export type DebugFailureCategory = (typeof DEBUG_FAILURE_CATEGORIES)[number];
