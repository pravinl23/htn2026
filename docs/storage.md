# Local data

Shabang does not currently use one monolithic “brain” database. The desktop app creates a private support directory:

~~~text
~/Library/Application Support/Shabang/   mode 0700
~~~

The current files are written with private permissions and validated before use:

| File | Purpose |
| --- | --- |
| profile.json | User facts, optional resumePath / coverLetterPath, and legacy past answers. It is seeded with fictional demo data on first run. |
| settings.json | Enabled state, confidence threshold, local server URL, HUD, answer behavior, accept-key choice, and paused bundle identifiers. |
| answers.json | Bounded learned answers. Malformed entries are discarded instead of blocking the app. |
| memory.json | Role/action memory used by the native next-action path. |
| form-cache.json | Cached safe form-prediction assignments. |

The profile store watches changes and reloads valid updates rather than requiring a restart. Invalid JSON is ignored; it does not overwrite the last good in-memory state.

## Privacy properties

- The folder and state files are created with owner-only permissions.
- Sensitive controls and values are excluded before they become profile facts, learned answers, server requests, or normal logs.
- The app uses only the local support directory by default. It does not create a cloud account or synchronize this state.
- scripts/uninstall-background.sh --purge removes the support directory along with the installed configuration and logs. Inspect it with --dry-run first.

The remaining historical “ghost” names are internal server/terminal identifiers, not a second product or client.
