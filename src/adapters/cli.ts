#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DaemonClient, ClientError } from './client.js';
import type { Snapshot } from '../shared/types.js';

const help = `Agent-Collaborator v0.1.0\n\nUsage: node dist/adapters/cli.js <command>\n\n  status                         Check the local daemon\n  projects                       List projects\n  tasks [projectId]              List tasks (optionally one project)\n  task <taskId>                  Read task, comments, attempts and handoffs\n  run <command> <JSON|@file>      Execute one domain command\n  export <file>                  Write a portable backup (never overwrite)\n  restore <file> --confirm-empty Restore into an empty daemon database only\n\nUse AGENT_COLLABORATOR_URL for a different loopback port.\nClaims require expectedVersion; save the returned attemptId and token.\nTask text never executes commands. See docs/api.md for the command contract.\n`;

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['help', '--help', '-h'].includes(action)) {
    process.stdout.write(help);
    return;
  }
  const client = new DaemonClient();
  let result: unknown;
  switch (action) {
    case 'status':
      result = await client.request('/api/health');
      break;
    case 'projects':
      result = (await client.request<Snapshot>('/api/snapshot')).projects;
      break;
    case 'tasks':
      result = (await client.request<Snapshot>('/api/snapshot')).tasks.filter(
        (t) => !args[0] || t.projectId === args[0],
      );
      break;
    case 'task':
      if (!args[0]) throw new ClientError('USAGE', 'task requires a task ID');
      result = await client.request(`/api/tasks/${encodeURIComponent(args[0])}`);
      break;
    case 'run': {
      if (!args[0] || !args[1] || args.length !== 2)
        throw new ClientError(
          'USAGE',
          'run requires a command name and one quoted JSON object or @file',
        );
      const text = args[1].startsWith('@')
        ? await readFile(resolve(args[1].slice(1)), 'utf8')
        : args[1];
      let input: unknown;
      try {
        input = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        throw new ClientError('INVALID_JSON', 'Command input is not valid JSON');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new ClientError('INVALID_JSON', 'Command input must be a JSON object');
      result = await client.command(args[0], input as Record<string, unknown>);
      break;
    }
    case 'export': {
      if (!args[0] || args.length !== 1)
        throw new ClientError('USAGE', 'export requires one new filename');
      const data = await client.request('/api/export');
      const path = resolve(args[0]);
      await writeFile(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
      result = {
        ok: true,
        path,
        warning: 'This backup contains private project data; keep it out of public repositories.',
      };
      break;
    }
    case 'restore': {
      if (!args[0] || args[1] !== '--confirm-empty' || args.length !== 2)
        throw new ClientError(
          'USAGE',
          'restore requires <file> --confirm-empty; existing databases cannot be replaced',
        );
      const text = await readFile(resolve(args[0]), 'utf8');
      let data: unknown;
      try {
        data = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        throw new ClientError('INVALID_JSON', 'Backup is not valid JSON');
      }
      result = await client.request('/api/restore', data);
      break;
    }
    default:
      throw new ClientError('USAGE', `Unknown CLI command: ${action}. Use --help.`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error: {
        code: error instanceof ClientError ? error.code : 'CLI_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        ...(error instanceof ClientError && error.details ? { details: error.details } : {}),
      },
    }) + '\n',
  );
  process.exitCode = 1;
});
