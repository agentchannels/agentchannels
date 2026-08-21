import { invalidState } from "../errors.ts";
import { ClaudeRuntime } from "./claude.ts";
import type { InteractionKind, RuntimeType } from "../model.ts";

export type RuntimeInteractionRequest = {
  kind: InteractionKind;
  title: string;
  body: string;
  data: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
};

export type RuntimeEvent =
  | { type: "session_started"; runtimeSessionId: string }
  | { type: "progress"; body: string }
  | { type: "final"; body: string }
  | { type: "error"; message: string };

export type RuntimeTurn = {
  events: AsyncIterable<RuntimeEvent>;
  interrupt(): Promise<void>;
  dispose(): void;
};

/** How a pending interaction was settled. Produced only by `interpretResponse`. */
export type InteractionResult = Readonly<{
  status: "answered" | "denied";
  response: unknown;
}>;

export type RuntimeStartOptions = {
  cwd: string;
  additionalDirectories: readonly string[];
  prompt: string;
  requestInteraction(
    request: RuntimeInteractionRequest,
  ): Promise<InteractionResult>;
};

export type RuntimeResumeOptions = RuntimeStartOptions & {
  runtimeSessionId: string;
};

/** A pending interaction as the coordinator has it persisted. */
export type PendingInteractionState = Readonly<{
  kind: InteractionKind;
  /** The request this runtime originally made. */
  request: unknown;
  /** What earlier partial responses accumulated, if any. */
  progress: unknown;
}>;

/**
 * A channel reply either settles a pending interaction or adds to it. Multi-part
 * questions arrive one answer at a time, so `partial` carries the accumulated
 * state forward without waking the runtime.
 */
export type InteractionOutcome =
  | Readonly<{ state: "partial"; progress: unknown }>
  | (Readonly<{ state: "resolved" }> & InteractionResult);

export type Runtime = {
  readonly type: "claude-code";
  start(options: RuntimeStartOptions): RuntimeTurn;
  resume(options: RuntimeResumeOptions): RuntimeTurn;
  /**
   * Decide what a raw channel reply means for a pending interaction.
   *
   * Only the runtime adapter knows how its own tool protocol encodes questions
   * and approvals, so this is the single place an "allow" or "deny" is decided.
   * The coordinator persists the outcome and never re-derives it.
   */
  interpretResponse(
    pending: PendingInteractionState,
    incoming: unknown,
  ): InteractionOutcome;
};

/**
 * Which runtime implementation backs a given Agent.
 *
 * Adding a runtime is a new file plus one line here. Nothing else in the product
 * names a runtime: the schema stores the identifier opaquely and the coordinator
 * only ever holds a `Runtime`.
 */
export type RuntimeFactory = () => Runtime;

const factories = new Map<RuntimeType, RuntimeFactory>([
  ["claude-code", () => new ClaudeRuntime()],
]);

export function resolveRuntime(type: RuntimeType): Runtime {
  const factory = factories.get(type);
  if (factory === undefined)
    throw invalidState(`Runtime ${type} is not available in this build.`, [
      `Install a build that provides the ${type} runtime.`,
    ]);
  return factory();
}

export function availableRuntimes(): readonly RuntimeType[] {
  return [...factories.keys()];
}
