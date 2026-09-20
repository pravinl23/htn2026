import { afterEach, describe, expect, it, vi } from "vitest";
import { focusOnBody, jumpLabel, offscreenDirection } from "../src/content/jump";

function input(): HTMLInputElement {
  document.body.innerHTML = `<input id="a" /><input id="b" />`;
  return document.getElementById("a") as HTMLInputElement;
}

function place(el: HTMLElement, x: number, y: number): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, 200, 32));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("offscreenDirection", () => {
  it("points down for a field below the fold and up for one above it", () => {
    const el = input();
    place(el, 0, window.innerHeight + 400);
    expect(offscreenDirection(el)).toBe("down");
    place(el, 0, -400);
    expect(offscreenDirection(el)).toBe("up");
  });

  it("is null while any part of the field is on screen", () => {
    const el = input();
    place(el, 0, 100);
    expect(offscreenDirection(el)).toBeNull();
    place(el, 0, window.innerHeight - 10);
    expect(offscreenDirection(el)).toBeNull();
  });

  it("is null for a field without a box: nothing to jump to (display:none, jsdom)", () => {
    expect(offscreenDirection(input())).toBeNull();
  });

  it("is null for a field CSS keeps from rendering", () => {
    const el = input();
    place(el, 0, 5000);
    (el as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false;
    expect(offscreenDirection(el)).toBeNull();
  });
});

describe("focusOnBody", () => {
  it("is true only while the user has put focus nowhere", () => {
    const el = input();
    expect(focusOnBody(document)).toBe(true);
    el.focus();
    expect(focusOnBody(document)).toBe(false);
    el.blur();
    expect(focusOnBody(document)).toBe(true);
  });
});

describe("jumpLabel", () => {
  it("counts ghosts, singular and plural", () => {
    expect(jumpLabel({ count: 14, direction: "down" })).toBe("14 ghosts ready");
    expect(jumpLabel({ count: 1, direction: "up" })).toBe("1 ghost ready");
  });
});
