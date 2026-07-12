import { descriptorFromEnvironment, dropPlaywrightDatabase } from './database';

export default async function globalTeardown() {
	await dropPlaywrightDatabase(descriptorFromEnvironment());
}
