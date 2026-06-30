import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import {
	attachmentContentDisposition,
	getAttachmentForDownload
} from '$lib/server/services/attachments';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { idSchema } from '$lib/server/validation';

export const GET: RequestHandler = async (event) => {
	const context = await requireWorkspaceContext(event);
	const id = idSchema.safeParse(event.params.id);
	if (!id.success) throw error(404, 'Anexo nao encontrado.');
	const attachment = await getAttachmentForDownload(context, id.data);

	return new Response(attachment.stream, {
		headers: {
			'content-type': attachment.contentType,
			'content-length': String(attachment.contentLength),
			'content-disposition': attachmentContentDisposition(attachment.originalName),
			'cache-control': 'private, max-age=60'
		}
	});
};
