/**
 * Generates a Slack App Manifest for the Agent Channels bot.
 *
 * @see https://api.slack.com/reference/manifests
 */
export interface SlackManifestOptions {
  appName: string;
  appDescription: string;
  socketMode: boolean;
}

export function buildSlackManifest(options: SlackManifestOptions): object {
  const { appName, appDescription, socketMode } = options;

  return {
    display_information: {
      name: appName,
      description: appDescription,
      background_color: '#6C47FF',
    },
    features: {
      assistant_view: {
        assistant_description: appDescription,
        suggested_prompts: [
          { title: "What can you do?", message: "What can you help me with?" },
        ],
      },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'assistant:write',
          'channels:history',
          'channels:read',
          'chat:write',
          'groups:history',
          'groups:read',
          'im:history',
          'im:read',
          'im:write',
          'mpim:history',
          'mpim:read',
          'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          'app_mention',
          'message.im',
        ],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: socketMode,
      token_rotation_enabled: false,
    },
  };
}
