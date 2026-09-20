# Profile sources

The supported profile is a local editable file at ~/Library/Application Support/Shabang/profile.json. It is initially seeded with fictional demo data and can contain user facts plus optional local resume and cover-letter paths for supported upload flows.

The server also exposes a bounded resume-text extraction route for development. It is optional and does not create a cloud account, connector integration, or automatic source scan.

The codebase contains broader fact-extraction and cold-start experiments. They are not current product promises: Shabang does not presently ship a general connector-based fact graph, an options-page review flow, or automatic browsing/mail/calendar imports. Any future source must be opt-in, reviewed, locally stored, and filtered for sensitive information before use.

See [local data](storage.md) and [cold-start status](cold-start.md).
