import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	throw redirect(303, '/login');
};
