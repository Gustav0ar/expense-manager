import {
	createPlaywrightDatabase,
	descriptorFromEnvironment,
	dropPlaywrightDatabase,
	migratePlaywrightDatabase
} from './database';

export default async function globalSetup() {
	const descriptor = descriptorFromEnvironment();
	try {
		await createPlaywrightDatabase(descriptor);
		await migratePlaywrightDatabase(descriptor);
	} catch (setupError) {
		await dropPlaywrightDatabase(descriptor).catch(() => undefined);
		throw setupError;
	}
}
