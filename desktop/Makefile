# Ghost Desktop: Objective-C (ARC) + clang. No Xcode project, no Swift (see docs/desktop.md).
#
#   make core    bundle @ghost/shared into build/ghost-core.js (fails loudly on a missing export)
#   make app     build/Ghost.app (menu-bar agent), ad-hoc signed
#   make test    build and run the plain test runner (no XCTest); non-zero exit on failure
#   make run     open build/Ghost.app
#   make dump    print the fields of the frontmost window as JSON (needs the Accessibility permission)
#   make selftest / make trust / make clean
#   make overlay-demo / overlay-demo-offscreen   (tools/overlay-demo.mk)
#
# Every src/*.m and every tests/test_*.m is picked up by wildcard, so new modules join the build on their own.

CC        := clang
BUILD     := build
APP       := $(BUILD)/Ghost.app
EXE       := $(APP)/Contents/MacOS/Ghost
CORE_JS   := $(BUILD)/ghost-core.js
TEST_BIN  := $(BUILD)/ghost-tests

CFLAGS    := -fobjc-arc -Wall -Wextra -Wno-unused-parameter -O2 -mmacosx-version-min=13.0 -Isrc -MMD -MP
FRAMEWORKS := -framework AppKit -framework ApplicationServices -framework JavaScriptCore -framework QuartzCore -framework Carbon

SRC       := $(wildcard src/*.m)
APP_OBJ   := $(patsubst src/%.m,$(BUILD)/obj/%.o,$(SRC))
# The test runner links every module except the app's own main().
LIB_OBJ   := $(filter-out $(BUILD)/obj/main.o,$(APP_OBJ))
TEST_SRC  := tests/main.m $(wildcard tests/test_*.m)
TEST_OBJ  := $(patsubst tests/%.m,$(BUILD)/testobj/%.o,$(TEST_SRC))

CORE_SRC  := core/entry.ts core/predict.ts core/build-core.mjs $(wildcard ../shared/src/*.ts)

.PHONY: all core app test run dump selftest trust clean
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

app: $(EXE)

$(EXE): $(APP_OBJ) $(CORE_JS) Info.plist
	@mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	$(CC) $(APP_OBJ) $(FRAMEWORKS) -o $(EXE)
	cp Info.plist $(APP)/Contents/Info.plist
	cp $(CORE_JS) $(APP)/Contents/Resources/ghost-core.js
	codesign -s - --force --deep $(APP)
	@echo "app: $(APP) (ad-hoc signed; a rebuild changes the code hash, macOS may ask for Accessibility again)"

$(TEST_BIN): $(LIB_OBJ) $(TEST_OBJ)
	$(CC) $(LIB_OBJ) $(TEST_OBJ) $(FRAMEWORKS) -o $(TEST_BIN)

test: $(CORE_JS) $(TEST_BIN)
	DESKTOP_CORE_PATH=$(abspath $(CORE_JS)) $(TEST_BIN)

selftest: app
	$(EXE) --selftest

trust: app
	$(EXE) --trust

run: app
	open $(APP)

dump: app
	$(EXE) --dump

clean:
	rm -rf $(BUILD)

-include $(APP_OBJ:.o=.d) $(TEST_OBJ:.o=.d)
# Extra targets (overlay-demo, overlay-demo-offscreen). After `all`, so they never become the default goal.
-include tools/*.mk
