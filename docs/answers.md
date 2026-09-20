# Form-answer policy

Shabang proposes form values from the local profile and shared answer logic. It is deliberately conservative: an unavailable, sensitive, ambiguous, or unverified answer is safer to skip than to invent.

## Sources and precedence

The desktop app starts with the local profile and local learned-answer store. A user’s direct correction is stronger than a generic profile mapping. The optional server receives fact keys and safe field metadata for batched mapping; it does not receive profile values for ordinary form prediction.

For a select or radio group, a proposed value must match an option presented by the control. When an ordinary question has no supported answer, the shared logic may choose a neutral option actually offered by the UI (for example, “Other”); it does not invent a response.

## Protected questions

Sensitive controls are excluded before answer selection. The shared classifier treats demographic, medical, legal declaration, financial, password, government-ID, and similar categories specially. Protected questions are not answered with a made-up personal claim. Settings can control whether a supported decline option is proposed where the UI offers one.

## Verification and user control

An answer becomes a real write only after explicit acceptance. The desktop writer checks the result where the target exposes a readable value. Typing your own answer wins, Escape dismisses a proposal, and locked actions stay locked. A rejected proposal can improve the bounded local answer memory; it does not trigger automatic model retraining.

## Current scope

This document describes the native desktop path. There is no browser-extension storage or options-page implementation in the supported product.
