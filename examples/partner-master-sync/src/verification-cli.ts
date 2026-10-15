import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReceiver } from './webhook.ts';
import {
  acquireVerificationLock,
  openVerificationStore,
  VerificationApi,
  VerificationApiError,
  VerificationError,
  VerificationHarness,
  verificationStatus,
  type VerificationConfig,
} from './verification.ts';

type Output = (line: string) => void;
type CliOptions = { fetch?: typeof fetch; stdout?: Output; stderr?: Output };
type Command = 'init' | 'baseline' | 'pull' | 'recover' | 'serve' | 'status';

const HELP = `Usage:
  npm run verification -- <init|baseline|pull|recover|serve|status> [--confirm]

init requires no active watch targets and saves an incremental start=now checkpoint.
baseline requires exactly one active corporate watch for BANGO_PUBLIC_CORPORATE_NUMBER.
pull fetches one incremental page and stores events in the local inbox only.
recover is available only after pull records an HTTP 410 continuity gap.
serve accepts signed webhooks at /webhooks/demo for at most 30 minutes (default 10).
status reports local identifiers, versions, counts, checkpoint presence, and gap state.

All commands except status require --confirm. Remote commands use GET only.
The API key, webhook secret, cursors, event payloads, and error text are never printed.
`;

function parse(args: string[]): { command: Command | null; confirm: boolean; help: boolean } {
  let command: Command | null = null;
  let confirm = false;
  let help = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--confirm') confirm = true;
    else if (arg.startsWith('--')) throw new VerificationError('UnknownOption');
    else if (command === null && ['init', 'baseline', 'pull', 'recover', 'serve', 'status'].includes(arg)) command = arg as Command;
    else throw new VerificationError('UnknownCommand');
  }
  if (!help && command === null) throw new VerificationError('CommandRequired');
  return { command, confirm, help };
}

function configFrom(env: Record<string, string | undefined>): VerificationConfig {
  const organization = env.BANGO_VERIFICATION_ORG;
  const corporateNumber = env.BANGO_PUBLIC_CORPORATE_NUMBER;
  if (!organization || !corporateNumber) throw new VerificationError('OwnerAssertionRequired');
  return { organization, corporateNumber };
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new VerificationError('InvalidServeWindow');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new VerificationError('InvalidServeWindow');
  return parsed;
}

function print(output: Output, value: unknown): void {
  output(JSON.stringify(value, null, 2));
}

async function runServe(
  server: ReturnType<typeof createReceiver>,
  port: number,
  host: string,
  windowSeconds: number,
  onListening: (port: number) => void,
): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') { rejectListen(new VerificationError('ListenerFailed')); return; }
      onListening(address.port);
      resolveListen();
    });
  });

  await new Promise<void>((resolveWindow) => {
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      const forceClose = setTimeout(() => server.closeAllConnections(), 15_000);
      server.close(() => { clearTimeout(forceClose); resolveWindow(); });
      server.closeIdleConnections();
    };
    const timer = setTimeout(finish, windowSeconds * 1000);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

export async function runVerificationCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  options: CliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? (line => console.log(line));
  const stderr = options.stderr ?? (line => console.error(line));
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(args); }
  catch (error) {
    print(stderr, { error: error instanceof VerificationError ? error.code : 'InvalidArguments' });
    return 2;
  }
  if (parsed.help) { stdout(HELP); return 0; }
  if (parsed.command === null) return 2;
  if (parsed.command !== 'status' && !parsed.confirm) {
    print(stderr, { error: 'ConfirmationRequired', hint: 'Pass --confirm to run this command.' });
    return 2;
  }
  const stateDir = env.BANGO_VERIFICATION_DIR;
  if (!stateDir) { print(stderr, { error: 'StateDirectoryRequired' }); return 2; }

  const oldUmask = process.umask(0o077);
  let releaseLock: (() => void) | undefined;
  let db: ReturnType<typeof openVerificationStore> | undefined;
  try {
    releaseLock = acquireVerificationLock(stateDir);
    db = openVerificationStore(stateDir);
    if (parsed.command === 'status') {
      print(stdout, verificationStatus(db));
      return 0;
    }

    const config = configFrom(env);
    const harnessApiCommands: Command[] = ['init', 'baseline', 'pull', 'recover'];
    const api = harnessApiCommands.includes(parsed.command)
      ? new VerificationApi(env.BANGO_API_KEY ?? '', { fetch: options.fetch })
      : undefined;
    const harness = new VerificationHarness(db, config, api);

    if (parsed.command === 'init') {
      await harness.init();
      print(stdout, { initialized: true, ...harness.status() });
    } else if (parsed.command === 'baseline') {
      await harness.baseline();
      print(stdout, harness.status());
    } else if (parsed.command === 'pull') {
      const result = await harness.pull();
      print(stdout, { ...result, checkpointPresent: true, gap: false });
    } else if (parsed.command === 'recover') {
      await harness.recover();
      print(stdout, { recovered: true, ...harness.status() });
    } else if (parsed.command === 'serve') {
      harness.assertBoundConfiguration();
      const summary = harness.status();
      if (!summary.checkpointPresent || !harness.hasBaseline() || summary.gap || !summary.subjectId) throw new VerificationError('BaselineUnavailable');
      const secret = env.BANGO_WEBHOOK_SECRET;
      if (!secret) throw new VerificationError('WebhookSecretRequired');
      const host = env.HOST ?? '127.0.0.1';
      if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new VerificationError('InvalidServeHost');
      const port = positiveInteger(env.PORT, 3000, 65535);
      const windowSeconds = positiveInteger(env.BANGO_VERIFICATION_WINDOW_SECONDS, 600, 1800);
      const server = createReceiver(db, secret, summary.subjectId);
      server.requestTimeout = 10_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 1_000;
      await runServe(server, port, host, windowSeconds, actualPort => {
        print(stdout, { listening: true, host, port: actualPort, endpoint: '/webhooks/demo', windowSeconds });
      });
      print(stdout, { served: true, host, port, windowSeconds, closed: true });
    }
    return 0;
  } catch (error) {
    const code = error instanceof VerificationError ? error.code : 'VerificationFailed';
    print(stderr, { error: code, ...(error instanceof VerificationApiError ? { status: error.status } : {}) });
    return 1;
  } finally {
    try { db?.close(); } catch { /* close is best effort after the command */ }
    try { releaseLock?.(); } catch { /* lock cleanup is best effort */ }
    process.umask(oldUmask);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVerificationCli(process.argv.slice(2));
}
