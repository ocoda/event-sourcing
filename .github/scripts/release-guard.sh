#!/usr/bin/env bash
# Release guard for master. Since 4.0 GA, master only ships stable 4.x releases under the npm dist-tag `latest`:
# no prereleases, and no other major (a 5.0 needs a change to this guard). Entering changesets pre mode on master
# (`changeset pre enter`) therefore fails this guard until a pull request changes it on purpose.
#
#   release-guard.sh plan           Before changesets/action: master is not in pre mode (`.changeset/pre.json` is
#                                   missing, or in `exit` mode while the 4.0.0 version PR is pending), and the
#                                   pending changesets only produce stable 4.x versions.
#   release-guard.sh needs-publish  The version job, when no changesets are pending: runs the checks of
#                                   `publish` (without publishing), then writes needsPublish=true to
#                                   $GITHUB_OUTPUT when npm lacks a version that changesets would publish.
#   release-guard.sh publish        The publish job's publish script: `.changeset/pre.json` is gone, every
#                                   publishable package is at a stable 4.x version, changesets plans to publish them
#                                   under `latest`, and no dist-tag moves back to an older version; then it runs
#                                   `changeset publish`.
#
# Every registry lookup fails closed: a registry that stays unreachable fails the job instead of deciding what gets
# published.
set -euo pipefail
shopt -s inherit_errexit

readonly RELEASE_TAG='latest'
readonly VERSION_PATTERN='^4\.[0-9]+\.[0-9]+$'
readonly ATTEMPTS=3
# jq: a sort key with semver precedence. Numeric prerelease identifiers compare as numbers and below alphanumeric
# ones, and a release sorts above its prereleases. A version that is not semver yields nothing.
readonly SEMVER_KEY='def semver_key: capture("^(?<core>[0-9]+[.][0-9]+[.][0-9]+)(-(?<pre>[0-9A-Za-z.-]+))?([+].*)?$")
	| [(.core | split(".") | map(tonumber)),
		(if .pre == null then [1] else [0, (.pre | split(".") | map(if test("^[0-9]+$") then [0, tonumber] else [1, .] end))] end)];'

fail() {
	echo "::error::$*" >&2
	exit 1
}

tmp_dir() {
	if [ -n "${RUNNER_TEMP:-}" ]; then echo "$RUNNER_TEMP"; else mktemp -d; fi
}

# Before versioning: master is out of pre mode. `exit` mode is the 4.0 GA state, until the version PR deletes
# .changeset/pre.json.
check_not_in_pre_mode() {
	if [ ! -f .changeset/pre.json ]; then
		echo "Pre mode: off."
		return 0
	fi
	jq -e '.mode == "exit"' .changeset/pre.json >/dev/null ||
		fail "master releases stable 4.x versions under '$RELEASE_TAG' and must not be in changesets pre mode; .changeset/pre.json is $(jq -c . .changeset/pre.json). Entering pre mode needs a change to .github/scripts/release-guard.sh."
	echo "Pre mode: exiting (the version PR removes .changeset/pre.json)."
}

# Before publishing: no pre state at all, so a commit that is still in or exiting pre mode never publishes.
check_no_pre_state() {
	[ ! -f .changeset/pre.json ] ||
		fail "master only publishes once changesets pre mode is fully exited, but .changeset/pre.json is $(jq -c . .changeset/pre.json). Merge the version PR first."
	echo "Pre mode: off."
}

check_plan() {
	local status_file bad
	status_file="$(tmp_dir)/changeset-status.json"
	pnpm exec changeset status --output="$status_file"

	echo "Pending changesets: $(jq '.changesets | length' "$status_file")"
	jq -r '.releases[] | select(.type != "none") | "  \(.name): \(.type), \(.oldVersion) -> \(.newVersion)"' "$status_file"

	bad=$(jq -r --arg re "$VERSION_PATTERN" \
		'[.releases[] | select(.type != "none") | select((.newVersion // "") | test($re) | not) | "\(.name)@\(.newVersion)"] | join(", ")' \
		"$status_file")
	[ -z "$bad" ] || fail "master only releases stable 4.x versions, but the pending changesets would release: $bad"
}

# Writes changesets' publish plan to $1. changesets asks the registry which versions exist and exits non-zero on any
# answer but a 404, so a registry hiccup is retried, and a registry that stays unreachable fails the job rather than
# decide what gets published.
write_publish_plan() {
	local plan_file=$1 attempt
	for ((attempt = 1; ; attempt++)); do
		rm -f "$plan_file"
		if pnpm exec changeset publish-plan --output="$plan_file"; then
			break
		fi
		[ "$attempt" -lt "$ATTEMPTS" ] ||
			fail "'changeset publish-plan' failed $ATTEMPTS times. Is the npm registry reachable? Re-run the job."
		echo "::warning::'changeset publish-plan' failed (attempt $attempt of $ATTEMPTS); retrying."
		sleep $((attempt * 15))
	done
	jq -e '.version == 1 and (.plan | type == "array")' "$plan_file" >/dev/null ||
		fail "Unknown 'changeset publish-plan' format; update .github/scripts/release-guard.sh."
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

# Fails unless <version> is newer than the version that the dist-tag <tag> of <name> points at today, so re-running an
# older Release run can never move a dist-tag back.
check_not_behind() {
	local name=$1 version=$2 tag=$3 current
	current=$(npm_view "$name" "dist-tags.$tag")
	current=$(jq -r '. // empty' <<<"$current")
	if [ -z "$current" ]; then
		echo "  $name: no '$tag' dist-tag yet"
		return 0
	fi
	jq -en --arg new "$version" --arg current "$current" "$SEMVER_KEY"' ($new | semver_key) > ($current | semver_key)' \
		>/dev/null || fail "$name@$version is not newer than $current, the version of its '$tag' dist-tag, and publishing it would move that tag back. Is this a re-run of an older Release run?"
	echo "  $name: '$tag' moves from $current to $version"
}

# Checks what `changeset publish` would do, and leaves the plan in $PLAN_FILE.
check_publish() {
	local bad

	# Every package changesets may publish: the workspace packages that are not private.
	bad=$(pnpm ls --recursive --depth -1 --json | jq -r --arg re "$VERSION_PATTERN" \
		'[.[] | select(.private != true) | select((.version // "") | test($re) | not) | "\(.name)@\(.version)"] | join(", ")')
	[ -z "$bad" ] || fail "master only publishes stable 4.x versions, but these packages are at: $bad"

	PLAN_FILE="$(tmp_dir)/publish-plan.json"
	write_publish_plan "$PLAN_FILE"
	bad=$(jq -r --arg tag "$RELEASE_TAG" --arg re "$VERSION_PATTERN" \
		'[.plan[][] | select(.kind == "publish") | select(.tag != $tag or ((.version // "") | test($re) | not)) | "\(.name)@\(.version) (tag \(.tag))"] | join(", ")' \
		"$PLAN_FILE")
	[ -z "$bad" ] || fail "master only publishes stable 4.x versions under the '$RELEASE_TAG' dist-tag, but changesets would publish: $bad"
	jq -r '.plan[][] | select(.kind == "publish") | "  publish \(.name)@\(.version) --tag \(.tag)"' "$PLAN_FILE"

	local name version tag
	while read -r name version tag; do
		[ -n "$name" ] || continue
		check_not_behind "$name" "$version" "$tag"
	done < <(jq -r '.plan[][] | select(.kind == "publish") | "\(.name) \(.version) \(.tag)"' "$PLAN_FILE")
}

report_needs_publish() {
	local count needs=false
	count=$(jq '[.plan[][] | select(.kind == "publish")] | length' "$PLAN_FILE")
	[ "$count" -eq 0 ] || needs=true
	echo "Versions to publish: $count"
	echo "needsPublish=$needs" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
}

case "${1:-}" in
plan)
	check_not_in_pre_mode
	check_plan
	;;
needs-publish)
	check_no_pre_state
	check_publish
	report_needs_publish
	;;
publish)
	check_no_pre_state
	check_publish
	exec pnpm exec changeset publish
	;;
*)
	fail "usage: release-guard.sh plan|needs-publish|publish"
	;;
esac
