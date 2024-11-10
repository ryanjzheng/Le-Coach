#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if azd_env=$(azd env get-values); then
  echo "Loading azd .env file from current environment"
  export $(echo "$azd_env" | xargs)
fi

echo 'Uploading PDF files to the ingestion API'
DATA_DIR="./data"
API_ENDPOINT="${INGESTION_API_URI:-http://localhost:3001}/documents"

# Check if data directory exists
if [ ! -d "$DATA_DIR" ]; then
    echo "Error: Data directory '$DATA_DIR' not found"
    exit 1
fi

# Find all PDF files in the data directory
PDF_COUNT=0
for pdf_file in "$DATA_DIR"/*.pdf; do
    if [ -f "$pdf_file" ]; then
        echo "Uploading: $(basename "$pdf_file")"
        curl -F "file=@$pdf_file" "$API_ENDPOINT"
        echo # Add newline after each curl response
        PDF_COUNT=$((PDF_COUNT + 1))
    fi
done

if [ $PDF_COUNT -eq 0 ]; then
    echo "No PDF files found in $DATA_DIR"
    exit 1
else
    echo "Successfully processed $PDF_COUNT PDF files"
fi