/*
 * AI Usage — preferences UI.
 *
 * Copyright (C) 2026 the AI Usage contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        // --- Display ---
        const display = new Adw.PreferencesGroup({title: _('Display')});
        page.add(display);

        const claude = new Adw.SwitchRow({title: _('Show Claude usage')});
        display.add(claude);
        settings.bind('show-claude', claude, 'active', Gio.SettingsBindFlags.DEFAULT);

        const codex = new Adw.SwitchRow({title: _('Show Codex usage')});
        display.add(codex);
        settings.bind('show-codex', codex, 'active', Gio.SettingsBindFlags.DEFAULT);

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

        // --- Claude ---
        const claudeGroup = new Adw.PreferencesGroup({title: _('Claude')});
        page.add(claudeGroup);

        const claudeIntervalAdj = new Gtk.Adjustment({
            lower: 60, upper: 3600, step_increment: 30, page_increment: 60,
            value: settings.get_int('claude-refresh-interval'),
        });
        const claudeInterval = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            subtitle: _('Lower values risk HTTP 429 rate limiting'),
            adjustment: claudeIntervalAdj,
        });
        claudeGroup.add(claudeInterval);
        claudeIntervalAdj.connect('value-changed',
            () => settings.set_int('claude-refresh-interval', claudeIntervalAdj.get_value()));

        const cred = new Adw.EntryRow({title: _('Credentials path')});
        cred.text = settings.get_string('credentials-path');
        cred.connect('changed', () => settings.set_string('credentials-path', cred.text));
        claudeGroup.add(cred);

        const credHint = new Adw.ActionRow({
            subtitle: _('Leave empty to use ~/.claude/.credentials.json'),
        });
        claudeGroup.add(credHint);

        // --- Codex ---
        const codexGroup = new Adw.PreferencesGroup({title: _('Codex')});
        page.add(codexGroup);

        const codexIntervalAdj = new Gtk.Adjustment({
            lower: 10, upper: 3600, step_increment: 10, page_increment: 60,
            value: settings.get_int('codex-refresh-interval'),
        });
        const codexInterval = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            subtitle: _('Reads local Codex session logs'),
            adjustment: codexIntervalAdj,
        });
        codexGroup.add(codexInterval);
        codexIntervalAdj.connect('value-changed',
            () => settings.set_int('codex-refresh-interval', codexIntervalAdj.get_value()));

        window.add(page);
    }
}
