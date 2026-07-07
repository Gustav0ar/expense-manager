import { imageAttachmentCompressionTargetBytes, maxAttachmentBytes } from '$lib/attachment-limits';

type CompressionRequest = {
	file: File;
	maxBytes?: number;
	targetBytes?: number;
};

type CompressionResponse =
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

const worker = self as unknown as {
	postMessage(message: CompressionResponse): void;
	onmessage: ((event: MessageEvent<CompressionRequest>) => void) | null;
};
const outputType = 'image/jpeg';
const qualitySteps = [0.9, 0.84, 0.78, 0.72] as const;
const maxEdgeSteps = [2400, 2000, 1600, 1280] as const;

worker.onmessage = async (event: MessageEvent<CompressionRequest>) => {
	try {
		const response = await compressImage(event.data);
		worker.postMessage(response);
	} catch (err) {
		worker.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : 'Image compression failed.'
		} satisfies CompressionResponse);
	}
};

async function compressImage({
	file,
	maxBytes = maxAttachmentBytes,
	targetBytes = imageAttachmentCompressionTargetBytes
}: CompressionRequest): Promise<CompressionResponse> {
	if (typeof OffscreenCanvas === 'undefined') {
		throw new Error('Offscreen image compression is not available.');
	}

	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		const originalMaxEdge = Math.max(bitmap.width, bitmap.height);
		const candidates = uniqueMaxEdges(originalMaxEdge);
		let best: { blob: Blob; width: number; height: number; quality: number } | null = null;

		for (const maxEdge of candidates) {
			const { width, height } = scaledDimensions(bitmap.width, bitmap.height, maxEdge);
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw new Error('Could not prepare image compression.');

			context.fillStyle = '#ffffff';
			context.fillRect(0, 0, width, height);
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = 'high';
			context.drawImage(bitmap, 0, 0, width, height);

			for (const quality of qualitySteps) {
				const blob = await canvas.convertToBlob({ type: outputType, quality });
				if (!best || blob.size < best.blob.size) {
					best = { blob, width, height, quality };
				}
				if (blob.size <= targetBytes && blob.size < file.size) {
					return { ok: true, blob, width, height, quality };
				}
			}
		}

		if (!best) throw new Error('Image compression produced no output.');
		if (best.blob.size <= maxBytes || best.blob.size < file.size) {
			return {
				ok: true,
				blob: best.blob,
				width: best.width,
				height: best.height,
				quality: best.quality
			};
		}

		throw new Error('Image could not be compressed enough.');
	} finally {
		bitmap.close();
	}
}

function uniqueMaxEdges(originalMaxEdge: number) {
	return Array.from(
		new Set(
			[Math.min(originalMaxEdge, maxEdgeSteps[0]), ...maxEdgeSteps].filter((edge) => edge > 0)
		)
	).filter((edge) => edge <= originalMaxEdge);
}

function scaledDimensions(width: number, height: number, maxEdge: number) {
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}
