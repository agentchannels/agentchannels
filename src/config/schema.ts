import { z } from 'zod';

/**
 * Slack-specific configuration schema
 */
export const SlackConfigSchema = z.object({
  slackBotToken: z.string().startsWith('xoxb-', 'Must be a valid Slack bot token (xoxb-...)'),
  slackAppToken: z.string().startsWith('xapp-', 'Must be a valid Slack app-level token (xapp-...)'),
  slackSigningSecret: z.string().min(1, 'Signing secret is required'),
});

/**
 * Agent-specific configuration schema
 */
export const AgentConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  agentId: z.string().min(1, 'CLAUDE_AGENT_ID is required'),
  environmentId: z.string().min(1, 'CLAUDE_ENVIRONMENT_ID is required'),
});

/**
 * Full application configuration schema
 */
export const AppConfigSchema = SlackConfigSchema.merge(AgentConfigSchema);

export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
