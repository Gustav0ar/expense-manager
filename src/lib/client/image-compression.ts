import {
	imageAttachmentCompressionThresholdBytes,
	imageAttachmentCompressionTargetBytes,
	maxAttachmentBytes
} from '$lib/attachment-limits';

export { maxAttachmentBytes as maxImageAttachmentBytes };

export type ImageCompressionResult = {
	file: File;
	originalSize: number;
	compressedSize: number;
	compressed: boolean;
};

type WorkerResponse =
	| {
			ok: true;
			blob: Blob;
			width: number;
			height: number;
			quality: number;
	  }
	| {
			ok: false;
			error: string;
	  };

const compressibleImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const compressedImageType = 'image/jpeg';

export function isCompressibleImage(file: File) {
	return compressibleImageTypes.has(file.type.toLowerCase());
}

export function shouldCompressImageAttachment(file: File) {
	return isCompressibleImage(file) && file.size > imageAttachmentCompressionThresholdBytes;
}

export function compressedImageFileName(name: string) {
	const trimmed = name.trim();
	const base = trimmed.replace(/\.[^./\\]+$/, '') || 'attachment';
	return `${base}.jpg`;
}

export function formatFileSize(bytes: number) {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function compressImageAttachment(
	file: File,
	options: { signal?: AbortSignal } = {}
): Promise<ImageCompressionResult> {
	if (!shouldCompressImageAttachment(file)) {
		return {
			file,
			originalSize: file.size,
			compressedSize: file.size,
			compressed: false
		};
	}

	const response = await compressInWorker(file, options.signal);
	if (!response.ok) throw new Error(response.error);

	if (response.blob.size >= file.size) {
		return {
			file,
			originalSize: file.size,
			compressedSize: file.size,
			compressed: false
		};
	}

	const compressedFile = new File([response.blob], compressedImageFileName(file.name), {
		type: response.blob.type || compressedImageType,
		lastModified: file.lastModified
	});

	return {
		file: compressedFile,
		originalSize: file.size,
		compressedSize: compressedFile.size,
		compressed: true
	};
}

async function compressInWorker(file: File, signal?: AbortSignal) {
	if (signal?.aborted) throw abortError();
	if (typeof Worker === 'undefined') throw new Error('Image compression is not available.');

	const worker = new Worker(new URL('./image-compression.worker.ts', import.meta.url), {
		type: 'module'
	});

	return await new Promise<WorkerResponse>((resolve, reject) => {
		const cleanup = () => {
			signal?.removeEventListener('abort', abort);
			worker.terminate();
		};
		const abort = () => {
			cleanup();
			reject(abortError());
		};

		signal?.addEventListener('abort', abort, { once: true });
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			cleanup();
			resolve(event.data);
		};
		worker.onerror = (event) => {
			cleanup();
			reject(event.error instanceof Error ? event.error : new Error(event.message));
		};
		worker.postMessage({
			file,
			maxBytes: maxAttachmentBytes,
			targetBytes: imageAttachmentCompressionTargetBytes
		});
	});
}

function abortError() {
	return new DOMException('Image compression was aborted.', 'AbortError');
}
