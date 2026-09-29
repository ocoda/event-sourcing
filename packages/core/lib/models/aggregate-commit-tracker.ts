/**
 * Internal bookkeeping of the last `markCommitted()` of an aggregate (the deprecated `commit()` calls it).
 *
 * This is intentionally kept outside of the aggregate instance (and not exported from the public entrypoint),
 * so it never leaks into the serialized aggregate, snapshots or the public types.
 */
export interface CommittedVersionRange {
	/**
	 * The version of the aggregate before the committed events were applied.
	 */
	fromVersion: number;
	/**
	 * The version of the aggregate after the committed events were applied.
	 */
	toVersion: number;
}

const lastCommits = new WeakMap<object, CommittedVersionRange>();

export const recordCommittedVersions = (aggregate: object, fromVersion: number, toVersion: number): void => {
	lastCommits.set(aggregate, { fromVersion, toVersion });
};

export const getCommittedVersions = (aggregate: object): CommittedVersionRange | undefined =>
	lastCommits.get(aggregate);
