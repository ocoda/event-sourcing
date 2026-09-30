#!/usr/bin/env bash
# Creates the git tag and the GitHub release of every package that the 3.x release workflow published, in place of
# changesets/action v1 (`createGithubReleases: false`). Unlike the action, it can create a release that does not
# become the repository's "Latest" release: once 4.x is npm's `latest`, a 3.x patch leaves the 4.x release marked
# Latest. The releases match the action's: tag and title `<name>@<version>`, the version's CHANGELOG.md entry as
# notes, prerelease for a prerelease version. A release that already exists is skipped, so a re-run is safe.
#
# Environment:
#   PUBLISHED_PACKAGES  changesets/action's `publishedPackages` output: [{"name": ..., "version": ...}]
#   GITHUB_LATEST       true or false, from `release-guard.sh dist-tag`
#   GITHUB_SHA          the published commit, which the new tags point at
#   GH_TOKEN, GH_REPO   for gh: a token that may write contents, and the repository
set -euo pipefail
shopt -s inherit_errexit

fail() {
	echo "::error::$*" >&2
	exit 1
}

case "${GITHUB_LATEST:-}" in
true | false) ;;
*) fail "GITHUB_LATEST must be 'true' or 'false', not '${GITHUB_LATEST:-}'." ;;
esac
: "${GITHUB_SHA:?}" "${GH_REPO:?}" "${PUBLISHED_PACKAGES:?}"

releases=$(jq -r '.[] | "\(.name) \(.version)"' <<<"$PUBLISHED_PACKAGES")
workspace=$(pnpm ls --recursive --depth -1 --json)
notes_file=$(mktemp)

while read -r name version; do
	[ -n "$name" ] || continue
	tag="$name@$version"
	if gh release view "$tag" >/dev/null 2>&1; then
		echo "$tag: the GitHub release exists already."
		continue
	fi

	# Only published packages: the private workspace root is called @ocoda/event-sourcing too.
	dir=$(jq -r --arg name "$name" '[.[] | select(.private != true and .name == $name) | .path] | if length == 1 then .[0] else empty end' <<<"$workspace")
	[ -n "$dir" ] || fail "$tag: found no single publishable workspace package called $name."
	# The version's section: from its `## <version>` heading up to the next heading of level 1 or 2.
	awk -v heading="## $version" '
		$0 == heading { found = 1; next }
		!found || (!started && /^[[:space:]]*$/) { next }
		/^##? / { exit }
		{ started = 1; print }
	' "$dir/CHANGELOG.md" >"$notes_file"
	grep -q '[^[:space:]]' "$notes_file" || fail "$tag: $dir/CHANGELOG.md has no entry for $version."

	flags=(--latest="$GITHUB_LATEST")
	[[ "$version" != *-* ]] || flags+=(--prerelease)
	# --target makes GitHub create the tag, on the published commit, together with the release.
	gh release create "$tag" --target "$GITHUB_SHA" --title "$tag" --notes-file "$notes_file" "${flags[@]}"
	echo "$tag: created the tag and the GitHub release (Latest: $GITHUB_LATEST)."
done <<<"$releases"
