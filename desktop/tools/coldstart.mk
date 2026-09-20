# ghost-scan: the cold-start command line (docs/cold-start.md), built from the same sources as the library.
#
# Included by desktop/Makefile through `-include tools/*.mk`, so it needs no change to the Makefile itself:
#     make -C desktop scan-tool        builds build/ghost-scan (and the core bundle it loads)
#     tools/ghostctl scan --dry-run    runs it
#
# Its own executable, on purpose. It is started from the shell and NOT through LaunchServices, so it can never
# borrow Ghost.app's Accessibility grant, and it asks macOS for no permission at all: a protected source is
# reported as "needs permission: <what to click>" and left untouched.

SCAN_BIN      := $(BUILD)/ghost-scan
SCAN_MAIN     := tools/ghost-scan-main.m
SCAN_MAIN_OBJ := $(BUILD)/toolobj/ghost-scan-main.o

.PHONY: scan-tool scan-dry-run

$(BUILD)/toolobj/%.o: tools/%.m
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(SCAN_BIN): $(LIB_OBJ) $(SCAN_MAIN_OBJ)
	$(CC) $(LIB_OBJ) $(SCAN_MAIN_OBJ) $(FRAMEWORKS) -o $@
	@echo "scan-tool: $(SCAN_BIN) (ghost-core.js beside it is what it loads)"

scan-tool: $(CORE_JS) $(SCAN_BIN)

# The one command that is safe to run unattended: counts only, opens nothing, raises no dialog.
scan-dry-run: scan-tool
	tools/ghostctl scan --dry-run

-include $(SCAN_MAIN_OBJ:.o=.d)
