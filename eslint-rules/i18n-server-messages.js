/**
 * @param {any} node
 * @param {string} name
 */
function propertyNamed(node, name) {
	if (node.type !== 'Property' || node.computed) return false;
	return (
		(node.key.type === 'Identifier' && node.key.name === name) ||
		(node.key.type === 'Literal' && node.key.value === name)
	);
}

/** @param {any} property */
function isMessageProperty(property) {
	return propertyNamed(property, 'message');
}

/** @param {any} node */
function isStaticString(node) {
	return (
		(node.type === 'Literal' && typeof node.value === 'string') ||
		(node.type === 'TemplateLiteral' && node.expressions.length === 0)
	);
}

/** @param {any} node */
function enclosingCatchParameter(node) {
	let current = node.parent;
	while (current) {
		if (current.type === 'CatchClause') {
			return current.param?.type === 'Identifier' ? current.param.name : null;
		}
		current = current.parent;
	}
	return null;
}

/**
 * @param {any} node
 * @param {string} identifier
 */
function containsDirectMessageRead(node, identifier) {
	if (
		node.type === 'MemberExpression' &&
		!node.computed &&
		node.object.type === 'Identifier' &&
		node.object.name === identifier &&
		node.property.type === 'Identifier' &&
		node.property.name === 'message'
	) {
		return true;
	}

	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens') continue;
		if (Array.isArray(value)) {
			if (
				value.some(
					(child) =>
						child &&
						typeof child === 'object' &&
						'type' in child &&
						containsDirectMessageRead(child, identifier)
				)
			)
				return true;
		} else if (
			value &&
			typeof value === 'object' &&
			'type' in value &&
			containsDirectMessageRead(value, identifier)
		) {
			return true;
		}
	}

	return false;
}

export const requireTranslatedServerMessages = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Require user-facing SvelteKit server errors to use translated app messages.'
		},
		messages: {
			literal: 'Translate user-facing server messages instead of returning a string literal.',
			provider:
				'Do not return a caught provider error message. Map it to a stable translated app message.'
		},
		schema: []
	},
	/** @param {any} context */
	create(context) {
		return {
			/** @param {any} node */
			CallExpression(node) {
				if (node.callee.type !== 'Identifier') return;

				if (node.callee.name === 'error') {
					const message = node.arguments[1];
					if (message && message.type !== 'SpreadElement' && isStaticString(message)) {
						context.report({ node: message, messageId: 'literal' });
					}
					return;
				}

				if (node.callee.name !== 'fail') return;
				const data = node.arguments[1];
				if (!data || data.type !== 'ObjectExpression') return;
				const messageProperty = data.properties.find(isMessageProperty);
				if (!messageProperty || messageProperty.type !== 'Property') return;

				if (isStaticString(messageProperty.value)) {
					context.report({ node: messageProperty.value, messageId: 'literal' });
					return;
				}

				const catchParameter = enclosingCatchParameter(node);
				if (catchParameter && containsDirectMessageRead(messageProperty.value, catchParameter)) {
					context.report({ node: messageProperty.value, messageId: 'provider' });
				}
			}
		};
	}
};
