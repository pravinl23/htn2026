# Real-world use boundary

Shabang’s implementation is built around macOS Accessibility APIs, but accessibility exposure and write behavior vary across applications. The local fictional demo in demo/ is the supported test surface.

## What is safe to claim

- Shabang is a native macOS prototype that can inspect accessible controls in the frontmost app.
- It can create conservative suggestions and, for supported controls, perform a verified value write after explicit acceptance.
- It does not activate locked actions such as submit, send, pay, delete, or confirm.
- It may decline to act when a control is sensitive, ambiguous, off-screen, custom, missing from the accessibility tree, or cannot be verified.

## What is not a release claim

Do not advertise universal browser or application support, unattended form completion, automatic submission, or reliable handling of every file uploader, custom dropdown, rich-text editor, canvas, or icon-only control. Those depend on the target app’s accessibility implementation and remain areas for validation.

The repository previously contained a named live-site rehearsal and related media. Treat those artifacts as historical debugging evidence, not an endorsement, integration, or repeatable support promise for that site.

## Test rule

Never run automated tests or harness scripts against a real form with a potential irreversible outcome. Rehearse against the local fictional demo, keep locks enabled, and inspect a write manually before claiming support for a new surface.
