import { spawn } from 'node:child_process';

const inheritedEnv = { ...process.env };
if (inheritedEnv.PLAYWRIGHT_PREBUILT !== 'true') await run('pnpm', ['build'], inheritedEnv);

const playwrightEnv = { ...inheritedEnv, PLAYWRIGHT_SKIP_WEB_SERVER_BUILD: 'true' };
for (const args of [
	['exec', 'playwright', 'test'],
	['exec', 'playwright', 'test', '--config', 'playwright.registration-lockdown.config.ts'],
	['exec', 'playwright', 'test', '--config', 'playwright.email-verification.config.ts']
]) {
	await run('pnpm', args, playwrightEnv);
}

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						signal
							? `${command} ${args.join(' ')} exited after signal ${signal}.`
							: `${command} ${args.join(' ')} exited with code ${code}.`
					)
				);
		});
	});
}
