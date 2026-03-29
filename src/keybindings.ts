import type { Ext } from './extension.js';
import type { Entity } from './ecs.js';
import type { ShellWindow } from './window.js';
import * as Lib from './lib.js';
import * as Node from './node.js';
import * as Tags from './tags.js';

import { wm } from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

/** Save the window's position in the fork tree before maximizing. */
function save_maximize_state(ext: Ext, win: ShellWindow): void {
    if (!ext.auto_tiler) return;

    const fork_entity = ext.auto_tiler.attached.get(win.entity);
    if (!fork_entity) return;

    const fork = ext.auto_tiler.forest.forks.get(fork_entity);
    if (!fork || !fork.right) return;

    const is_left = fork.left.is_window(win.entity) || fork.left.is_in_stack(win.entity);
    const sibling = is_left ? fork.right : fork.left;

    let sibling_kind: 'window' | 'fork';
    let sibling_entity: Entity;
    let sibling_fork_orientation: Lib.Orientation | null = null;

    switch (sibling.inner.kind) {
        case 1: {
            sibling_kind = 'fork';
            sibling_entity = sibling.inner.entity;
            const sf = ext.auto_tiler.forest.forks.get(sibling_entity);
            if (sf) sibling_fork_orientation = sf.orientation;
            break;
        }
        case 2:
            sibling_kind = 'window';
            sibling_entity = sibling.inner.entity;
            break;
        case 3:
            if (sibling.inner.entities.length === 0) return;
            sibling_kind = 'window';
            sibling_entity = sibling.inner.entities[0];
            break;
        default:
            return;
    }

    win.saved_maximize = {
        fork_entity,
        was_left: is_left,
        fork_orientation: fork.orientation,
        sibling_kind,
        sibling_entity,
        sibling_fork_orientation,
    };
    win.saved_rect = win.rect().clone();
    win.maximized_by_toggle = true;
}

/**
 * Restore a maximized window to its original tiled position.
 *
 * Three cases based on how detach restructured the fork tree:
 *  1. Root fork survived: wrap current children into sub-fork, add window back
 *  2. Fork destroyed + sibling was a fork: insert new fork between parent and sibling fork
 *  3. Fork destroyed + sibling was a window: use attach_to_window
 */
function restore_tiled_position(ext: Ext, win: ShellWindow): boolean {
    const state = win.saved_maximize;
    if (!ext.auto_tiler || !state) return false;

    const forest = ext.auto_tiler.forest;
    const saved_fork = forest.forks.get(state.fork_entity);

    // Case 1: Original fork still exists (root fork — never destroyed by detach)
    if (saved_fork && saved_fork.monitor === win.meta.get_monitor()) {
        return restore_to_surviving_fork(ext, win, state, saved_fork);
    }

    // Case 2: Fork was destroyed, sibling was a fork (moved up to parent)
    if (state.sibling_kind === 'fork') {
        return restore_beside_sibling_fork(ext, win, state);
    }

    // Case 3: Fork was destroyed, sibling was a window
    return restore_beside_sibling_window(ext, win, state);
}

/** Case 1: The fork the window was in still exists. Wrap its children into a
 *  sub-fork and re-insert the window on its original side. */
function restore_to_surviving_fork(
    ext: Ext,
    win: ShellWindow,
    state: NonNullable<ShellWindow['saved_maximize']>,
    saved_fork: any,
): boolean {
    const forest = ext.auto_tiler!.forest;
    const win_node = Node.Node.window(win.entity);

    if (saved_fork.right === null) {
        // Only one child remaining: directly add our window
        if (state.was_left) {
            saved_fork.right = saved_fork.left;
            saved_fork.left = win_node;
        } else {
            saved_fork.right = win_node;
        }
    } else {
        // Two children: wrap them into a sub-fork
        const left_child = saved_fork.left;
        const right_child = saved_fork.right;

        const [sub_entity] = forest.create_fork(
            left_child, right_child,
            saved_fork.area.clone(), saved_fork.workspace, saved_fork.monitor,
        );

        // Set sub-fork orientation to match original sibling fork
        if (state.sibling_fork_orientation !== null) {
            const sub = forest.forks.get(sub_entity);
            if (sub) sub.set_orientation(state.sibling_fork_orientation);
        }

        forest.parents.insert(sub_entity, state.fork_entity);
        reparent_node_children(ext, left_child, sub_entity);
        reparent_node_children(ext, right_child, sub_entity);

        const fork_node = Node.Node.fork(sub_entity);
        if (state.was_left) {
            saved_fork.left = win_node;
            saved_fork.right = fork_node;
        } else {
            saved_fork.left = fork_node;
            saved_fork.right = win_node;
        }
    }

    saved_fork.set_orientation(state.fork_orientation);
    ext.auto_tiler!.attached.insert(win.entity, state.fork_entity);
    saved_fork.set_ratio(saved_fork.length() / 2);
    saved_fork.measure(forest, ext, saved_fork.area, forest.on_record());
    forest.arrange(ext, saved_fork.workspace);
    return true;
}

/** Case 2: The window's fork was destroyed; the sibling (a sub-fork) was moved up
 *  to the parent. Create a new fork between parent and sibling fork. */
function restore_beside_sibling_fork(
    ext: Ext,
    win: ShellWindow,
    state: NonNullable<ShellWindow['saved_maximize']>,
): boolean {
    const forest = ext.auto_tiler!.forest;
    const sibling_fork = forest.forks.get(state.sibling_entity);
    if (!sibling_fork) return false;

    const parent_entity = forest.parents.get(state.sibling_entity);
    if (!parent_entity) return false;

    const parent_fork = forest.forks.get(parent_entity);
    if (!parent_fork || parent_fork.monitor !== win.meta.get_monitor()) return false;

    // Create new fork containing our window and the sibling fork
    const win_node = Node.Node.window(win.entity);
    const sibling_node = Node.Node.fork(state.sibling_entity);
    const [new_fork_entity, new_fork] = forest.create_fork(
        state.was_left ? win_node : sibling_node,
        state.was_left ? sibling_node : win_node,
        parent_fork.area.clone(), parent_fork.workspace, parent_fork.monitor,
    );
    new_fork.set_orientation(state.fork_orientation);

    // Replace sibling fork in parent with our new wrapping fork
    if (parent_fork.left.is_fork(state.sibling_entity)) {
        parent_fork.left = Node.Node.fork(new_fork_entity);
    } else if (parent_fork.right?.is_fork(state.sibling_entity)) {
        parent_fork.right = Node.Node.fork(new_fork_entity);
    } else {
        forest.delete_entity(new_fork_entity);
        return false;
    }

    forest.parents.insert(new_fork_entity, parent_entity);
    forest.parents.insert(state.sibling_entity, new_fork_entity);
    ext.auto_tiler!.attached.insert(win.entity, new_fork_entity);

    new_fork.set_ratio(new_fork.length() / 2);
    parent_fork.measure(forest, ext, parent_fork.area, forest.on_record());
    forest.arrange(ext, parent_fork.workspace);
    return true;
}

/** Case 3: The window's fork was destroyed; the sibling (a window) was moved up.
 *  Use attach_to_window to place beside the sibling. */
function restore_beside_sibling_window(
    ext: Ext,
    win: ShellWindow,
    state: NonNullable<ShellWindow['saved_maximize']>,
): boolean {
    const sibling_win = ext.windows.get(state.sibling_entity);
    if (!sibling_win) return false;

    const sibling_fork_entity = ext.auto_tiler!.attached.get(state.sibling_entity);
    if (!sibling_fork_entity) return false;

    const sibling_fork = ext.auto_tiler!.forest.forks.get(sibling_fork_entity);
    if (!sibling_fork || sibling_fork.monitor !== win.meta.get_monitor()) return false;

    ext.auto_tiler!.attach_to_window(
        ext, sibling_win, win,
        { swap: state.was_left, orientation: state.fork_orientation },
    );
    return true;
}

/** Update parent/attached references when a node is moved into a new fork. */
function reparent_node_children(ext: Ext, node: Node.Node, new_parent: Entity): void {
    switch (node.inner.kind) {
        case 1:
            ext.auto_tiler!.forest.parents.insert(node.inner.entity, new_parent);
            break;
        case 2:
            ext.auto_tiler!.attached.insert(node.inner.entity, new_parent);
            break;
        case 3:
            for (const e of node.inner.entities) {
                ext.auto_tiler!.attached.insert(e, new_parent);
            }
            break;
    }
}

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
                    const id = ext.button.menu.connect('open-state-changed', (_: any, open: boolean) => {
                        if (!open) {
                            ext.button.visible = false;
                            ext.button.menu.disconnect(id);
                        }
                    });
                }
            },
            'warp-mouse-left': () => ext.warp_mouse_to_monitor(Meta.DisplayDirection.LEFT),
            'warp-mouse-right': () => ext.warp_mouse_to_monitor(Meta.DisplayDirection.RIGHT),
            'warp-mouse-up': () => ext.warp_mouse_to_monitor(Meta.DisplayDirection.UP),
            'warp-mouse-down': () => ext.warp_mouse_to_monitor(Meta.DisplayDirection.DOWN),
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

                if (win.maximized_by_toggle) {
                    win.maximized_by_toggle = false;

                    if (ext.auto_tiler && win.saved_maximize) {
                        ext.delete_tag(win.entity, Tags.Floating);

                        if (!restore_tiled_position(ext, win)) {
                            ext.auto_tiler.auto_tile(ext, win, false);
                        }

                        win.saved_maximize = null;
                        win.saved_rect = null;
                        ext.register_fn(() => win.activate(true));
                        return;
                    }

                    if (win.saved_rect) {
                        win.move(ext, win.saved_rect);
                        win.saved_rect = null;
                    }
                    return;
                }

                if (ext.auto_tiler && !ext.is_floating(win)) {
                    save_maximize_state(ext, win);
                    const fork_entity = ext.auto_tiler.attached.get(win.entity);
                    if (fork_entity) {
                        ext.auto_tiler.detach_window(ext, win.entity);
                        ext.add_tag(win.entity, Tags.Floating);
                    }
                } else if (ext.auto_tiler && ext.is_floating(win)) {
                    ext.auto_tiler.toggle_floating(ext);
                    return;
                } else {
                    win.saved_rect = win.rect().clone();
                    win.maximized_by_toggle = true;
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
