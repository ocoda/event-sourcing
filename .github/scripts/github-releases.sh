#!/usr/bin/env bash
# Creates the git tag and the GitHub release of every package that the release workflow published, in place of
# changesets/action (`create-github-releases: false`, `push-git-tags: false`). The action would hand its token to the
# whole publish process tree as GITHUB_TOKEN; this way only this script gets a token that may write contents. The
# releases match the action's: tag and title `<name>@<version>`, the version's CHANGELOG.md entry as notes, prerelease
# for a prerelease version. The stable release of the core, `@ocoda/event-sourcing` (4.0.0, say), becomes the
# repository's "Latest" release. The integrations, released in the same version, and every prerelease never do, so
# the order of the packages can't decide which release is Latest. A release that already exists is skipped, so a
# re-run is safe.
#
# Environment:
#   PUBLISHED_PACKAGES  changesets/action's `published-packages` output: [{"name": ..., "version": ...}]
#   GITHUB_SHA          the published commit, which the new tags point at
#   GH_TOKEN, GH_REPO   for gh: a token that may write contents, and the repository
set -euo pipefail
shopt -s inherit_errexit

readonly CORE_PACKAGE='@ocoda/event-sourcing'

fail() {
	echo "::error::$*" >&2
	exit 1
}

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

	if [[ "$version" == *-* ]]; then
		flags=(--prerelease --latest=false)
	elif [ "$name" = "$CORE_PACKAGE" ]; then
		flags=(--latest=true)
	else
		flags=(--latest=false)
	fi
	# --target makes GitHub create the tag, on the published commit, together with the release.
	gh release create "$tag" --target "$GITHUB_SHA" --title "$tag" --notes-file "$notes_file" "${flags[@]}"
	echo "$tag: created the tag and the GitHub release (${flags[*]})."
done <<<"$releases"
