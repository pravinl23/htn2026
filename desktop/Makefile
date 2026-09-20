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
#   make install-lib  build the library WITHOUT the harness and install it + ghost-core.js (0444) into a 0700
#                     ~/Library/Application Support/Ghost/ (refuses launchctl GHOST_LIB / DYLD_INSERT_LIBRARIES)
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

CORE_SRC  := $(wildcard core/*.ts) core/build-core.mjs $(wildcard ../shared/src/*.ts) $(wildcard ../shared/src/*/*.ts)

.PHONY: all core host host-force lib app install-lib test run dump selftest trust clean
all: app

core: $(CORE_JS)

$(CORE_JS): $(CORE_SRC)
	@mkdir -p $(BUILD)
	node core/build-core.mjs

$(BUILD)/obj/%.o: src/%.m
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

# GHCore.m carries the SHA-256 of the ghost-core.js built with it: Ghost only loads that exact bundle (the core holds
# the fact allowlist and the wire filters). Read at recipe time, after `make core`, never at parse time.
$(BUILD)/obj/GHCore.o: src/GHCore.m $(CORE_JS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DGHOST_CORE_SHA256=\"$$(shasum -a 256 $(CORE_JS) | cut -d' ' -f1)\" -c $< -o $@

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

# ---------- the installed library: no harness ----------
# What the background agent and a Ghost.app started without GHOST_LIB load. Built with GHOST_NO_HARNESS: no
# --dump / --dump-tree / --autotab, no request folder, so no other process can borrow Ghost's Accessibility grant
# through it. The developer library (make lib, used with GHOST_LIB and tools/ghostctl) keeps the harness.
RELEASE     := $(BUILD)/release
RELEASE_LIB := $(RELEASE)/libghost.dylib
RELEASE_OBJ := $(patsubst src/%.m,$(RELEASE)/obj/%.o,$(SRC))

$(RELEASE)/obj/%.o: src/%.m
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DGHOST_NO_HARNESS=1 -c $< -o $@

$(RELEASE)/obj/GHCore.o: src/GHCore.m $(CORE_JS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DGHOST_NO_HARNESS=1 -DGHOST_CORE_SHA256=\"$$(shasum -a 256 $(CORE_JS) | cut -d' ' -f1)\" -c $< -o $@

$(RELEASE_LIB): $(RELEASE_OBJ) $(CORE_JS)
	$(CC) -dynamiclib -install_name @rpath/libghost.dylib $(RELEASE_OBJ) $(FRAMEWORKS) -o $(RELEASE_LIB)
	codesign -s - --force $(RELEASE_LIB)

# The host loads whatever it finds (desktop/README.md "Security: the grant covers any code the host loads"), so
# the installer refuses a machine that is set up to hand it something else, and installs read-only copies into a
# private folder. These checks catch misconfiguration only: GHOST_LIB and DYLD_INSERT_LIBRARIES set by another
# process still get past them. cp to a temporary name + mv: the running agent keeps the inode it has mapped.
install-lib: $(RELEASE_LIB)
	@for name in GHOST_LIB DYLD_INSERT_LIBRARIES DESKTOP_CORE_PATH; do \
		if [ -n "$$(launchctl getenv $$name 2>/dev/null)" ]; then \
			echo "install-lib: launchctl has $$name set; every app you start inherits it. Remove it: launchctl unsetenv $$name" >&2; exit 1; \
		fi; \
	done
	@if [ -e "$(HOME)/Applications/libghost.dylib" ]; then \
		echo "install-lib: $(HOME)/Applications/libghost.dylib sits next to Ghost.app (a lookup location of the host); remove it first" >&2; exit 1; \
	fi
	@mkdir -p "$(SUPPORT)" && chmod 0700 "$(SUPPORT)"
	@owner="$$(stat -f '%Su' "$(SUPPORT)")"; mode="$$(stat -f '%Lp' "$(SUPPORT)")"; \
	if [ "$$owner" != "$$(id -un)" ] || [ "$$mode" != "700" ]; then \
		echo "install-lib: $(SUPPORT) must be yours and 0700 (it is $$owner, $$mode)" >&2; exit 1; \
	fi; \
	if ls -lde "$(SUPPORT)" | tail -n +2 | grep -q .; then \
		echo "install-lib: $(SUPPORT) carries an ACL; remove it (chmod -N)" >&2; exit 1; \
	fi
	rm -f "$(SUPPORT)/lib-path.txt"
	install -m 0444 $(RELEASE_LIB) "$(SUPPORT)/libghost.dylib.new" && mv -f "$(SUPPORT)/libghost.dylib.new" "$(SUPPORT)/libghost.dylib"
	install -m 0444 $(CORE_JS) "$(SUPPORT)/ghost-core.js.new" && mv -f "$(SUPPORT)/ghost-core.js.new" "$(SUPPORT)/ghost-core.js"
	@codesign -dv --verbose=4 "$(SUPPORT)/libghost.dylib" 2>&1 | grep '^CDHash=' | sed 's/^/install-lib: libghost.dylib /'
	@shasum -a 256 "$(SUPPORT)/ghost-core.js" | cut -d' ' -f1 | sed 's/^/install-lib: ghost-core.js sha256=/'
	@echo "install-lib: $(SUPPORT)/libghost.dylib, built WITHOUT the harness (the host finds it there without GHOST_LIB)"

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
	rm -rf $(BUILD)/obj $(BUILD)/testobj $(BUILD)/release $(LIB) $(CORE_JS) $(TEST_BIN)

-include $(LIB_OBJ:.o=.d) $(TEST_OBJ:.o=.d) $(RELEASE_OBJ:.o=.d)
# Extra targets (overlay-demo, overlay-demo-offscreen). After `all`, so they never become the default goal.
-include tools/*.mk
