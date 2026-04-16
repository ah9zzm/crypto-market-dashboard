import { spawn } from 'node:child_process';
import readline from 'node:readline';

const processes = [
  { name: 'api', args: ['run', 'dev:api'] },
  { name: 'web', args: ['run', 'dev:web'] },
  { name: 'worker', args: ['run', 'dev:worker'] },
];

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function prefixStream(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    target.write(`[${label}] ${line}\n`);
  });
  return rl;
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
  }

  child.kill('SIGTERM');
  return Promise.resolve();
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  process.exitCode = exitCode;
  await Promise.all(children.map((child) => killChild(child)));
  setTimeout(() => process.exit(process.exitCode ?? exitCode), 250).unref();
}

for (const proc of processes) {
  const child = spawn(npmCommand, proc.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  children.push(child);
  prefixStream(child.stdout, proc.name, process.stdout);
  prefixStream(child.stderr, proc.name, process.stderr);

  child.once('error', async (error) => {
    console.error(`[${proc.name}] failed to start: ${error.message}`);
    await shutdown(1);
  });

  child.once('close', async (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (signal) {
      console.error(`[${proc.name}] exited with signal ${signal}`);
    } else if (code !== 0) {
      console.error(`[${proc.name}] exited with code ${code}`);
    } else {
      console.error(`[${proc.name}] exited`);
    }

    await shutdown(code ?? 1);
  });
}

process.on('SIGINT', async () => {
  await shutdown(0);
});

process.on('SIGTERM', async () => {
  await shutdown(0);
});
