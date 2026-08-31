/**
 * Ambient types for the WebMCP browser API.
 *
 * This is the only place in the app that knows the shape of the API. The spec is
 * still moving, so every consumer must feature-detect and fail soft.
 *
 * Where it lives: Chrome 152 exposes it as `document.modelContext`, which matches
 * the WebMCP Challenge's own code sample. Some third-party write-ups claim
 * `navigator.modelContext`; that is checked as a fallback in case another
 * implementation (or a later Chrome) moves it there.
 *
 * What Chrome 152 actually provides: `registerTool`, `getTools`, `executeTool`
 * and an `ontoolchange` handler. Notably **no `unregisterTool`**, and no
 * `provideContext`/`clearContext` — both were dropped from the spec. Registration
 * is also first-write-wins: re-registering an existing name is silently ignored.
 */

export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Passed to `execute` so a tool can ask the human a question mid-call.
 * `elicit` is optional: the least settled part of the spec, and absent entirely
 * in some agent implementations.
 */
export interface McpClient {
  elicit?(params: { message: string; schema?: unknown }): Promise<{
    action: 'accept' | 'decline' | 'cancel';
    content?: unknown;
  }>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Must resolve to a plain object — not an array, not a primitive. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, client?: McpClient) => Promise<object>;
  annotations?: McpAnnotations;
}

export interface ModelContext {
  /** Async in Chrome 152 — returns a Promise that resolves to undefined. */
  registerTool(tool: McpToolDef): Promise<void> | void;
  /** Absent in Chrome 152. Present in earlier drafts; may return. */
  unregisterTool?(name: string): void;
  getTools?(): Promise<{ name: string }[]>;
}

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
  interface Document {
    modelContext?: ModelContext;
  }
}

/**
 * Feature detection. Prefers `document.modelContext` (Chrome 152 and the
 * challenge's own sample), falling back to `navigator.modelContext`.
 * Returns null when WebMCP is unavailable.
 */
export function getModelContext(): ModelContext | null {
  if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
  if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
  return null;
}
