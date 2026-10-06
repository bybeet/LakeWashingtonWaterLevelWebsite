#!/usr/bin/env bash
# Upload the site files to the S3 bucket that also holds the live data.csv.
#
#   ./deploy.sh            upload index.html, app.js, styles.css, favicon.svg
#   ./deploy.sh --dry-run  show what would be uploaded
#
# Only the files in SITE_FILES are ever uploaded. data.csv in the bucket is
# written by the scraper and is never touched here.
set -euo pipefail

BUCKET="lake-washington-water-level-823580404672"
REGION="us-west-2"
SITE_FILES=(index.html app.js styles.css favicon.svg)

DRYRUN=""
case "${1:-}" in
  "") ;;
  --dry-run) DRYRUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")"

for f in "${SITE_FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "AWS credentials missing or expired. Run 'aws login' and try again." >&2
  exit 1
fi

# The page loads data.csv from next to index.html, so warn if it isn't there.
if ! aws s3api head-object --bucket "$BUCKET" --key data.csv --region "$REGION" >/dev/null 2>&1; then
  echo "warning: s3://$BUCKET/data.csv not found; the page will show a load error until it exists." >&2
fi

content_type() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.js)   echo "text/javascript; charset=utf-8" ;;
    *.css)  echo "text/css; charset=utf-8" ;;
    *.svg)  echo "image/svg+xml" ;;
  esac
}

# Files aren't fingerprinted, so make browsers revalidate on every load
# (a cheap 304 when unchanged) so a deploy shows up immediately.
for f in "${SITE_FILES[@]}"; do
  aws s3 cp "$f" "s3://$BUCKET/$f" \
    --region "$REGION" \
    --content-type "$(content_type "$f")" \
    --cache-control "no-cache" \
    ${DRYRUN:+--dryrun}
done

if [[ -z "$DRYRUN" ]]; then
  echo "Deployed ${SITE_FILES[*]} to s3://$BUCKET/"
fi
