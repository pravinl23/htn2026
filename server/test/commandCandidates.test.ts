import { describe, expect, it } from "vitest";
import { buildCandidates, cleanRequest, contextMoves, cwdBasename, MAX_CANDIDATES, pickHeuristic, type CommandRequest, type GitSummary } from "../src/command/candidates";

const GIT: GitSummary = { branch: "main", dirty: false, ahead: 0, behind: 0, untracked: 0 };
const candidates = (req: Partial<CommandRequest>) => buildCandidates(cleanRequest({ cwd: "ghost", history: [], ...req }));
const commands = (req: Partial<CommandRequest>) => candidates(req).map((c) => c.command);

describe("n-gram over the history", () => {
  const history = ["pnpm build", "pnpm test", "git status", "pnpm build", "pnpm test", "pnpm build", "pnpm lint", "vim README.md", "pnpm build"];

  it("ranks what followed the last command first, by count", () => {
    const [first, second] = candidates({ history });
    expect(first).toMatchObject({ command: "pnpm test", bigram: 2, sources: expect.arrayContaining(["ngram", "recent"]) });
    expect(second).toMatchObject({ command: "pnpm lint", bigram: 1 });
  });

  it("adds trigram agreement when the two last commands repeat", () => {
    const tri = candidates({ history: ["git add -A", "git commit -m wip", "git push", "git add -A", "git commit -m wip"] });
    expect(tri[0]).toMatchObject({ command: "git push", bigram: 1, trigram: 1, ngram: 2 });
  });

  it("breaks count ties by recency", () => {
    const tie = candidates({ history: ["make", "make test", "make", "make lint", "make"] });
    expect(tie.slice(0, 2).map((c) => c.command)).toEqual(["make lint", "make test"]);
  });
});

describe("context moves", () => {
  it("git add -> git commit -m \"\"", () => {
    expect(commands({ history: ["git status", "git add -A"], git: GIT })[0]).toBe('git commit -m ""');
  });

  it("git commit -> git push only when ahead > 0", () => {
    expect(contextMoves("git commit -m fix", { ...GIT, ahead: 1 }, 0)).toContainEqual(expect.objectContaining({ command: "git push", prior: 0.8 }));
    expect(contextMoves("git commit -m fix", GIT, 0).map((m) => m.command)).not.toContain("git push");
  });

  it("a failed test is rerun; a passing one is not", () => {
    expect(contextMoves("pnpm test", undefined, 1)).toContainEqual(expect.objectContaining({ command: "pnpm test", prior: 0.75 }));
    expect(contextMoves("pnpm --filter @ghost/server test", undefined, 1)[0]?.command).toBe("pnpm --filter @ghost/server test");
    expect(contextMoves("pnpm test", undefined, 0)).toEqual([]);
    expect(contextMoves("pnpm build", undefined, 1)).toEqual([]);
  });

  it("status of a dirty tree, new branches, clones, mkdir, stash, behind", () => {
    expect(contextMoves("git status", { ...GIT, untracked: 2 }, 0).map((m) => m.command)).toEqual(["git add -A", "git diff"]);
    expect(contextMoves("git checkout -b feature/tab", GIT, 0)).toContainEqual(expect.objectContaining({ command: "git push -u origin feature/tab", prior: 0.5 }));
    expect(contextMoves("git clone https://github.com/example/ghost.git", undefined, 0)).toContainEqual(expect.objectContaining({ command: "cd ghost", prior: 0.8 }));
    expect(contextMoves("git clone git@github.com:example/ghost.git my-ghost", undefined, 0)).toContainEqual(expect.objectContaining({ command: "cd my-ghost", prior: 0.8 }));
    expect(contextMoves("mkdir -p demo/app", undefined, 0)).toContainEqual(expect.objectContaining({ command: "cd demo/app", prior: 0.7 }));
    expect(contextMoves("git stash", undefined, 0)).toContainEqual(expect.objectContaining({ command: "git stash pop", prior: 0.5 }));
    expect(contextMoves(undefined, { ...GIT, behind: 3 }, undefined)).toEqual([expect.objectContaining({ command: "git pull", prior: 0.5 })]);
  });
});

describe("candidate set", () => {
  it("includes recent unique commands and project scripts", () => {
    const all = commands({ history: ["ls", "pnpm dev", "ls"], projectScripts: ["pnpm test", "make lib"] });
    expect(all).toEqual(expect.arrayContaining(["ls", "pnpm dev", "pnpm test", "make lib"]));
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps only commands that extend the typed prefix", () => {
    const all = commands({ history: ["git status", "git add -A", "pnpm test"], projectScripts: ["pnpm build"], prefix: "git s" });
    expect(all).toEqual(["git status"]);
    expect(commands({ history: ["git status"], prefix: "git status" })).toEqual([]); // nothing left to ghost
  });

  it("never offers destructive or secret-looking commands, however often they follow", () => {
    const history = ["pnpm build", "rm -rf dist", "pnpm build", "rm -rf dist", "pnpm build", "git push --force"];
    const all = commands({ history, projectScripts: ["sudo make install", "export API_KEY=abc"] });
    expect(all).not.toEqual(expect.arrayContaining(["rm -rf dist"]));
    for (const c of all) expect(c).not.toMatch(/rm -rf|--force|sudo|API_KEY/);
  });

  it("caps the list at 60", () => {
    const history = Array.from({ length: 30 }, (_, i) => `echo step-${i}`);
    const projectScripts = Array.from({ length: 40 }, (_, i) => `make target${i}`);
    expect(candidates({ history, projectScripts })).toHaveLength(MAX_CANDIDATES);
  });
});

describe("pickHeuristic", () => {
  it("one observation stays under the 0.7 gate, two consistent ones clear it", () => {
    const once = candidates({ history: ["pnpm build", "pnpm test", "pnpm build"] });
    expect(pickHeuristic(once, "")).toMatchObject({ command: "pnpm test", confidence: 0.667 });
    const twice = candidates({ history: ["pnpm build", "pnpm test", "pnpm build", "pnpm test", "pnpm build"] });
    expect(pickHeuristic(twice, "").confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("uses the context prior when nothing followed before, and returns null when there is nothing", () => {
    expect(pickHeuristic(candidates({ history: ["git add -A"] }), "")).toEqual({ command: 'git commit -m ""', confidence: 0.8 });
    expect(pickHeuristic([], "")).toEqual({ command: null, confidence: 0 });
  });

  it("a unique prefix match is confident, a recency-only guess on an empty line is not", () => {
    expect(pickHeuristic(candidates({ history: ["docker compose up -d", "ls"], prefix: "docker c" }), "docker c")).toEqual({ command: "docker compose up -d", confidence: 0.75 });
    expect(pickHeuristic(candidates({ history: ["ls", "cat notes.md"] }), "").confidence).toBeLessThan(0.7);
  });
});

describe("cleanRequest", () => {
  it("keeps the basename of the directory only, never a path", () => {
    expect(cwdBasename("/Users/alex/Projects/ghost")).toBe("ghost");
    expect(cwdBasename("ghost/")).toBe("ghost");
    expect(cwdBasename("~")).toBe("~");
    expect(cwdBasename("/")).toBe("");
  });

  it("filters history, scripts and a secret-looking branch again on the server", () => {
    const clean = cleanRequest({ cwd: "/tmp/x/app", history: ["pnpm i", "export GH_TOKEN=abc", "git status"], projectScripts: ["pnpm test", "rm -rf /"], git: { ...GIT, branch: "fix/0123456789abcdef0123456789" } });
    expect(clean).toMatchObject({ cwd: "app", history: ["pnpm i", "git status"], projectScripts: ["pnpm test"], git: { branch: "" }, prefix: "" });
  });
});
