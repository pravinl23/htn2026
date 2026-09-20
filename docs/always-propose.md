# Suggest conservatively

The native app may rank an eligible next action even when its confidence is modest, but it does not turn every candidate into a visible or executable action. Safety filtering, visibility, accessibility support, ambiguity, and locked-action rules come first.

For a form, the app suggests only eligible non-sensitive values and advances after a verified accepted write. For a non-form action, it presents at most one accessible, visible candidate. A user can dismiss it, type instead, pause the app, or leave Tab to the foreground app. This is native desktop behavior; it is not an extension feature.
