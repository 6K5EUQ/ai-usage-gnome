UUID    = claude-usage@6k5euq
ZIP     = $(UUID).shell-extension.zip
DESTDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all pack install enable disable schemas clean

all: pack

## Compile the GSettings schema in place (for running from a checkout)
schemas:
	glib-compile-schemas schemas

## Build a distributable zip (schema is compiled into the zip automatically)
pack:
	gnome-extensions pack --force --extra-source=LICENSE --out-dir=. .

## Install the built zip for the current user
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed to $(DESTDIR)"
	@echo "Now restart GNOME Shell (X11: Alt+F2, r) or log out/in, then: make enable"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
