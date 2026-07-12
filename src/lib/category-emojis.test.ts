import { describe, expect, it } from 'vitest';
import { ptBrMessages } from './i18n/messages';
import { categoryEmojiLabels, categoryEmojiValues } from './category-emojis';

describe('category emoji labels', () => {
	it('has one localized label for every supported emoji', () => {
		expect(Object.keys(categoryEmojiLabels)).toEqual(categoryEmojiValues);
		for (const label of Object.values(categoryEmojiLabels)) {
			expect(ptBrMessages).toHaveProperty(label);
		}
	});
});
