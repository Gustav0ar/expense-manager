import { describe, expect, it } from 'vitest';
import { imageAttachmentCompressionThresholdBytes } from '$lib/attachment-limits';
import {
	compressedImageFileName,
	formatFileSize,
	isCompressibleImage,
	shouldCompressImageAttachment
} from './image-compression';

describe('image attachment compression helpers', () => {
	it('detects only image types supported by the browser compressor', () => {
		expect(isCompressibleImage(new File(['x'], 'receipt.jpg', { type: 'image/jpeg' }))).toBe(true);
		expect(isCompressibleImage(new File(['x'], 'receipt.png', { type: 'image/png' }))).toBe(true);
		expect(isCompressibleImage(new File(['x'], 'receipt.txt', { type: 'text/plain' }))).toBe(false);
	});

	it('compresses only images above the threshold', () => {
		expect(
			shouldCompressImageAttachment(
				new File([new Uint8Array(imageAttachmentCompressionThresholdBytes + 1)], 'large.png', {
					type: 'image/png'
				})
			)
		).toBe(true);
		expect(
			shouldCompressImageAttachment(new File(['small'], 'small.png', { type: 'image/png' }))
		).toBe(false);
	});

	it('normalizes compressed image names to jpeg', () => {
		expect(compressedImageFileName('receipt.png')).toBe('receipt.jpg');
		expect(compressedImageFileName('receipt.final.webp')).toBe('receipt.final.jpg');
		expect(compressedImageFileName('')).toBe('attachment.jpg');
	});

	it('formats attachment sizes for upload feedback', () => {
		expect(formatFileSize(1536)).toBe('2 KB');
		expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
	});
});
