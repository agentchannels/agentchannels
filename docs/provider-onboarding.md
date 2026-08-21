# Provider onboarding evidence and dogfood

This document records the provider contracts that AgentChannels relies on and
the checks that require real provider or operating-system state. Automated tests
use injected HTTP, credential-store, relay, prompt, and service-manager doubles;
they do not mutate a real Slack or Linear workspace, keychain, launchd, systemd,
or `~/.agentchannels`. Credential-store isolation is structural rather than
conventional: the keyring service name is derived from the product home, so any
run under `--home` or `AGENTCHANNELS_HOME` addresses its own namespace and cannot
read or delete the operator's installation identity.

## Source and package smoke

The source-checkout path is verified from a missing `dist` directory: `pnpm
start -- --help` runs `src/cli.ts` through Node's built-in type stripping, so
there is no build step, no build lock, and no build-tool output on stdout. This
requires Node.js 24; the packaged CLI runs compiled JavaScript and is smoke-tested
on both Node.js 22 and 24, the declared `engines` range.

The release path packs the built `dist` tree and `scripts/restore-database.mjs`
only, installs that tarball into a temporary pnpm project, and runs
`scripts/first-run-smoke.mjs`. The smoke covers version/help, local-only init,
idempotent re-entry, global status, and Ctrl-C cancellation in temporary Git
repositories and homes. It does not contact a provider, install an OS service,
or use the operator's home directory.

## Terminal prompts

The human path uses `@inquirer/prompts` only through `PromptIO`. The package's
7.5.x line declares `engines.node >=18`, so it covers every supported Node 22
runtime. The project pins 7.5.3 while it promises all Node 22 versions; the current
main package has a newer engine range (`>=23.5.0 || ^22.13.0 || ^20.17.0`).

Select prompts use arrow keys and Enter; checkbox prompts use arrows, Space, and
Enter; password prompts hide input. Inquirer requires an interactive TTY for
keypress prompts. Its documentation says that code providing or shadowing a
stdin stream may need to set raw mode explicitly. Ctrl-C rejects with
`ExitPromptError`; AbortSignal cancellation can reject with `AbortPromptError`.
The CLI catches both expected prompt cancellations, restores terminal state, and
maps them to `Cancelled.` with exit 130. Non-TTY and JSON paths never enter raw
mode.

References: [prompts README](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/prompts/README.md),
[Ctrl-C handling](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/prompts/README.md#handling-ctrlc-gracefully),
[`@inquirer/prompts@7.5.3` metadata](https://registry.npmjs.org/@inquirer/prompts/7.5.3).

## Slack

Slack app manifests are JSON or YAML. The current official manifest guide is
[`App manifests`](https://docs.slack.dev/app-manifests.md); the older
`/tools/slack-app-manifests/` path is no longer the canonical page. Slack's
creation procedure is: open **Create New App**, choose **from a manifest**, paste
the generated artifact, choose the development workspace, review, and create.
AgentChannels writes the complete manifest, offers clipboard copy, and opens its
app-creation action URL. If the browser or clipboard is unavailable, use the
artifact path and resume the same pending setup.

References: [manifest creation](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests.md#creating_apps),
[manifest schema](https://docs.slack.dev/reference/app-manifest.md#fields).

The Events API request URL receives a JSON `url_verification` POST containing a
`challenge`; before credentials are collected, the endpoint must answer HTTP
200 with that exact challenge. Normal requests must use Slack signing-secret
verification. One Events API request URL receives all subscribed event types.

Interactive payloads arrive as form-encoded POSTs with JSON in the `payload`
field. Every valid interaction needs an HTTP 200 acknowledgement within three
seconds. A `trigger_id` also expires after three seconds and can be used only
once. The manifest uses the same HTTPS Relay endpoint for Events API and
Interactivity.

After the app is created and installed, enter only the Bot Token and Signing
Secret through hidden prompts. AgentChannels verifies the token with
`POST https://slack.com/api/auth.test` using an Authorization Bearer header and
requires `ok: true`, `team_id`, and `user_id`; `auth.test` requires no OAuth
scopes. Workspace discovery and Operator search happen only after verification,
then credentials are persisted and the Binding is activated.

References: [Events URL verification](https://docs.slack.dev/apis/events-api/using-http-request-urls.md#url-verification-handshake),
[interactivity acknowledgement](https://docs.slack.dev/interactivity/handling-user-interaction.md#acknowledgment-response),
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test.md).

## Linear

AgentChannels generates the official JSON manifest with schema
[`https://linear.app/.well-known/oauth-app-manifest.schema.json`](https://linear.app/.well-known/oauth-app-manifest.schema.json),
keeps the required `authorization_code` grant, and adds
`client_credentials` for the app-actor token. The manifest includes a real
HTTPS webhook and `AgentSessionEvent`. Linear requires a client URI and at least
one unique redirect URI; webhook URLs must be HTTPS and cannot be loopback,
private-network, or `linear.app` hosts. The generated artifact opens the
prefilled application page:
`https://linear.app/settings/api/applications/new?manifest=...`.

Create the private application as a workspace administrator, leave client
credentials enabled, and confirm **Agent session events** is selected. Enter
Client ID, Client Secret, and Webhook Signing Secret through hidden prompts.
The CLI requests a client-credentials token at
`POST https://api.linear.app/oauth/token` with URL-encoded form data,
`grant_type=client_credentials`, and the comma-separated scopes
`read,write,app:mentionable,app:assignable`. It then verifies an authenticated
GraphQL response containing `viewer { id app organization { id name } }`; the
installation identity is the discovered organization ID. Only after `viewer.app`
is true and an organization is present are credentials stored and the Binding
activated.

For the agent authorization contract, `actor=app` makes mutations originate from
the app and requires workspace-admin installation. `app:mentionable` and
`app:assignable` are optional agent scopes; `actor=app` cannot request `admin`.
Linear's Agent guide says a created `AgentSessionEvent` contains `agentSession`
and the agent should emit a `thought` activity within 10 seconds.

References: [OAuth manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication),
[actor authorization](https://linear.app/developers/oauth-actor-authorization),
[Agents](https://linear.app/developers/agents).

## Background service evidence

On Linux, `systemctl --user daemon-reload` reloads unit files and rebuilds the
manager dependency tree. `systemctl --user reload` is different: it reloads the
service's own configuration, not the unit file. A changed active unit therefore
requires daemon-reload followed by `systemctl --user restart`; `start` does not
apply a new definition to an already active service. Enablement and runtime
start/restart are separate operations.

On macOS, the Apple archival launchd guide documents plist loading at boot/login,
LaunchAgent locations, ownership/mode requirements, `KeepAlive`, and the rule
that launchd-managed processes must not daemonize. It does not document modern
`launchctl bootstrap`/`bootout` replacement semantics. AgentChannels follows the
current local `launchctl(1)` contract: write the plist, `bootout` the existing
`gui/<uid>/<label>` target, then `bootstrap gui/<uid> <plist>`, and verify with
`launchctl print`. This caveat is intentional: the replacement sequence is not
claimed as evidence from Apple's archived page.

References: [`systemctl`](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html),
[`systemd.service`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

## Manual credentialed dogfood

Run these checks only in disposable workspaces and a temporary Git repository
with one commit. Do not paste tokens or signing secrets into logs or issue
reports.

1. Run `agentchannels init`, select Slack, and verify that the generated artifact
   and action URL create the app. In Slack, confirm the Events API URL challenge
   succeeds while `init` is still waiting; enable Interactivity and confirm its
   request URL is the same HTTPS endpoint. Install the app and approve its bot
   scopes. Enter the hidden Bot Token and Signing Secret; verify `auth.test`,
   workspace discovery, Operator search, and Binding activation.
2. Interrupt Slack onboarding at the administrator wait with Ctrl-C. Confirm the
   terminal is usable, rerun `agentchannels init`, and confirm the same pending
   setup resumes without a second Agent or Binding. Repeat once with EOF.
3. Run `agentchannels init`, select Linear, and create the prefilled private app
   as a workspace administrator. Confirm `authorization_code` and
   `client_credentials` are enabled, the webhook is HTTPS, and Agent session
   events is selected. Enter the hidden Client ID, Client Secret, and Webhook
   Signing Secret; verify the app-actor token, `viewer.app`, organization
   discovery, Operator selection, and Binding activation.
4. Interrupt Linear onboarding before credential persistence, rerun `init`, and
   verify resume. With both providers selected, make one provider verification
   fail and confirm the other provider's completed Binding remains intact.
5. On a disposable Linux user account, run daemon install/start/status/restart/
   stop/uninstall. Edit the generated definition through the CLI, verify an
   active changed definition performs daemon-reload plus restart, and verify an
   unchanged running definition is a no-op. Re-login and verify the user service
   starts. Remove the unit afterward.
6. On a disposable macOS user account, run the equivalent daemon lifecycle.
   Verify changed definitions use bootout/bootstrap, status reports the new
   definition, and re-login starts the LaunchAgent. Remove the plist afterward.

These provider and OS checks are manual release checks; automated tests must
continue to use temporary homes, injected dependencies, and service-manager
doubles rather than real provider credentials, keychains, launchd, or systemd.
