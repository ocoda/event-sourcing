const { getInfo } = require('@changesets/changelog-github');

const TAG_BY_RELEASE_TYPE = {
	major: '[major]',
	minor: '[minor]',
	patch: '[patch]',
};

async function getReleaseLine(changeset, type, options) {
	const [firstLine, ...restLines] = changeset.summary.split('\n');
	const info = await getInfo(changeset, type, options);
	const tag = TAG_BY_RELEASE_TYPE[type] ?? '[note]';
	const suffix = info ? ` (${info})` : '';
	const rest = restLines.length ? `\n${restLines.join('\n')}` : '';

	return `${tag} ${firstLine}${suffix}${rest}`;
}

async function getDependencyReleaseLine(changesets, dependenciesUpdated) {
	if (!dependenciesUpdated.length) {
		return '';
	}

	const updates = dependenciesUpdated.map((dep) => `  - ${dep.name}@${dep.newVersion}`).join('\n');

	return `\n### Dependencies\n${updates}\n`;
}

module.exports = {
	getReleaseLine,
	getDependencyReleaseLine,
};
