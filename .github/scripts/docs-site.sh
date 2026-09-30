#!/usr/bin/env bash
# Helpers of the CD Docs workflow, which publishes one GitHub Pages site: the 4.x docs (Starlight, docs/ on master)
# at https://ocoda.github.io/event-sourcing/ and the 3.x docs (Nextra, docs/ on the 3.x branch) under /v3/.
#
#   docs-site.sh patch-v3 <docs dir>   Prepares a checkout of the 3.x docs for /event-sourcing/v3/: sets Next.js's
#                                      basePath and assetPrefix, points the "Edit this page" links at the 3.x branch,
#                                      and adds a banner that links to the 4.x docs. Fails when a file no longer
#                                      has the line it expects, so a change on 3.x can't silently break the build.
#   docs-site.sh clean-v3 <out dir>    Removes the files of the 3.x export that only make sense at the root of a
#                                      site (robots.txt, the sitemaps), which the 4.x site provides.
#   docs-site.sh check <site dir>      Checks the assembled site: both home pages exist, and every root-relative
#                                      src and href in its HTML resolves to a file, with the 3.x pages staying
#                                      under /v3/.
set -euo pipefail
shopt -s inherit_errexit

readonly BASE='/event-sourcing'
readonly V3_BASE="$BASE/v3"

fail() {
	echo "::error::$*" >&2
	exit 1
}

# Replaces the one occurrence of a literal string in a file, or fails.
replace_once() {
	local file=$1 search=$2 replacement=$3
	[ -f "$file" ] || fail "$file is missing."
	SEARCH=$search REPLACEMENT=$replacement node - "$file" <<'JS'
const fs = require('node:fs');
const file = process.argv[2];
const { SEARCH: search, REPLACEMENT: replacement } = process.env;
const text = fs.readFileSync(file, 'utf8');
const count = text.split(search).length - 1;
if (count !== 1) {
	console.error(`::error::${file}: expected one occurrence of ${JSON.stringify(search)}, found ${count}.`);
	process.exit(1);
}
fs.writeFileSync(file, text.replace(search, () => replacement));
JS
}

patch_v3() {
	local dir=${1:?usage: docs-site.sh patch-v3 <docs dir>}

	# next.config.mjs derives basePath (/<repo>) and assetPrefix (/<repo>/) from this name when GITHUB_PAGES is set.
	replace_once "$dir/next.config.mjs" "const repo = 'event-sourcing';" "const repo = 'event-sourcing/v3';"

	replace_once "$dir/theme.config.tsx" \
		"docsRepositoryBase: 'https://github.com/ocoda/event-sourcing/tree/master/docs'," \
		"docsRepositoryBase: 'https://github.com/ocoda/event-sourcing/tree/3.x/docs',"

	# A plain <a>: the link leaves the Next.js app, whose basePath is /event-sourcing/v3.
	replace_once "$dir/theme.config.tsx" "const config: DocsThemeConfig = {" "const config: DocsThemeConfig = {
	banner: {
		key: 'ocoda-docs-v3',
		dismissible: false,
		content: <a href=\"$BASE/\">You are reading the documentation of 3.x. Read the 4.x documentation →</a>,
	},"
	echo "Patched $dir for $V3_BASE."
}

clean_v3() {
	local out=${1:?usage: docs-site.sh clean-v3 <out dir>}
	[ -f "$out/index.html" ] || fail "$out/index.html is missing: is $out the export of the 3.x docs?"
	rm -f "$out/robots.txt" "$out"/sitemap*.xml
	echo "Removed the root-only files from $out."
}

# Prints the file that GitHub Pages serves for a URL path of the site, or nothing.
served_file() {
	local site=$1 path=$2 rel
	rel=${path#"$BASE"}
	rel=${rel#/}
	if [ -z "$rel" ] || [[ "$rel" == */ ]]; then
		[ -f "$site/${rel}index.html" ] && echo "$site/${rel}index.html"
		return 0
	fi
	if [ -f "$site/$rel" ]; then
		echo "$site/$rel"
	elif [ -f "$site/$rel.html" ]; then
		echo "$site/$rel.html"
	elif [ -f "$site/$rel/index.html" ]; then
		echo "$site/$rel/index.html"
	fi
	return 0
}

check_site() {
	local site=${1:?usage: docs-site.sh check <site dir>} errors=0 checked=0 file url path
	[ -f "$site/index.html" ] || fail "$site/index.html is missing: the 4.x docs are not at the root."
	[ -f "$site/v3/index.html" ] || fail "$site/v3/index.html is missing: the 3.x docs are not under /v3/."
	grep -q "href=\"$BASE/\"" "$site/v3/index.html" || fail "The 3.x home page has no link to the 4.x docs ($BASE/)."
	grep -q "value=\"$V3_BASE/\"" "$site/index.html" || fail "The 4.x home page has no link to the 3.x docs ($V3_BASE/)."

	# Next.js loads its chunks from <assetPrefix>/_next/; a 3.x file that names /event-sourcing/_next/ was built
	# without the /v3 base path.
	if grep -rlF "$BASE/_next/" "$site" >/dev/null; then
		grep -rlF "$BASE/_next/" "$site" | head -5 >&2
		fail "These files load Next.js assets from $BASE/_next/ instead of $V3_BASE/_next/."
	fi

	while IFS= read -r -d '' file; do
		while IFS= read -r url; do
			path=${url%%[?#]*}
			checked=$((checked + 1))
			if [[ "$file" == "$site/v3/"* ]] && [[ "$path" != "$V3_BASE/"* ]] && [ "$path" != "$V3_BASE" ] &&
				[ "$path" != "$BASE/" ]; then
				echo "::error::${file#"$site/"}: $url leaves the 3.x docs." >&2
				errors=$((errors + 1))
			elif [ -z "$(served_file "$site" "$path")" ]; then
				echo "::error::${file#"$site/"}: nothing is served at $url." >&2
				errors=$((errors + 1))
			fi
		done < <(grep -oE "(src|href)=\"$BASE/[^\"]*\"" "$file" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
	done < <(find "$site" -name '*.html' -print0)

	[ "$errors" -eq 0 ] || fail "$errors of the $checked root-relative links and assets of the site don't resolve."
	echo "Checked $checked root-relative links and assets: all resolve, and the 3.x docs stay under $V3_BASE/."
}

case "${1:-}" in
patch-v3) patch_v3 "${2:-}" ;;
clean-v3) clean_v3 "${2:-}" ;;
check) check_site "${2:-}" ;;
*) fail "usage: docs-site.sh patch-v3 <docs dir> | clean-v3 <out dir> | check <site dir>" ;;
esac
