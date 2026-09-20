# Incremental form suggestions

Shabang makes a form walk incremental: it only shows a later proposal when the earlier state makes it safe and meaningful. The user still accepts each value deliberately.

Required fields are detected from accessible metadata and control state. A locked action is withheld until the necessary form state is satisfied; when it appears, the action remains locked and Shabang only parks the user there. The app does not press Submit, Send, Pay, Delete, or Confirm.

The native writer verifies supported writes before moving forward. When it cannot read back a change, it stops rather than continuing a walk on an uncertain state. This policy is implemented in the desktop controller/writer and shared form helpers, and is exercised against fictional local test surfaces.
