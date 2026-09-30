#!/usr/bin/env bash
# Release guard for the 3.x maintenance line. 3.x only ships 3.x patch releases. Once 4.x is npm's `latest`,
# they go to the dist-tag `v3`, so a 3.x patch never moves `latest` back to 3.x.
#
#   release-guard.sh plan           Before changesets/action: the pending changesets are patches that stay on 3.x.
#   release-guard.sh needs-publish  The version job, when no changesets are pending: writes needsPublish=true to
#                                   $GITHUB_OUTPUT when npm lacks the version of a publishable package.
#   release-guard.sh dist-tag       The publish job: writes npmTag (`latest` while npm's `latest` is 3.x, else
#                                   `v3`) and githubLatest (whether the GitHub releases may become Latest).
#   release-guard.sh publish        The publish script: every publishable package is at 3.x, and RELEASE_NPM_TAG
#                                   is `v3`, or `latest` while npm's `latest` is still 3.x; then it runs
#                                   `changeset publish --tag "$RELEASE_NPM_TAG"`.
#
# Every registry lookup fails closed: a registry that stays unreachable fails the job instead of deciding what gets
# published or where.
set -euo pipefail
shopt -s inherit_errexit

readonly CORE_PACKAGE='@ocoda/event-sourcing'
readonly MAINTENANCE_TAG='v3'
readonly VERSION_PATTERN='^3\.[0-9]+\.[0-9]+$'
readonly ATTEMPTS=3

fail() {
	echo "::error::$*" >&2
	exit 1
}

set_output() {
	echo "$1" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
}

# Prints the JSON of `npm view --json <args>`, or `null` when npm doesn't know the package. Any other registry error
# is retried.
npm_view() {
	local out attempt
	for ((attempt = 1; ; attempt++)); do
		if out=$(npm view --json --prefer-online "$@"); then
			echo "${out:-null}"
			return 0
		fi
		if jq -e '.error.code == "E404"' <<<"$out" >/dev/null 2>&1; then
			echo null
			return 0
		fi
		[ "$attempt" -lt "$ATTEMPTS" ] || fail "'npm view $*' failed $ATTEMPTS times. Is the npm registry reachable? Re-run the job."
		echo "::warning::'npm view $*' failed (attempt $attempt of $ATTEMPTS); retrying." >&2
		sleep $((attempt * 15))
	done
}

# The major version of the core package's npm `latest` dist-tag.
latest_major() {
	local latest
	latest=$(npm_view "$CORE_PACKAGE" dist-tags.latest)
	latest=$(jq -r '. // empty' <<<"$latest")
	[[ "$latest" =~ ^([0-9]+)\. ]] || fail "Can't read the version of $CORE_PACKAGE's npm 'latest' dist-tag ('$latest')."
	echo "npm 'latest' of $CORE_PACKAGE: $latest" >&2
	echo "${BASH_REMATCH[1]}"
}

# Every package changesets may publish, as "name version" lines: the workspace packages that are not private.
publishable_packages() {
	local packages
	packages=$(pnpm ls --recursive --depth -1 --json)
	packages=$(jq -r '.[] | select(.private != true) | "\(.name) \(.version)"' <<<"$packages")
	[ -n "$packages" ] || fail "Found no publishable workspace package."
	echo "$packages"
}

check_plan() {
	local not_patch not_3x
	# Changesets 2 joins --output onto the working directory, even an absolute path, so the file stays relative.
	# It is removed again before changesets/action commits the working tree.
	pnpm exec changeset status --output=changeset-status.json || true
	if [ -f changeset-status.json ]; then
		# Only packages that are actually released are checked; private packages have type "none"
		# and no newVersion. Any jq error fails the step instead of silently passing the guard.
		jq -r '.releases[] | select(.type != "none") | "\(.name) \(.type) \(.newVersion)"' changeset-status.json
		not_patch=$(jq '[.releases[] | select(.type != "none" and .type != "patch")] | length' changeset-status.json)
		not_3x=$(jq '[.releases[] | select(.type != "none") | select((.newVersion // "") | startswith("3.") | not)] | length' changeset-status.json)
		if [ "$not_patch" -ne 0 ]; then
			fail "The 3.x maintenance line only accepts patch changesets."
		fi
		if [ "$not_3x" -ne 0 ]; then
			fail "3.x releases must stay on the 3.x major."
		fi
		rm -f changeset-status.json
	fi
}

check_versions() {
	local packages bad
	packages=$(publishable_packages)
	bad=$(awk -v re="$VERSION_PATTERN" '$2 !~ re { printf "%s%s@%s", sep, $1, $2; sep = ", " }' <<<"$packages")
	[ -z "$bad" ] || fail "3.x only publishes 3.x releases, but these packages are at: $bad"
}

report_needs_publish() {
	local packages name version versions count=0 needs=false
	packages=$(publishable_packages)
	while read -r name version; do
		versions=$(npm_view "$name" versions)
		# `npm view` prints a lone version as a string, and `null` stands for a package npm doesn't know.
		if jq -e --arg version "$version" '(. // []) | if type == "array" then . else [.] end | index($version) == null' \
			<<<"$versions" >/dev/null; then
			echo "  unpublished: $name@$version"
			count=$((count + 1))
		fi
	done <<<"$packages"
	[ "$count" -eq 0 ] || needs=true
	echo "Versions to publish: $count"
	set_output "needsPublish=$needs"
}

choose_dist_tag() {
	local major
	major=$(latest_major)
	if [ "$major" -ge 4 ]; then
		set_output "npmTag=$MAINTENANCE_TAG"
		set_output "githubLatest=false"
	else
		set_output "npmTag=latest"
		set_output "githubLatest=true"
	fi
}

check_dist_tag() {
	local major
	case "${RELEASE_NPM_TAG:-}" in
	"$MAINTENANCE_TAG") ;;
	latest)
		# Checked again right before publishing: 4.x may have become `latest` since the dist-tag was chosen.
		major=$(latest_major)
		[ "$major" -lt 4 ] ||
			fail "npm's 'latest' is 4.x or later now, so 3.x must publish under '$MAINTENANCE_TAG'. Re-run the workflow."
		;;
	*) fail "RELEASE_NPM_TAG must be 'latest' or '$MAINTENANCE_TAG', not '${RELEASE_NPM_TAG:-}'." ;;
	esac
	echo "Publishing under the npm dist-tag '$RELEASE_NPM_TAG'."
}

case "${1:-}" in
plan)
	check_plan
	;;
needs-publish)
	check_versions
	report_needs_publish
	;;
dist-tag)
	choose_dist_tag
	;;
publish)
	check_versions
	check_dist_tag
	exec pnpm exec changeset publish --tag "$RELEASE_NPM_TAG"
	;;
*)
	fail "usage: release-guard.sh plan|needs-publish|dist-tag|publish"
	;;
esac
