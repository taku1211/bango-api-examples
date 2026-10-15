import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BangoApiError,
  BangoJobFailedError,
  BangoJobTimeoutError,
  BangoProtocolError,
  BangoTransportError,
  LiveBango,
  validateAsOfDate,
  validateCompanyNames,
} from './live.ts';

export type LiveCliArgs = {
  companies: string[];
  date: string | null;
  confirm: boolean;
  help: boolean;
};

export function parseLiveCliArgs(args: string[]): LiveCliArgs {
  const companies: string[] = [];
  let date: string | null = null;
  let confirm = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--confirm') {
      confirm = true;
    } else if (argument === '--date') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--date requires a YYYY-MM-DD value.');
      date = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error('Unknown option. Use --help to see supported options.');
    } else {
      companies.push(argument);
    }
  }

  if (help) return { companies, date, confirm, help };
  const normalizedCompanies = validateCompanyNames(companies);
  if (date === null) throw new Error('Pass --date YYYY-MM-DD for invoice validity.');
  return { companies: normalizedCompanies, date: validateAsOfDate(date), confirm, help };
}

const HELP = `Usage:
  npm run live:read -- --confirm --date YYYY-MM-DD "Public company name" ["Another name" ...]

Supply 1 to 3 company names that you selected and are authorized to submit.
--confirm is required because batch/match creates a remote job and consumes batch-row quota.
Only confident matches are looked up. Review and unmatched results stay unlinked.
No watch targets or webhook settings are changed. BANGO_API_KEY is read from the environment.
`;

function safeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof BangoApiError) return { type: error.name, ...error.problem };
  if (error instanceof BangoJobFailedError) {
    return { type: error.name, code: error.code, retryAfterSeconds: error.retryAfterSeconds, message: error.message };
  }
  if (error instanceof BangoJobTimeoutError || error instanceof BangoTransportError || error instanceof BangoProtocolError) {
    return { type: error.name, message: error.message };
  }
  if (error instanceof Error) return { type: 'InputError', message: error.message };
  return { type: 'LiveReadError', message: 'Live read failed.' };
}

export async function runLiveCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let parsed: LiveCliArgs;
  try {
    parsed = parseLiveCliArgs(args);
  } catch (error) {
    console.error(JSON.stringify({ error: safeFailure(error), callsMade: 0 }, null, 2));
    return 2;
  }
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (!parsed.confirm) {
    console.error(JSON.stringify({
      error: {
        type: 'ConfirmationRequired',
        message: 'Pass --confirm to create the batch job and consume batch-row quota.',
      },
      callsMade: 0,
    }, null, 2));
    return 2;
  }

  const apiKey = env.BANGO_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({ error: { type: 'ConfigurationError', message: 'BANGO_API_KEY is required.' }, callsMade: 0 }, null, 2));
    return 2;
  }

  let api: LiveBango | undefined;
  try {
    api = new LiveBango(apiKey);
    const result = await api.run(parsed.companies, parsed.date!);
    console.log(JSON.stringify({
      ...result,
      remoteJobCreated: true,
      warning: 'Batch submission consumes batch-row quota. No watch or webhook settings were changed.',
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: safeFailure(error), callsMade: api?.callsMade ?? 0 }, null, 2));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runLiveCli(process.argv.slice(2));
}
