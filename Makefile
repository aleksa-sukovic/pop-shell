# Retrieve the UUID from ``metadata.json``
UUID = $(shell grep -E '^[ ]*"uuid":' ./metadata.json | sed 's@^[ ]*"uuid":[ ]*"\(.\+\)",[ ]*@\1@')
VERSION = $(shell grep version tsconfig.json | awk -F\" '{print $$4}')

ifeq ($(XDG_DATA_HOME),)
XDG_DATA_HOME = $(HOME)/.local/share
endif

ifeq ($(strip $(DESTDIR)),)
INSTALLBASE = $(XDG_DATA_HOME)/gnome-shell/extensions
PLUGIN_BASE = $(XDG_DATA_HOME)/pop-shell/launcher
SCRIPTS_BASE = $(XDG_DATA_HOME)/pop-shell/scripts
else
INSTALLBASE = $(DESTDIR)/usr/share/gnome-shell/extensions
PLUGIN_BASE = $(DESTDIR)/usr/lib/pop-shell/launcher
SCRIPTS_BASE = $(DESTDIR)/usr/lib/pop-shell/scripts
endif
INSTALLNAME = $(UUID)

PROJECTS = color_dialog floating_exceptions

$(info UUID is "$(UUID)")

.PHONY: all clean install zip-file

sources = src/*.ts *.css

all: depcheck compile

clean:
	rm -rf _build target

# Configure local settings on system
configure:
	sh scripts/configure.sh

compile: $(sources) clean
	env PROJECTS="$(PROJECTS)" ./scripts/transpile.sh

# Rebuild, install, reconfigure local settings, reload the extension, and listen to journalctl logs
debug: depcheck compile install configure restart-shell listen

depcheck:
	@echo depcheck
	@if [ ! -d node_modules ]; then \
		echo 'Running npm install to fetch dependencies...'; \
		npm install; \
	fi
	@if ! npx tsc --version >/dev/null 2>&1; then \
		echo; \
		echo 'TypeScript is not available. Run: npm install'; \
		exit 1; \
	fi

enable:
	gnome-extensions enable "pop-shell@system76.com"

disable:
	gnome-extensions disable "pop-shell@system76.com"

reload-extension:
	@echo "Reloading GNOME Shell extension (Wayland)..."
	@if gnome-extensions list --enabled | grep -Fx "$(UUID)" >/dev/null; then \
		gnome-extensions disable "$(UUID)"; \
	fi
	@gnome-extensions enable "$(UUID)"

listen:
	journalctl -o cat -n 0 -f "$$(which gnome-shell)" | grep -v warning

local-install: depcheck compile install configure restart-shell

install:
	rm -rf $(INSTALLBASE)/$(INSTALLNAME)
	mkdir -p $(INSTALLBASE)/$(INSTALLNAME) $(PLUGIN_BASE) $(SCRIPTS_BASE)
	cp -r _build/* $(INSTALLBASE)/$(INSTALLNAME)/

uninstall:
	rm -rf $(INSTALLBASE)/$(INSTALLNAME)

restart-shell: reload-extension

update-repository:
	git fetch origin
	git reset --hard origin/master
	git clean -fd

zip-file: all
	cd _build && zip -qr "../$(UUID)_$(VERSION).zip" .

.NOTPARALLEL: debug local-install
