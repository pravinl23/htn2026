# Cold-start scan

The repository contains shared extraction and ranking utilities plus a native cold-start helper. This is an experimental local feature, not a prerequisite for using Shabang and not a broad data-collection promise.

The intended model is explicit local review: inspect a limited local source, produce proposals, filter sensitive material before storage, and let the user decide what to keep. The implementation intentionally does not make remote connectors, cloud sync, or background ingestion part of the supported desktop product.

## Boundaries

- No scan should silently read a source that needs a separate macOS permission.
- Sensitive documents, credentials, government IDs, payment data, health data, and likely secrets must be dropped before they become proposals.
- Temporary copies of browser-history databases are treated as transient working data and removed by the helper.
- A scan must be understandable, bounded, cancelable, and reviewable before it is exposed as a user feature.

The desktop profile can be edited directly today. Treat any broader cold-start or source-inventory capability as experimental until it has a complete consent and review surface.
