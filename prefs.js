/*
 * Claude Usage — preferences UI.
 *
 * Copyright (C) 2026 the Claude Usage contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        // --- Display ---
        const display = new Adw.PreferencesGroup({title: _('Display')});
        page.add(display);

        const five = new Adw.SwitchRow({title: _('Show 5-hour usage')});
        display.add(five);
        settings.bind('show-five-hour', five, 'active', Gio.SettingsBindFlags.DEFAULT);

        const seven = new Adw.SwitchRow({title: _('Show 7-day usage')});
        display.add(seven);
        settings.bind('show-seven-day', seven, 'active', Gio.SettingsBindFlags.DEFAULT);

        const thresholdAdj = new Gtk.Adjustment({
            lower: 1, upper: 100, step_increment: 1, page_increment: 5,
            value: settings.get_int('high-threshold'),
        });
        const threshold = new Adw.SpinRow({
            title: _('Red threshold (%)'),
            subtitle: _('Color the value red at or above this percent'),
            adjustment: thresholdAdj,
        });
        display.add(threshold);
        thresholdAdj.connect('value-changed',
            () => settings.set_int('high-threshold', thresholdAdj.get_value()));

        // --- Behavior ---
        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);

        const intervalAdj = new Gtk.Adjustment({
            lower: 60, upper: 3600, step_increment: 30, page_increment: 60,
            value: settings.get_int('refresh-interval'),
        });
        const interval = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            subtitle: _('Lower values risk HTTP 429 rate limiting'),
            adjustment: intervalAdj,
        });
        behavior.add(interval);
        intervalAdj.connect('value-changed',
            () => settings.set_int('refresh-interval', intervalAdj.get_value()));

        const cred = new Adw.EntryRow({title: _('Credentials path')});
        cred.text = settings.get_string('credentials-path');
        cred.connect('changed', () => settings.set_string('credentials-path', cred.text));
        behavior.add(cred);

        const credHint = new Adw.ActionRow({
            subtitle: _('Leave empty to use ~/.claude/.credentials.json'),
        });
        behavior.add(credHint);

        window.add(page);
    }
}
