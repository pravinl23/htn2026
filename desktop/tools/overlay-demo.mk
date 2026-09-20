# overlay-demo: the overlay over a window of fake fields, 4 seconds on screen, then build/overlay-demo.png.
#
# Include from desktop/Makefile AFTER the `all` target (so it never becomes the default goal):
#     -include tools/*.mk
# or run it on its own from desktop/:
#     make -f tools/overlay-demo.mk overlay-demo            # on screen, 4 s, writes the PNG
#     make -f tools/overlay-demo.mk overlay-demo-offscreen  # no window at all, PNGs of every scene
#
# Self-contained on purpose (own variable names, no dependency on the main Makefile's object rules).

OVERLAY_DEMO_BIN   := build/overlay-demo
OVERLAY_DEMO_SRC   := tools/overlay-demo.m src/SBGeometry.m src/SBOverlayModel.m src/SBOverlayDrawing.m \
                      src/SBOverlayLayers.m src/SBOverlayBadges.m src/SBOverlayWindow.m src/SBField.m
OVERLAY_DEMO_HDR   := $(wildcard src/SBOverlay*.h) src/SBGeometry.h src/SBField.h
OVERLAY_DEMO_FLAGS := -fobjc-arc -Wall -Wextra -Wno-unused-parameter -O2 -mmacosx-version-min=13.0 -Isrc \
                      -framework AppKit -framework ApplicationServices -framework QuartzCore

.PHONY: overlay-demo overlay-demo-offscreen

$(OVERLAY_DEMO_BIN): $(OVERLAY_DEMO_SRC) $(OVERLAY_DEMO_HDR)
	@mkdir -p build
	clang $(OVERLAY_DEMO_FLAGS) $(OVERLAY_DEMO_SRC) -o $@

overlay-demo: $(OVERLAY_DEMO_BIN)
	$(OVERLAY_DEMO_BIN) --out build/overlay-demo.png

overlay-demo-offscreen: $(OVERLAY_DEMO_BIN)
	$(OVERLAY_DEMO_BIN) --offscreen --out build/overlay-demo.png
	$(OVERLAY_DEMO_BIN) --offscreen --scene lock --out build/overlay-demo-lock.png
	$(OVERLAY_DEMO_BIN) --offscreen --scene dark --current 9 --out build/overlay-demo-dark.png
