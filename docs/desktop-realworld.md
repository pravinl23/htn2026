# Shabang Desktop real-world target: Greenhouse with Tab only

This document is a **future implementation and validation plan**, not a description of current behavior.

## Current boundary (updated 2026-09-19 14:40 EDT)

Implemented and unit-tested (199 native tests):

- macOS Accessibility trust handling and bounded AX-tree capture; sensitive/hidden/disabled exclusion; stable signatures;
- offline form mapping plus server-upgraded `/v1/predict/form`; streamed `/v1/shabang-text` drafts; ghost overlays; Tab/Escape/hold-Tab state; locks; verified writes; local profile/settings/form cache; menu-bar app;
- **stable host + hot-swappable `libshabang.dylib`** (`desktop/host/main.m`, `make host`, `make lib`, `make install-lib`). The granted host is `~/Applications/Shabang.app`; rebuild only the library;
- **harness**: `desktop/tools/shabangctl trust | dump | dump-tree | autotab N | run | quit | log | selftest` with `--frontmost`, `--delay`, `--out`;
- a fictional resume PDF at `demo/fixtures/resume-alex-chen.pdf`;
- a redacted real AX fixture: `desktop/tests/fixtures/greenhouse-safari-viam.json` (Safari, Viam Greenhouse posting).

Verified LIVE: `shabangctl trust` and `shabangctl dump-tree` run trusted against the real Greenhouse page in Safari (433 nodes, about 0.5 s).

Not implemented yet:

- real-page capture: `shabangctl dump` finds only 1 bogus field, because the tree walk skips `AXTabGroup` and Safari nests the web area inside it;
- resume/cover-letter file facts and native open-panel automation;
- react-select comboboxes (options are not in the AX tree until opened);
- a recorded end-to-end run in any browser.

The server now exposes `/v1/presence`; the extension heartbeat is not wired yet, so disable the Chrome extension before trying Desktop in Chrome.

## Target smoke test

On a real Greenhouse job application, Shabang should eventually fill supported personal fields, choose only high-confidence dropdown answers, draft essay answers, skip EEO/demographic questions, optionally attach the fictional resume, and stop parked on **Submit application** with a lock. The user should not need the mouse for supported fields.

Non-negotiable rules:

- Tab never activates Submit; only an explicit human Enter/click may submit.
- Automated or agent-driven real-site runs never submit.
- EEO/demographic questions are left alone.
- Password, government-ID and payment fields are never captured.
- A write or option choice that cannot be verified stops the walk.

## Work required before claiming the target

1. **Preserve Accessibility permission across development.** Implement and test a stable signed host with an external hot-swappable library, or adopt another signing/deployment approach that avoids re-granting after every build.
2. **Build an agent-drivable diagnostic harness.** Add redacted AX-tree dumping and safe auto-Tab support that stops at locks and never posts Enter.
3. **Capture real fixtures.** Save redacted AX structures from Greenhouse in at least Safari and Chrome, then add regression fixtures for capture, dropdowns and ordering.
4. **Handle real comboboxes.** Open options lazily, select only an exact/high-confidence match and verify the displayed value. Close and skip on ambiguity.
5. **Implement file upload safely.** Validate a fictional local resume path, drive only the expected open panel, verify the filename on the page and abort on any focus mismatch.
6. **Run the safety rehearsal.** With a throwaway application and no submission, repeat the full walk three times in each claimed browser and record which controls were supported or skipped.

## File-upload target contract

If implemented, an upload ghost may use an absolute `resumePath`/`coverLetterPath` that exists and is readable, displaying only the filename. Accepting it may press the page's attach control, but it must type the path only while the focused element is the macOS open panel's go-to field. Any unexpected window, focus change or user keypress aborts the operation. Success requires both the panel closing and the page showing the expected filename.

## Real combobox target contract

For react-select/location controls, focus and type the intended option, wait for the exposed listbox, choose only an exact or high-confidence shared `matchOption` result, and verify the committed display value. If no option clears the threshold, close the list and skip the field. Phone/date controls receive the same write-then-verify rule.

## Definition of done

- The implemented files and Make targets match this document.
- Redacted real-browser fixtures cover the controls claimed in the demo.
- Automated tests prove no Return/Enter can reach a locked target and no path can be typed outside the expected open panel.
- Three non-submitting live rehearsals succeed in every browser named in the README.
- A fallback recording exists.

Until then, use the local `/apply` demo as the verified form walkthrough and describe Desktop as a tested native prototype, not a completed real-world Greenhouse agent.
