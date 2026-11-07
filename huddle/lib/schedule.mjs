// The scheduled routine: runs "huddle sync" every 30 minutes using this computer's own scheduler
// (launchd on macOS, cron on Linux, Task Scheduler on Windows). It runs on this computer because
// the chats it reads are stored on this computer.
import fs from 'node:fs';
import path from 'node:path';
import { home, run } from './sys.mjs';

export const LABEL = 'com.huddle.sync';
const CRON_TAG = '# huddle-sync';
const WIN_TASK = 'HuddleSync';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plistFile = () => path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function launchdPlist({ nodeBin, script, env, everyMinutes, logFile }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(nodeBin)}</string>
      <string>${xml(script)}</string>
      <string>sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StartInterval</key>
    <integer>${everyMinutes * 60}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
  </dict>
</plist>
`;
}

export function cronLine({ nodeBin, script, env, everyMinutes, logFile }) {
  const vars = Object.entries(env)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `*/${everyMinutes} * * * * ${vars} "${nodeBin}" "${script}" sync >> "${logFile}" 2>&1 ${CRON_TAG}`;
}

export function installSchedule(opts) {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  if (process.platform === 'darwin') {
    const file = plistFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, launchdPlist(opts));
    const domain = `gui/${process.getuid()}`;
    run('launchctl', ['bootout', `${domain}/${LABEL}`]);
    const r = run('launchctl', ['bootstrap', domain, file]);
    return r.ok ? { ok: true, how: `launchd (${file})` } : { ok: false, why: r.err };
  }
  if (process.platform === 'linux') {
    const current = run('crontab', ['-l']);
    const kept = (current.ok ? current.out : '').split('\n').filter((l) => l && !l.includes(CRON_TAG));
    const r = run('crontab', ['-'], { input: [...kept, cronLine(opts)].join('\n') + '\n' });
    return r.ok ? { ok: true, how: 'cron' } : { ok: false, why: r.err };
  }
  if (process.platform === 'win32') {
    const action = `"${opts.nodeBin}" "${opts.script}" sync`;
    const r = run('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(opts.everyMinutes), '/TN', WIN_TASK, '/TR', action]);
    return r.ok ? { ok: true, how: 'Task Scheduler' } : { ok: false, why: r.err };
  }
  return { ok: false, why: `no scheduler support for ${process.platform}` };
}

export function removeSchedule() {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(plistFile())) return;
    run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    fs.rmSync(plistFile(), { force: true });
  } else if (process.platform === 'linux') {
    const current = run('crontab', ['-l']);
    if (current.ok && current.out.includes(CRON_TAG)) {
      const kept = current.out.split('\n').filter((l) => l && !l.includes(CRON_TAG));
      run('crontab', ['-'], { input: kept.length ? kept.join('\n') + '\n' : '' });
    }
  } else if (process.platform === 'win32') {
    run('schtasks', ['/Delete', '/F', '/TN', WIN_TASK]);
  }
}

export function scheduleInstalled() {
  if (process.platform === 'darwin') return fs.existsSync(plistFile()) && run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).ok;
  if (process.platform === 'linux') return run('crontab', ['-l']).out.includes(CRON_TAG);
  if (process.platform === 'win32') return run('schtasks', ['/Query', '/TN', WIN_TASK]).ok;
  return false;
}
