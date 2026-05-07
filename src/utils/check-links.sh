#!/bin/bash

# A simple script to check for broken links in the technical plan.

PLAN_FILE="../../TECHNICAL_PLAN.md"
URL_REGEX="https?://[^\")]+"

echo "🔍 Checking links in $PLAN_FILE..."

# Extract all URLs from the markdown file
urls=$(grep -oE "$URL_REGEX" "$PLAN_FILE" | sort -u)

if [ -z "$urls" ]; then
    echo "No URLs found."
    exit 0
fi

exit_code=0

for url in $urls; do
    # The sed command is to clean up potential trailing characters that are part of markdown syntax
    clean_url=$(echo "$url" | sed 's/)$//')

    # Use curl to check the status of the URL.
    # -s: silent mode
    # -o /dev/null: discard the output
    # -w "%{http_code}": print the HTTP status code
    # -L: follow redirects
    # --head: use a HEAD request to be faster and use less data
    status_code=$(curl -s -o /dev/null -w "%{http_code}" -L --head "$clean_url")

    if [ "$status_code" -ge 200 ] && [ "$status_code" -lt 400 ]; then
        echo "✅ [${status_code}] OK: ${clean_url}"
    else
        echo "❌ [${status_code}] FAILED: ${clean_url}"
        exit_code=1
    fi
done

echo "Done."
exit $exit_code
