#!/usr/bin/env bash
# Changeset check for pull requests into master (the `changesets` job in ci.yml).
#
# - A PR that changes what a published package ships (its lib/ sources, or the runtime fields of its package.json)
#   must add a changeset that releases at least one package. Exceptions: the `no-changeset` label (a maintainer
#   call), and the version PRs on changeset-release/* branches of this repository.
# - No changeset may release a package that is not published (private packages, unknown names).
#
# Environment: BASE_REF, HEAD_REF, HEAD_REPO, REPOSITORY, PR_NUMBER, GH_TOKEN (to read the PR's current labels, so a
# re-run sees a label added after the push). Needs the full history (checkout with fetch-depth: 0).
set -euo pipefail

readonly SKIP_LABEL='no-changeset'
# package.json fields that change what users install or load.
readonly RUNTIME_FIELDS='{dependencies, peerDependencies, peerDependenciesMeta, optionalDependencies, type, main, types, exports, engines}'
readonly PACKAGE_DIR_PATTERN='^packages/(core|integration/[^/]+)/'
# A frontmatter line: '@scope/name': patch (name and bump may be single-, double- or unquoted, as YAML allows; a
# trailing YAML comment is allowed too).
readonly RELEASE_LINE_PATTERN="^[[:space:]]*[\"']?([^\"':[:space:]]+)[\"']?[[:space:]]*:[[:space:]]*[\"']?([a-z]+)[\"']?[[:space:]]*(#.*)?$"
# A frontmatter line without a release: blank, or only a YAML comment.
readonly NO_RELEASE_LINE_PATTERN='^[[:space:]]*(#.*)?$'

errors=0
error() {
	echo "::error::$*"
	errors=$((errors + 1))
}

has_skip_label() {
	local labels
	if ! labels=$(gh api "repos/${REPOSITORY:?}/pulls/${PR_NUMBER:?}" --jq '.labels[].name'); then
		echo "::warning::Could not read the labels of PR #$PR_NUMBER."
		return 1
	fi
	grep -Fqx "$SKIP_LABEL" <<<"$labels"
}

base=$(git merge-base "origin/${BASE_REF:?}" HEAD)
echo "Comparing against the merge base with origin/$BASE_REF: $base"

# Published packages: the non-private manifests under packages/core and packages/integration/*.
declare -A published=()
for manifest in packages/core/package.json packages/integration/*/package.json; do
	name=$(jq -r 'select(.private != true) | .name // empty' "$manifest")
	if [ -n "$name" ]; then published["$name"]=1; fi
done
published_list=$(printf '%s\n' "${!published[@]}" | sort | paste -sd ' ' -)

# 1. Does the PR change what a published package ships?
reasons=()
while IFS= read -r file; do
	[ -n "$file" ] || continue
	if [[ $file =~ ${PACKAGE_DIR_PATTERN}lib/ ]]; then
		reasons+=("$file")
	elif [[ $file =~ ${PACKAGE_DIR_PATTERN}package\.json$ ]]; then
		before=$({ git show "$base:$file" 2>/dev/null || echo '{}'; } | jq -S "$RUNTIME_FIELDS")
		if [ -f "$file" ]; then after=$(jq -S "$RUNTIME_FIELDS" "$file"); else after=$(echo '{}' | jq -S "$RUNTIME_FIELDS"); fi
		if [ "$before" != "$after" ]; then reasons+=("$file (runtime fields)"); fi
	fi
done < <(git diff --name-only --no-renames "$base" HEAD)

# 2. Changesets the PR adds or edits (the ones in .changeset/pre/ are already versioned).
releasing_new=0
while IFS=$'\t' read -r status file; do
	[[ $file =~ ^\.changeset/[^/]+\.md$ ]] || continue
	[ "$file" != '.changeset/README.md' ] || continue

	frontmatter=$(tr -d '\r' <"$file" | awk 'NR == 1 { if ($0 != "---") exit 1; next } $0 == "---" { closed = 1; exit } { print } END { if (!closed) exit 1 }') ||
		{
			error "$file: no '---' frontmatter block, so it is not a changeset."
			continue
		}

	releases=0
	while IFS= read -r line; do
		[[ $line =~ $NO_RELEASE_LINE_PATTERN ]] && continue
		if [[ $line =~ $RELEASE_LINE_PATTERN ]]; then
			package="${BASH_REMATCH[1]}"
			bump="${BASH_REMATCH[2]}"
		else
			error "$file: cannot read the frontmatter line '$line'."
			continue
		fi
		if [ -z "${published[$package]:-}" ]; then
			error "$file releases '$package', which is not a published package. Published: $published_list."
		fi
		case "$bump" in
		major | minor | patch) releases=$((releases + 1)) ;;
		none) ;;
		*) error "$file: '$package' has the unknown bump type '$bump'." ;;
		esac
	done <<<"$frontmatter"

	echo "Changeset $file ($([ "$status" = A ] && echo added || echo edited)): releases $releases package(s)."
	if [ "$status" = A ] && [ "$releases" -gt 0 ]; then releasing_new=$((releasing_new + 1)); fi
done < <(git diff --name-status --no-renames --diff-filter=AM "$base" HEAD -- .changeset)

# 3. Require a changeset when the published packages change.
if [ "${#reasons[@]}" -eq 0 ]; then
	echo "No published package changes, so no changeset is required."
elif [ "$releasing_new" -gt 0 ]; then
	echo "Published packages change, and the PR adds $releasing_new changeset(s)."
elif [[ ${HEAD_REF:-} == changeset-release/* && ${HEAD_REPO:-} == "${REPOSITORY:-}" ]]; then
	echo "Version PR ($HEAD_REF): no new changeset required."
elif has_skip_label; then
	echo "::notice::Published packages change without a changeset; the '$SKIP_LABEL' label waives it."
else
	printf '  %s\n' "${reasons[@]}"
	error "This PR changes published packages (above) but adds no changeset. Run 'pnpm exec changeset' and commit the file. If users are not affected, ask a maintainer for the '$SKIP_LABEL' label, then re-run this job."
fi

if [ "$errors" -gt 0 ]; then exit 1; fi
