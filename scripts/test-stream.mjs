/**
 * Test script for Slack Agent SDK streaming with plan-mode tasks.
 *
 * Usage:
 *   1. Send a DM to the bot in Slack to create a thread
 *   2. Copy the channel ID and thread_ts from the server logs
 *   3. Run: CHANNEL=D0ARVHB8KCM THREAD_TS=1234567890.123456 node scripts/test-stream.mjs
 *
 * Requires: SLACK_BOT_TOKEN in .env
 */

import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.CHANNEL || 'D0ARVHB8KCM';
const threadTs = process.env.THREAD_TS;

if (!token) {
  console.error('SLACK_BOT_TOKEN is required in .env');
  process.exit(1);
}
if (!threadTs) {
  console.error('THREAD_TS is required. Send a DM to the bot first, then pass THREAD_TS=...');
  process.exit(1);
}

const client = new WebClient(token);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log(`Channel: ${channel}, Thread: ${threadTs}`);

  // 1. Set status
  console.log('1. Setting status...');
  await client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status: 'Processing your request...',
  });
  await sleep(1000);

  // 2. Start stream with plan mode
  console.log('2. Starting stream...');
  const stream = await client.chat.startStream({
    channel,
    thread_ts: threadTs,
    task_display_mode: 'plan',
  });
  console.log(`   Stream ts: ${stream.ts}`);
  await sleep(1000);

  // 3. Send initial tasks
  console.log('3. Sending initial tasks...');
  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'task_update', id: 'thinking', title: 'Thinking...', status: 'in_progress' },
      { type: 'task_update', id: 'research', title: 'Researching the topic', status: 'pending' },
      { type: 'task_update', id: 'compose', title: 'Composing response', status: 'pending' },
    ],
  });
  await sleep(2000);

  // 4. Update: thinking done, research in progress
  console.log('4. Updating tasks (thinking done, research in progress)...');
  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'task_update', id: 'thinking', title: 'Thinking...', status: 'complete' },
      { type: 'task_update', id: 'research', title: 'Researching the topic', status: 'in_progress' },
    ],
  });
  await sleep(2000);

  // 5. Update: research done, compose in progress
  console.log('5. Updating tasks (research done, compose in progress)...');
  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'task_update', id: 'research', title: 'Researching the topic', status: 'complete' },
      { type: 'task_update', id: 'compose', title: 'Composing response', status: 'in_progress' },
    ],
  });
  await sleep(2000);

  // 6. All tasks done
  console.log('6. All tasks complete...');
  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'task_update', id: 'compose', title: 'Composing response', status: 'complete' },
    ],
  });
  await sleep(1000);

  // 7. Append some text
  console.log('7. Appending text...');
  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'markdown_text', text: 'Here is the result of my research:\n\n' },
    ],
  });
  await sleep(500);

  await client.chat.appendStream({
    channel,
    ts: stream.ts,
    chunks: [
      { type: 'markdown_text', text: '**AgentChannels** is an open-source CLI tool that connects Claude Managed Agents to messaging platforms like Slack.' },
    ],
  });
  await sleep(500);

  // 8. Stop stream
  console.log('8. Stopping stream...');
  await client.chat.stopStream({
    channel,
    ts: stream.ts,
  });

  // 9. Clear status
  console.log('9. Clearing status...');
  await client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status: '',
  });

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
