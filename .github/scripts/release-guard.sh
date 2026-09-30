#!/usr/bin/env bash
# Release guard for master. Until 4.0 GA, master only ships 4.0.0-next.N prereleases under the npm
# dist-tag `next`, never `latest`. Exiting pre mode (`changeset pre exit`) therefore fails this guard
# until the GA pull request changes it on purpose.
#
#   release-guard.sh plan           Before changesets/action: pre mode is on, and the pending changesets
#                                   only produce 4.0.0-next.N versions.
#   release-guard.sh needs-publish  The version job, when no changesets are pending: runs the checks of
#                                   `publish` (without publishing), then writes needsPublish=true to
#                                   $GITHUB_OUTPUT when npm lacks a version that changesets would publish.
#   release-guard.sh publish        The publish job's publish script: pre mode is on, every publishable package
#                                   is at 4.0.0-next.N, changesets plans to publish them under `next`; then
#                                   it runs `changeset publish`.
set -euo pipefail

readonly PRE_TAG='next'
readonly VERSION_PATTERN='^4\.0\.0-next\.[0-9]+$'
readonly PLAN_ATTEMPTS=3

fail() {
	echo "::error::$*" >&2
	exit 1
}

tmp_dir() {
	if [ -n "${RUNNER_TEMP:-}" ]; then echo "$RUNNER_TEMP"; else mktemp -d; fi
}

check_pre_mode() {
	[ -f .changeset/pre.json ] || fail "master must be in changesets pre mode ('$PRE_TAG'), but .changeset/pre.json is missing."
	jq -e --arg tag "$PRE_TAG" '.mode == "pre" and .tag == $tag' .changeset/pre.json >/dev/null ||
		fail "master must be in changesets pre mode with the '$PRE_TAG' tag; .changeset/pre.json is $(jq -c . .changeset/pre.json)."
	echo "Pre mode: on, tag '$PRE_TAG'."
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
	[ -z "$bad" ] || fail "master only releases 4.0.0-next.N prereleases, but the pending changesets would release: $bad"
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
		[ "$attempt" -lt "$PLAN_ATTEMPTS" ] ||
			fail "'changeset publish-plan' failed $PLAN_ATTEMPTS times. Is the npm registry reachable? Re-run the job."
		echo "::warning::'changeset publish-plan' failed (attempt $attempt of $PLAN_ATTEMPTS); retrying."
		sleep $((attempt * 15))
	done
	jq -e '.version == 1 and (.plan | type == "array")' "$plan_file" >/dev/null ||
		fail "Unknown 'changeset publish-plan' format; update .github/scripts/release-guard.sh."
}

# Checks what `changeset publish` would do, and leaves the plan in $PLAN_FILE.
check_publish() {
	local bad

	# Every package changesets may publish: the workspace packages that are not private.
	bad=$(pnpm ls --recursive --depth -1 --json | jq -r --arg re "$VERSION_PATTERN" \
		'[.[] | select(.private != true) | select((.version // "") | test($re) | not) | "\(.name)@\(.version)"] | join(", ")')
	[ -z "$bad" ] || fail "master only publishes 4.0.0-next.N prereleases, but these packages are at: $bad"

	PLAN_FILE="$(tmp_dir)/publish-plan.json"
	write_publish_plan "$PLAN_FILE"
	bad=$(jq -r --arg tag "$PRE_TAG" --arg re "$VERSION_PATTERN" \
		'[.plan[][] | select(.kind == "publish") | select(.tag != $tag or ((.version // "") | test($re) | not)) | "\(.name)@\(.version) (tag \(.tag))"] | join(", ")' \
		"$PLAN_FILE")
	[ -z "$bad" ] || fail "master only publishes under the '$PRE_TAG' dist-tag, but changesets would publish: $bad"
	jq -r '.plan[][] | select(.kind == "publish") | "  publish \(.name)@\(.version) --tag \(.tag)"' "$PLAN_FILE"
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
	check_pre_mode
	check_plan
	;;
needs-publish)
	check_pre_mode
	check_publish
	report_needs_publish
	;;
publish)
	check_pre_mode
	check_publish
	exec pnpm exec changeset publish
	;;
*)
	fail "usage: release-guard.sh plan|needs-publish|publish"
	;;
esac
