import type { User, Session } from 'better-auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			user?: User;
			session?: Session;
			requestId?: string;
			workspaceContext?: import('$lib/server/services/workspaces').WorkspaceContext | null;
			workspaceMemberships?: import('$lib/server/services/workspaces').WorkspaceMembership[];
		}

		interface Error {
			requestId?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
