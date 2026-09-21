<div align="center">

# ✨ Shabang

### Your next action, already waiting for you.

**A native macOS AI agent that understands the screen in front of you, suggests the next useful step, and learns from every choice you make.**

<p>
  <a href="#watch-it-work">Watch demos</a> ·
  <a href="#how-the-agent-works">How it works</a> ·
  <a href="#run-it-locally">Run locally</a>
</p>

</div>

---

## The idea

Shabang brings a Cursor-like suggestion experience to your whole Mac. It reads the accessible controls in the app you are using, finds the strongest next action, and draws a subtle ghost directly where that action belongs.

| You are doing | Shabang helps with |
| --- | --- |
| Filling out an application | Matching fields with your saved profile and preparing answers |
| Replying to a message | Drafting a concise reply in the compose box |
| Navigating a busy app | Highlighting the next useful field or control |
| Repeating a familiar task | Adapting suggestions from your accepted choices |

Press **Tab** to take a visible focused-field suggestion. Use a lone **right Command** tap for other suggested controls. **Escape** clears a suggestion, and ordinary typing naturally takes over.

## Watch it work

Every video below is stored in this repository. Use the player for a quick walkthrough or open a clip in full size.

### Messages: draft a reply in place

<video src="Messages.mp4" controls muted playsinline width="830">
  <a href="Messages.mp4">Watch the Messages demo</a>
</video>

Shabang recognizes the conversation context, prepares a reply, and presents it right in the message composer.

### LinkedIn: move through a form with prepared answers

<video src="Linkedin.mp4" controls muted playsinline width="830">
  <a href="Linkedin.mp4">Watch the LinkedIn demo</a>
</video>

A single batched AI decision maps the form to the profile facts Shabang already knows, so the next fields are ready as you move through them.

### OpenTable: a fast, focused interaction

<video src="OpenTable_Fast.mp4" controls muted playsinline width="830">
  <a href="OpenTable_Fast.mp4">Watch the OpenTable demo</a>
</video>

The ghost follows the current task, turning a multi-step interaction into a clear sequence of suggestions.

### The learning loop in Sentry

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Logs</strong><br><br>
      <video src="Sentry%20Logs.mp4" controls muted playsinline width="100%">
        <a href="Sentry%20Logs.mp4">Watch the Logs demo</a>
      </video>
    </td>
    <td width="50%" valign="top">
      <strong>Traces</strong><br><br>
      <video src="Sentry%20Traces.mp4" controls muted playsinline width="100%">
        <a href="Sentry%20Traces.mp4">Watch the Traces demo</a>
      </video>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Profiles</strong><br><br>
      <video src="Sentry%20Profiles.mp4" controls muted playsinline width="100%">
        <a href="Sentry%20Profiles.mp4">Watch the Profiles demo</a>
      </video>
    </td>
    <td width="50%" valign="top">
      <strong>App metrics</strong><br><br>
      <video src="Sentry%20App%20Metrics.mp4" controls muted playsinline width="100%">
        <a href="Sentry%20App%20Metrics.mp4">Watch the App Metrics demo</a>
      </video>
    </td>
  </tr>
</table>

These views make the agent loop visible: each outcome becomes a value-free product signal that helps the team measure suggestion quality, speed, and learning over time.

## How the agent works

Shabang keeps the interaction simple for the person using it while coordinating several focused layers behind the scenes.

```mermaid
flowchart LR
    A[Frontmost macOS app] --> B[Accessibility capture]
    B --> C[Local context and safety filter]
    C --> D[Rank likely next action]
    D --> E[Ghost overlay]
    E --> F{Your choice}
    F -->|Accept| G[Verified write or focused action]
    F -->|Dismiss or replace| H[Record outcome]
    G --> H
    H --> I[Local preference memory]

    C -. optional form mapping or text draft .-> J[Loopback AI service]
    J -. validated suggestion .-> D

    style A fill:#e8f0fe,stroke:#2563eb,color:#172554
    style E fill:#f3e8ff,stroke:#9333ea,color:#3b0764
    style F fill:#fef3c7,stroke:#d97706,color:#451a03
    style I fill:#dcfce7,stroke:#16a34a,color:#14532d
    style J fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
```

### 1. Understand the current screen

The desktop app reads the accessibility tree of the frontmost macOS app and turns eligible controls into structured context: fields, labels, roles, and nearby interaction cues.

### 2. Choose the best suggestion

The local ranking engine combines screen context, profile facts, learned preferences, and app-agnostic affordance roles. For a form, the optional local AI service makes one batched mapping decision. For a writing surface, it can stream a draft into the ghost.

### 3. Keep you in control

Shabang displays a suggestion in place and waits for your explicit input. It performs the narrowest supported write and verifies the result. Sensitive fields and high-impact actions remain thoughtfully guarded.

### 4. Learn from the outcome

Accepting, dismissing, or replacing a ghost creates a compact outcome signal. Local memory uses that signal to make future suggestions feel more personal, while the observability layer tracks aggregate product health through value-free signals.

## Built for a fast loop

```mermaid
sequenceDiagram
    participant You
    participant Shabang as Shabang desktop app
    participant Context as Local context
    participant AI as Local AI service
    participant Memory as Local memory

    Shabang->>Context: Capture accessible controls
    Context->>AI: Request one batched decision when useful
    AI-->>Shabang: Validated mapping or draft
    Shabang-->>You: Draw a ghost in context
    You->>Shabang: Accept, dismiss, or type
    Shabang->>Memory: Record the outcome
    Memory-->>Shabang: Refine future suggestions
```

The fast local path is always ready. AI adds focused form decisions and writing assistance through a loopback service at `127.0.0.1`, keeping provider credentials out of the desktop app.

## What powers Shabang

| Layer | Role |
| --- | --- |
| **Native desktop app** | Menu-bar experience, Accessibility capture, ghost rendering, keyboard interaction, and verified writes |
| **Shared TypeScript brain** | Field handling, local ranking, profile resolution, affordance roles, and preference memory |
| **Local Node.js service** | Batched form predictions, streamed text drafts, telemetry, and provider access |
| **TypeSafe Jev** | Typed, confidence-aware decisions for mapping form fields to profile facts |
| **Baseten** | Streaming text drafts and a flexible decision-provider path |
| **Sentry** | Logs, traces, metrics, profiles, and session replay for the agent learning loop |

## Run it locally

### What you need

- macOS 13 or later
- Node.js 22 or later
- pnpm 10 or later
- Xcode Command Line Tools
- Accessibility permission for Shabang

### Start the development experience

```bash
pnpm install
pnpm --filter @shabang/server dev
```

In a second terminal:

```bash
make -C desktop run
```

At first launch, enable **Shabang** in **System Settings → Privacy & Security → Accessibility**. The app appears in your menu bar once it is running.

### One-command install

```bash
./install.sh
```

The installer prepares dependencies, builds Shabang, places the app in `~/Applications`, guides the Accessibility setup, and verifies the installation. Use `./install.sh --check` for a read-only environment check or `./install.sh --update` after changing code.

### Useful checks

```bash
pnpm typecheck
pnpm test
pnpm desktop:test
pnpm test:terminal
```

## Explore the project

| Where to look | What you will find |
| --- | --- |
| [desktop/](desktop/README.md) | Native macOS app, setup, interaction model, and desktop commands |
| [shared/](shared/) | Core ranking, knowledge, form, and safety logic |
| [server/](server/) | Loopback service, providers, and observability integration |
| [demo/](demo/) | Local fictional surfaces for developing and rehearsing interactions |
| [terminal/](terminal/README.md) | Optional zsh command suggestion companion |
| [docs/](docs/README.md) | Architecture, data handling, learning loop, and technical notes |
| [SENTRY.md](SENTRY.md) | Observability story and live demo guide |

## A few details that matter

- **Local-first:** contextual ranking and preference memory live on the Mac.
- **App-agnostic:** Shabang works from accessible roles and labels rather than per-site scripts.
- **One decision, many fields:** a form is mapped in one batched request, then suggestions are ready as you move through it.
- **Purpose-built AI:** typed decisions choose the right fact, while a text model writes the right words.
- **Visible learning:** accepted and dismissed suggestions provide the feedback signal that makes the agent sharper over time.

<div align="center">

Built at Hack the North 2026 · **Shabang makes the next step feel obvious.**

</div>
