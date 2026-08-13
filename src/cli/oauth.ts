import type { ClaudeCodeClient } from '../battery/api/index.js';

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function formatUsage(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === null) continue;
    if (key === 'extra_usage') continue;
    if (typeof value === 'object' && value !== null && 'utilization' in value) {
      const bucket = value as { utilization: number; resets_at: string | null };
      const label = key.replace(/_/g, ' ');
      const resets = bucket.resets_at
        ? ` (resets ${new Date(bucket.resets_at).toLocaleString()})`
        : '';
      console.log(`  ${label}: ${bucket.utilization}%${resets}`);
    }
  }

  const extra = data.extra_usage as { is_enabled: boolean } | null;
  if (extra) {
    console.log(`  extra usage: ${extra.is_enabled ? 'enabled' : 'disabled'}`);
  }
}

function formatProfile(data: Record<string, unknown>): void {
  const account = data.account as Record<string, unknown>;
  const org = data.organization as Record<string, unknown>;
  console.log(`  name: ${account.display_name}`);
  console.log(`  email: ${account.email}`);
  console.log(`  plan: ${org.organization_type}`);
  console.log(`  org: ${org.name}`);
  console.log(`  status: ${org.subscription_status}`);
}

export async function oauthCommand(client: ClaudeCodeClient, subcommand: string[], jsonOutput: boolean): Promise<void> {
  const endpoint = subcommand[0];

  switch (endpoint) {
    case 'usage': {
      const usage = await client.oauth.getUsage();
      if (jsonOutput) {
        printJson(usage);
      } else {
        console.log('Usage:');
        formatUsage(usage as unknown as Record<string, unknown>);
      }
      break;
    }
    case 'profile': {
      const profile = await client.oauth.getProfile();
      if (jsonOutput) {
        printJson(profile);
      } else {
        console.log('Profile:');
        formatProfile(profile as unknown as Record<string, unknown>);
      }
      break;
    }
    default:
      console.error(`Unknown oauth command: ${endpoint}`);
      process.exit(1);
  }
}
