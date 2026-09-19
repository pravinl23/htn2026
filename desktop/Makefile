# Ghost Desktop: Objective-C (ARC) + clang. No Xcode project, no Swift (see docs/desktop.md).
#
# Two pieces, so that the Accessibility grant survives rebuilds (docs/desktop-realworld.md section 1):
#   build/Ghost.app        the HOST: host/main.m only (dlopen + GhostMain). Built and signed ONCE, then never touched.
#   build/libghost.dylib   everything else (src/*.m), OUTSIDE the bundle. Rebuild it as often as you like.
#
#   make core         bundle @ghost/shared into build/ghost-core.js (fails loudly on a missing export)
#   make host         build + ad-hoc sign build/Ghost.app, ONLY when it does not exist yet
#   make host-force   rebuild the host anyway. This INVALIDATES the Accessibility grant.
#   make lib          build/libghost.dylib (ghost-core.js sits beside it, which is where the library looks first)
#   make app          core + host + lib
#   make install-lib  copy the library + ghost-core.js to ~/Library/Application Support/Ghost/
#   make run          open -n build/Ghost.app with GHOST_LIB=build/libghost.dylib
#   make test         build and run the plain test runner (no XCTest); links the sources, not the dylib
#   make trust / dump / selftest / clean     (trust and dump go through tools/ghostctl, i.e. LaunchServices)
#   make overlay-demo / overlay-demo-offscreen   (tools/overlay-demo.mk)
#
# Every src/*.m and every tests/test_*.m is picked up by wildcard, so new modules join the build on their own.

CC        := clang
BUILD     := build
APP       := $(BUILD)/Ghost.app
EXE       := $(APP)/Contents/MacOS/Ghost
LIB       := $(BUILD)/libghost.dylib
CORE_JS   := $(BUILD)/ghost-core.js
TEST_BIN  := $(BUILD)/ghost-tests
SUPPORT   := $(HOME)/Library/Application Support/Ghost
HOST_MARK := ghost-host-v1

CFLAGS    := -fobjc-arc -Wall -Wextra -Wno-unused-parameter -O2 -mmacosx-version-min=13.0 -Isrc -MMD -MP
HOST_CFLAGS := -fobjc-arc -Wall -Wextra -O2 -mmacosx-version-min=13.0
FRAMEWORKS := -framework AppKit -framework ApplicationServices -framework JavaScriptCore -framework QuartzCore -framework Carbon

SRC       := $(wildcard src/*.m)
LIB_OBJ   := $(patsubst src/%.m,$(BUILD)/obj/%.o,$(SRC))
TEST_SRC  := tests/main.m $(wildcard tests/test_*.m)
TEST_OBJ  := $(patsubst tests/%.m,$(BUILD)/testobj/%.o,$(TEST_SRC))

CORE_SRC  := core/entry.ts core/predict.ts core/build-core.mjs $(wildcard ../shared/src/*.ts)

.PHONY: all core host host-force lib app install-lib test run dump selftest trust clean
all: app

core: $(CORE_JS)

$(CORE_JS): $(CORE_SRC)
	@mkdir -p $(BUILD)
	node core/build-core.mjs

$(BUILD)/obj/%.o: src/%.m
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/testobj/%.o: tests/%.m
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -Itests -c $< -o $@

# ---------- host: once ----------
# Deliberately NOT a file rule on host/main.m or Info.plist: a newer source must never rebuild the host behind
# the user's back. Existence is the only test.
host:
	@if [ -e "$(EXE)" ]; then \
		echo "host: $(EXE) exists and is left untouched (its code hash carries the Accessibility grant)"; \
		if ! grep -q "$(HOST_MARK)" "$(EXE)"; then \
			echo ""; \
			echo "  WARNING: that binary is NOT the tiny host (an old monolithic build). It ignores libghost.dylib."; \
			echo "  WARNING: run 'make host-force' ONCE, then grant Accessibility to Ghost.app one last time."; \
			echo ""; \
		fi; \
	else \
		$(MAKE) --no-print-directory host-force; \
	fi

host-force:
	@echo ""
	@echo "  ======================================================================================"
	@echo "  BUILDING THE HOST. A rebuilt host has a new code hash: macOS forgets the Accessibility"
	@echo "  grant of Ghost.app. Grant it again afterwards (remove and re-add Ghost.app in System"
	@echo "  Settings -> Privacy & Security -> Accessibility). 'make lib' never causes this."
	@echo "  ======================================================================================"
	@echo ""
	rm -rf $(APP)
	@mkdir -p $(APP)/Contents/MacOS
	$(CC) $(HOST_CFLAGS) host/main.m -framework AppKit -o $(EXE)
	cp Info.plist $(APP)/Contents/Info.plist
	codesign -s - --force $(APP)
	@codesign -dv --verbose=4 $(APP) 2>&1 | grep '^CDHash=' | sed 's/^/host: /'

# ---------- library: as often as you like ----------
lib: $(LIB)

# ld replaces the output file (new inode), so an agent that has the old library mapped keeps running.
$(LIB): $(LIB_OBJ) $(CORE_JS)
	$(CC) -dynamiclib -install_name @rpath/libghost.dylib $(LIB_OBJ) $(FRAMEWORKS) -o $(LIB)
	codesign -s - --force $(LIB)
	@echo "lib: $(LIB) + $(CORE_JS) (the host was not touched)"

app: core host lib

# cp to a temporary name + mv: the running agent keeps the inode it has mapped.
install-lib: lib
	@mkdir -p "$(SUPPORT)"
	cp $(LIB) "$(SUPPORT)/libghost.dylib.new" && mv -f "$(SUPPORT)/libghost.dylib.new" "$(SUPPORT)/libghost.dylib"
	cp $(CORE_JS) "$(SUPPORT)/ghost-core.js.new" && mv -f "$(SUPPORT)/ghost-core.js.new" "$(SUPPORT)/ghost-core.js"
	@echo "install-lib: $(SUPPORT)/libghost.dylib (the host finds it there without GHOST_LIB)"

$(TEST_BIN): $(LIB_OBJ) $(TEST_OBJ)
	$(CC) $(LIB_OBJ) $(TEST_OBJ) $(FRAMEWORKS) -o $(TEST_BIN)

test: $(CORE_JS) $(TEST_BIN)
	DESKTOP_CORE_PATH=$(abspath $(CORE_JS)) $(TEST_BIN)

# Always through LaunchServices, so Ghost is its own TCC "responsible process" (a binary started from a shell is
# judged by the terminal's permissions). `open --env` exists since macOS 13; without it the host reads lib-path.txt.
run: app
	@if open -h 2>&1 | grep -q -- '--env'; then \
		open -n -g --env GHOST_LIB="$(abspath $(LIB))" $(APP); \
	else \
		mkdir -p "$(SUPPORT)" && printf '%s\n' "$(abspath $(LIB))" > "$(SUPPORT)/lib-path.txt" && open -n -g $(APP); \
	fi

selftest: app
	GHOST_LIB="$(abspath $(LIB))" $(EXE) --selftest

trust: app
	tools/ghostctl trust

dump: app
	tools/ghostctl dump --delay 3

clean:
	@echo "clean: removing objects, the library and the tests. $(APP) stays: it carries the Accessibility grant (make host-force rebuilds it)."
	rm -rf $(BUILD)/obj $(BUILD)/testobj $(LIB) $(CORE_JS) $(TEST_BIN)

-include $(LIB_OBJ:.o=.d) $(TEST_OBJ:.o=.d)
# Extra targets (overlay-demo, overlay-demo-offscreen). After `all`, so they never become the default goal.
-include tools/*.mk
