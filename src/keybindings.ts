import type { Ext } from './extension.js';

import { wm } from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

export class Keybindings {
    global: Object;
    window_focus: Object;

    private ext: Ext;

    constructor(ext: Ext) {
        this.ext = ext;
        this.global = {
            'activate-launcher': () => ext.window_search.open(ext),
            'tile-enter': () => ext.tiler.enter(ext),
            'open-settings': () => {
                if (ext.button) {
                    ext.button.visible = true;
                    ext.button.menu.open();
                    ext.button.menu.connect('open-state-changed', (_: any, open: boolean) => {
                        if (!open) ext.button.visible = false;
                    });
                }
            },
        };

        this.window_focus = {
            'focus-left': () => ext.focus_left(),

            'focus-down': () => ext.focus_down(),

            'focus-up': () => ext.focus_up(),

            'focus-right': () => ext.focus_right(),

            'tile-orientation': () => {
                const win = ext.focus_window();
                if (win && ext.auto_tiler) {
                    ext.auto_tiler.toggle_orientation(ext, win);
                    ext.register_fn(() => win.activate(true));
                }
            },

            'toggle-floating': () => ext.auto_tiler?.toggle_floating(ext),

            'toggle-tiling': () => ext.toggle_tiling(),

            'toggle-stacking-global': () => ext.auto_tiler?.toggle_stacking(ext),

            'tile-move-left-global': () => ext.tiler.move_left(ext, ext.focus_window()?.entity),

            'tile-move-down-global': () => ext.tiler.move_down(ext, ext.focus_window()?.entity),

            'tile-move-up-global': () => ext.tiler.move_up(ext, ext.focus_window()?.entity),

            'tile-move-right-global': () => ext.tiler.move_right(ext, ext.focus_window()?.entity),

            'pop-monitor-left': () => ext.move_monitor(Meta.DisplayDirection.LEFT),

            'pop-monitor-right': () => ext.move_monitor(Meta.DisplayDirection.RIGHT),

            'pop-monitor-up': () => ext.move_monitor(Meta.DisplayDirection.UP),

            'pop-monitor-down': () => ext.move_monitor(Meta.DisplayDirection.DOWN),

            'pop-workspace-up': () => ext.move_workspace(Meta.DisplayDirection.UP),

            'pop-workspace-down': () => ext.move_workspace(Meta.DisplayDirection.DOWN),

            'maximize-with-gaps': () => {
                const win = ext.focus_window();
                if (!win) return;

                // Toggle: if already floating, re-tile; otherwise detach and maximize
                if (ext.auto_tiler && ext.is_floating(win)) {
                    ext.auto_tiler.toggle_floating(ext);
                    return;
                }

                // Detach from tiling if managed by auto-tiler
                if (ext.auto_tiler && !ext.is_floating(win)) {
                    ext.auto_tiler.toggle_floating(ext);
                }

                const monitor = win.meta.get_monitor();
                const area = ext.monitor_work_area(monitor);

                area.x += ext.gap_outer;
                area.y += ext.gap_outer;
                area.width -= ext.gap_outer * 2;
                area.height -= ext.gap_outer * 2;

                win.move(ext, area);
            },
        };
    }

    enable(keybindings: any) {
        for (const name in keybindings) {
            wm.addKeybinding(
                name,
                this.ext.settings.ext,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                keybindings[name],
            );
        }

        return this;
    }

    disable(keybindings: Object) {
        for (const name in keybindings) {
            wm.removeKeybinding(name);
        }

        return this;
    }
}
