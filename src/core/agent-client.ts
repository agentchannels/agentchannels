import Anthropic from "@anthropic-ai/sdk";
import { parseSSEEvent } from "./chunk-parser.js";
import type { AgentStreamEvent, RawSessionEvent } from "./chunk-parser.js";

// Re-export chunk parser types for downstream consumers
export type { AgentStreamEvent, RawSessionEvent } from "./chunk-parser.js";
export type {
  TextDeltaEvent,
  ToolUseEvent,
  ThinkingEvent,
  StatusEvent,
  DoneEvent,
  ErrorEvent,
  RawEvent,
  ParseResult,
} from "./chunk-parser.js";
export { parseSSEEvent } from "./chunk-parser.js";

export interface AgentClientConfig {
  apiKey: string;
  agentId?: string;
  environmentId?: string;
}

/**
 * Options for sendMessage to control streaming behavior.
 */
export interface SendMessageOptions {
  /** If true, emit raw events alongside parsed events for debugging */
  emitRawEvents?: boolean;
  /** AbortSignal to cancel the stream */
  signal?: AbortSignal;
}

/**
 * Result of creating a managed agent.
 */
export interface CreateAgentResult {
  id: string;
  name: string;
  version: number;
}

/**
 * Result of creating an environment.
 */
export interface CreateEnvironmentResult {
  id: string;
  name: string;
}

/**
 * Wraps the Anthropic SDK for Claude Managed Agent operations:
 * create agent, create environment, create session, send events, stream responses.
 *
 * Uses the beta API surface: client.beta.agents, client.beta.environments,
 * client.beta.sessions, and client.beta.sessions.events.
 */
export class AgentClient {
  private client: Anthropic;
  private agentId: string | undefined;
  private environmentId: string | undefined;

  constructor(config: AgentClientConfig) {
    if (!config.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required to create AgentClient");
    }
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
  }

  /**
   * Validate that the API key is functional by listing agents.
   * Throws if the key is invalid or the API is unreachable.
   */
  async validateAuth(): Promise<void> {
    try {
      // A lightweight call to verify the API key works
      await this.client.beta.agents.list({ limit: 1 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Anthropic API authentication failed: ${message}`);
    }
  }

  /**
   * Create a new managed agent.
   */
  async createAgent(params: {
    name: string;
    model?: string;
    description?: string;
    system?: string;
  }): Promise<CreateAgentResult> {
    const agent = await this.client.beta.agents.create({
      name: params.name,
      model: params.model ?? "claude-sonnet-4-6",
      description: params.description,
      system: params.system,
    });

    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
    };
  }

  /**
   * Retrieve an existing agent to validate it exists.
   * Returns the agent info or throws if not found.
   */
  async getAgent(agentId?: string): Promise<CreateAgentResult> {
    const id = agentId ?? this.agentId;
    if (!id) {
      throw new Error("No agent ID provided");
    }

    const agent = await this.client.beta.agents.retrieve(id);
    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
    };
  }

  /**
   * Create a new environment (top-level resource, not scoped to agent).
   */
  async createEnvironment(params: {
    name: string;
    description?: string;
  }): Promise<CreateEnvironmentResult> {
    const env = await this.client.beta.environments.create({
      name: params.name,
      description: params.description,
    });

    return {
      id: env.id,
      name: env.name,
    };
  }

  /**
   * Retrieve an existing environment to validate it exists.
   */
  async getEnvironment(environmentId?: string): Promise<CreateEnvironmentResult> {
    const id = environmentId ?? this.environmentId;
    if (!id) {
      throw new Error("No environment ID provided");
    }

    const env = await this.client.beta.environments.retrieve(id);
    return {
      id: env.id,
      name: env.name,
    };
  }

  /**
   * Create a new managed agent session.
   * Sessions reference both an agent and an environment.
   */
  async createSession(params?: {
    agentId?: string;
    environmentId?: string;
    title?: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    const agentId = params?.agentId ?? this.agentId;
    const envId = params?.environmentId ?? this.environmentId;

    if (!agentId) {
      throw new Error("No agent ID configured. Set CLAUDE_AGENT_ID or pass agentId.");
    }
    if (!envId) {
      throw new Error("No environment ID configured. Set CLAUDE_ENVIRONMENT_ID or pass environmentId.");
    }

    const session = await this.client.beta.sessions.create({
      agent: agentId,
      environment_id: envId,
      title: params?.title,
      metadata: params?.metadata,
    });

    return session.id;
  }

  /**
   * Send a user message to an existing session and stream the response.
   * Yields AgentStreamEvents as they arrive via SSE.
   *
   * The SSE stream from the Managed Agent API emits events such as:
   * - content_block_start / content_block_delta / content_block_stop (incremental text)
   * - agent.message (full message content blocks)
   * - agent.tool_use (tool invocations)
   * - agent.thinking (extended thinking blocks)
   * - session.status_running / session.status_idle / session.status_terminated
   * - session.error / session.deleted
   *
   * This method normalizes all event types into a unified AgentStreamEvent stream.
   *
   * @param sessionId - The session to send the message to
   * @param text - The user message text
   * @param options - Optional streaming behavior controls (emitRawEvents, abort signal)
   */
  async *sendMessage(
    sessionId: string,
    text: string,
    options?: SendMessageOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const emitRaw = options?.emitRawEvents ?? false;
    const signal = options?.signal;

    // Check for abort before starting
    if (signal?.aborted) {
      yield { type: "error", error: "Stream aborted before starting" };
      return;
    }

    try {
      // Open SSE stream to receive agent events
      const stream = await this.client.beta.sessions.events.stream(sessionId);

      // Send the user message event
      await this.client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text }],
          },
        ],
      });

      for await (const event of stream) {
        if (event.type === "agent.message") {
          console.log(`[AgentClient] Received agent.message event: ${JSON.stringify(event, undefined, 2)}`);
        } else if (event.type === "agent.tool_use") {
    console.log(`\n[Using tool: ${event.name}]`);
  } else if (event.type === "session.status_idle") {
    console.log("\n\nAgent finished.");
    break;
  }

        // Check for abort signal between events
        if (signal?.aborted) {
          yield { type: "error", error: "Stream aborted" };
          return;
        }

        // Emit raw event if requested (for debugging/extensibility)
        if (emitRaw) {
          yield { type: "raw", event: event as unknown as RawSessionEvent };
        }

        // Parse and yield typed events
        const { events: parsed, terminal } = parseSSEEvent(event);
        for (const e of parsed) {
          yield e;
        }
        if (terminal) return;
      }

      yield { type: "done" };
    } catch (err) {
      // Don't emit error for expected abort
      if (signal?.aborted) {
        yield { type: "error", error: "Stream aborted" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: message };
    }
  }

  /**
   * Collect the full text response from a session message.
   * Convenience wrapper around sendMessage that concatenates all text deltas.
   */
  async sendMessageAndCollect(
    sessionId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    let fullText = "";
    for await (const event of this.sendMessage(sessionId, text, options)) {
      if (event.type === "text_delta") {
        fullText += event.text;
      }
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }
    return fullText;
  }

  /** Get the configured agent ID */
  getAgentId(): string | undefined {
    return this.agentId;
  }

  /** Get the configured environment ID */
  getEnvironmentId(): string | undefined {
    return this.environmentId;
  }

  /** Get the underlying Anthropic client (for advanced use) */
  getRawClient(): Anthropic {
    return this.client;
  }
}
