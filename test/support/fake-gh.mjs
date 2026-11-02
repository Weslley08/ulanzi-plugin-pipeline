// Preloaded with --import so scripts/flow.mjs runs its real code and a real git against canned gh replies.
// FAKE_GH_REPLIES is a JSON list of [start of the arguments, reply], and the first match answers.
// A reply of {"fail": true} makes the command fail. Each call is appended to FAKE_GH_LOG, with what
// it sent on stdin as a last item.
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const realExecFileSync = childProcess.execFileSync;
const replies = JSON.parse(process.env.FAKE_GH_REPLIES ?? '[]');

childProcess.execFileSync = (command, args, options) => {
  if (command !== 'gh') return realExecFileSync(command, args, options);
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(options?.input ? [...args, JSON.parse(options.input)] : args)}\n`);
  const reply = replies.find(([start]) => args.join(' ').startsWith(start))?.[1];
  if (reply?.fail) throw new Error('gh failed');
  if (reply === undefined) return '';
  return typeof reply === 'string' ? reply : JSON.stringify(reply);
};
syncBuiltinESMExports();
