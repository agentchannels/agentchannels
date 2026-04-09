import { describe, it, expect } from 'vitest';
import { buildSlackManifest } from '../../../src/channels/slack/manifest.js';

describe('buildSlackManifest', () => {
  it('generates a valid manifest with socket mode enabled', () => {
    const manifest = buildSlackManifest({
      appName: 'Test Bot',
      appDescription: 'A test bot',
      socketMode: true,
    });

    expect(manifest).toEqual(
      expect.objectContaining({
        display_information: expect.objectContaining({
          name: 'Test Bot',
          description: 'A test bot',
        }),
        features: expect.objectContaining({
          bot_user: expect.objectContaining({
            display_name: 'Test Bot',
            always_online: true,
          }),
        }),
        settings: expect.objectContaining({
          socket_mode_enabled: true,
          event_subscriptions: expect.objectContaining({
            bot_events: expect.arrayContaining(['app_mention', 'message.im']),
          }),
        }),
      }),
    );
  });

  it('includes required bot scopes', () => {
    const manifest = buildSlackManifest({
      appName: 'Bot',
      appDescription: 'desc',
      socketMode: true,
    }) as any;

    const scopes = manifest.oauth_config.scopes.bot;
    expect(scopes).toContain('app_mentions:read');
    expect(scopes).toContain('chat:write');
    expect(scopes).toContain('channels:history');
    expect(scopes).toContain('im:history');
    expect(scopes).toContain('im:write');
  });

  it('respects socketMode flag when disabled', () => {
    const manifest = buildSlackManifest({
      appName: 'Bot',
      appDescription: 'desc',
      socketMode: false,
    }) as any;

    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  it('limits app name to display_information', () => {
    const manifest = buildSlackManifest({
      appName: 'My Custom Name',
      appDescription: 'Custom desc',
      socketMode: true,
    }) as any;

    expect(manifest.display_information.name).toBe('My Custom Name');
    expect(manifest.features.bot_user.display_name).toBe('My Custom Name');
  });
});
