#!/usr/bin/env tsx
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { getLaunchdLabel } from '../src/install-slug.js';

type EnvMap = Record<string, string>;

const PROJECT_ROOT = path.resolve(process.cwd());
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const BACKUP_DIR_KEY = 'NANOCLAW_BACKUP_DIR';
const INCLUDE_GROUPS_KEY = 'NANOCLAW_BACKUP_INCLUDE_GROUPS';
const STOP_SERVICE_KEY = 'NANOCLAW_BACKUP_STOP_SERVICE';

function readEnvFile(filePath: string): EnvMap {
  if (!fs.existsSync(filePath)) return {};

  const result: EnvMap = {};
  const content = fs.readFileSync(filePath, 'utf8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (key) result[key] = value;
  }

  return result;
}

function expandUserPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function run(command: string, args: string[], options: { dryRun?: boolean; quiet?: boolean } = {}) {
  const printable = [command, ...args].map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ');
  if (options.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return { status: 0, stdout: '', stderr: '' };
  }

  if (!options.quiet) console.log(`$ ${printable}`);
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.quiet ? 'pipe' : 'inherit' });

  if ((result.status ?? 1) !== 0) {
    throw new Error(`Command failed: ${printable}${result.stderr ? `\n${result.stderr}` : ''}`);
  }

  return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function canRun(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function isTruthy(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function usage(): never {
  console.error(`Missing ${BACKUP_DIR_KEY} in .env.\n\nAdd a line like:\n${BACKUP_DIR_KEY}=/Users/${os.userInfo().username}/Desktop/nanoclaw-backups\n\nThen run:\npnpm backup:data`);
  process.exit(1);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const noStop = args.has('--no-stop');
  const includeGroupsArg = args.has('--include-groups');

  if (!fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
    throw new Error('Run this command from the NanoClaw project root.');
  }

  const env = readEnvFile(ENV_FILE);
  const rawBackupDir = env[BACKUP_DIR_KEY];
  if (!rawBackupDir) usage();

  const backupDir = path.resolve(expandUserPath(rawBackupDir));
  const includeGroups = includeGroupsArg || isTruthy(env[INCLUDE_GROUPS_KEY], false);
  const shouldStopService = !noStop && isTruthy(env[STOP_SERVICE_KEY], true);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const archiveName = includeGroups
    ? `nanoclaw-data-and-groups-backup-${timestamp}.tar.gz`
    : `nanoclaw-data-backup-${timestamp}.tar.gz`;
  const archivePath = path.join(backupDir, archiveName);
  const tarInputs = includeGroups ? ['data', 'groups'] : ['data'];

  for (const input of tarInputs) {
    if (!fs.existsSync(path.join(PROJECT_ROOT, input))) {
      throw new Error(`Required path not found: ${input}/`);
    }
  }

  if (!canRun('tar')) throw new Error('tar is required but was not found in PATH.');

  const label = getLaunchdLabel(PROJECT_ROOT);
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  let stoppedService = false;

  console.log(`Backup destination: ${backupDir}`);
  console.log(`Archive name: ${archiveName}`);
  console.log(`Includes: ${tarInputs.map((item) => `${item}/`).join(', ')}`);

  if (dryRun) {
    console.log('Dry run only. No files will be created and no service will be stopped.');
  }

  if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });

  try {
    if (process.platform === 'darwin' && shouldStopService) {
      const uid = String(process.getuid?.() ?? '');
      const serviceTarget = `gui/${uid}/${label}`;
      const domainTarget = `gui/${uid}`;
      const serviceLoaded = spawnSync('launchctl', ['print', serviceTarget], { stdio: 'ignore' }).status === 0;

      if (serviceLoaded) {
        console.log(`Stopping NanoClaw service: ${label}`);
        run('launchctl', ['bootout', serviceTarget], { dryRun });
        stoppedService = true;
      } else {
        console.log(`NanoClaw service is not loaded: ${label}`);
      }

      run('tar', ['-czf', archivePath, ...tarInputs], { dryRun });

      if (stoppedService) {
        console.log(`Restarting NanoClaw service: ${label}`);
        if (fs.existsSync(plist)) {
          if (dryRun) {
            run('launchctl', ['bootstrap', domainTarget, plist], { dryRun });
          } else {
            const bootstrap = spawnSync('launchctl', ['bootstrap', domainTarget, plist], { stdio: 'ignore' });
            if (bootstrap.status !== 0) {
              console.log('Service may already be bootstrapped; continuing to kickstart.');
            }
          }
        }
        run('launchctl', ['kickstart', '-k', serviceTarget], { dryRun });
      }
    } else {
      if (!shouldStopService) console.log('Skipping service stop because --no-stop or NANOCLAW_BACKUP_STOP_SERVICE=0 is set.');
      if (process.platform !== 'darwin') console.log('Skipping launchctl service stop because this is not macOS.');
      run('tar', ['-czf', archivePath, ...tarInputs], { dryRun });
    }
  } finally {
    if (!dryRun && stoppedService && process.platform === 'darwin') {
      const uid = String(process.getuid?.() ?? '');
      const serviceTarget = `gui/${uid}/${label}`;
      const serviceLoaded = spawnSync('launchctl', ['print', serviceTarget], { stdio: 'ignore' }).status === 0;
      if (!serviceLoaded && fs.existsSync(plist)) {
        console.log(`Ensuring NanoClaw service is restarted: ${label}`);
        spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'ignore' });
        spawnSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
      }
    }
  }

  if (!dryRun) {
    const stat = fs.statSync(archivePath);
    console.log(`Backup created: ${archivePath}`);
    console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(2)} MiB`);
  }
}

main();
