/*
 * Claude Usage — GNOME Shell top-bar indicator for Claude.ai 5h / 7d usage.
 *
 * Copyright (C) 2026 the Claude Usage contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Data source: GET https://api.anthropic.com/api/oauth/usage (the same
 * endpoint the Claude Code `/usage` command uses), authenticated with the
 * OAuth access token stored in ~/.claude/.credentials.json. This is an
 * undocumented internal endpoint and may change without notice.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';

function defaultCredPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

function readToken(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        const j = JSON.parse(new TextDecoder().decode(bytes));
        return j?.claudeAiOauth?.accessToken ?? null;
    } catch (e) {
        return null;
    }
}

const UsageSection = GObject.registerClass(
class UsageSection extends St.BoxLayout {
    _init(iconName) {
        super._init({
            style_class: 'claude-usage-section',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(new St.Icon({
            style_class: 'system-status-icon claude-usage-icon',
            icon_name: iconName,
        }));

        this.label = new St.Label({
            style_class: 'claude-usage-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '--%',
        });
        this.add_child(this.label);
    }

    setValue(util, high, stale) {
        if (util === null || util === undefined || Number.isNaN(util)) {
            this.label.text = '--%';
            this.remove_style_class_name('claude-usage-high');
            return;
        }
        const pct = Math.round(util);
        this.label.text = stale ? `${pct}+%` : `${pct}%`;
        if (pct >= high)
            this.add_style_class_name('claude-usage-high');
        else
            this.remove_style_class_name('claude-usage-high');
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(settings, openPrefs) {
        super._init(0.5, 'Claude Usage');

        this._settings = settings;
        this._session = new Soup.Session();
        this._timeoutId = 0;
        this._data = {five: null, seven: null, note: null, stale: false};
        this._last = {five: null, seven: null};

        const box = new St.BoxLayout({style_class: 'claude-usage-box'});
        this.add_child(box);

        this._five = new UsageSection('alarm-symbolic');
        this._seven = new UsageSection('x-office-calendar-symbolic');
        box.add_child(this._five);
        box.add_child(this._seven);

        this._fiveItem = new PopupMenu.PopupMenuItem('5h: --', {reactive: false});
        this._sevenItem = new PopupMenu.PopupMenuItem('7d: --', {reactive: false});
        this.menu.addMenuItem(this._fiveItem);
        this.menu.addMenuItem(this._sevenItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Refresh now'), () => this._refresh());
        if (openPrefs)
            this.menu.addAction(_('Settings'), () => openPrefs());

        this._settingsChangedId = this._settings.connect(
            'changed', (_s, key) => this._onSettingsChanged(key));
        this._applyVisibility();
    }

    start() {
        this._refresh();
        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const interval = this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onSettingsChanged(key) {
        switch (key) {
        case 'refresh-interval':
            this._scheduleRefresh();
            break;
        case 'show-five-hour':
        case 'show-seven-day':
            this._applyVisibility();
            break;
        case 'high-threshold':
            this._render();
            break;
        case 'credentials-path':
            this._refresh();
            break;
        }
    }

    _applyVisibility() {
        this._five.visible = this._settings.get_boolean('show-five-hour');
        this._seven.visible = this._settings.get_boolean('show-seven-day');
    }

    _credPath() {
        const p = this._settings.get_string('credentials-path');
        return p && p.length ? p : defaultCredPath();
    }

    _fmtReset(iso) {
        if (!iso)
            return '--';
        try {
            const dt = GLib.DateTime.new_from_iso8601(iso, null);
            return dt ? dt.to_local().format('%m-%d %H:%M') : '--';
        } catch (e) {
            return '--';
        }
    }

    _render() {
        const high = this._settings.get_int('high-threshold');
        const {five, seven, note, stale} = this._data;
        this._five.setValue(five?.utilization ?? null, high, stale);
        this._seven.setValue(seven?.utilization ?? null, high, stale);

        // Error with no prior value to fall back on: show the reason instead.
        if (note && five == null && seven == null) {
            this._fiveItem.label.text = `5h: ${note}`;
            this._sevenItem.label.text = '7d: --';
            return;
        }
        const plus = stale ? '+' : '';
        const why = stale && note ? `  (${note})` : '';
        this._fiveItem.label.text =
            `5h: ${five?.utilization ?? '--'}${plus}%  ${_('resets')} ${this._fmtReset(five?.resets_at)}${why}`;
        this._sevenItem.label.text =
            `7d: ${seven?.utilization ?? '--'}${plus}%  ${_('resets')} ${this._fmtReset(seven?.resets_at)}${why}`;
    }

    _setData(five, seven) {
        this._last = {five, seven};
        this._data = {five, seven, note: null, stale: false};
        this._render();
    }

    _setUnavailable(note) {
        // Keep the last good values (shown stale with a '+') instead of '--%'.
        this._data = {
            five: this._last.five,
            seven: this._last.seven,
            note,
            stale: true,
        };
        this._render();
    }

    _refresh() {
        const token = readToken(this._credPath());
        if (!token) {
            this._setUnavailable(_('no token'));
            return;
        }

        const msg = Soup.Message.new('GET', ENDPOINT);
        const h = msg.get_request_headers();
        h.append('Authorization', 'Bearer ' + token);
        h.append('anthropic-beta', BETA);
        h.append('anthropic-version', '2023-06-01');
        h.append('User-Agent', 'claude-cli');

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                let bytes;
                try {
                    bytes = sess.send_and_read_finish(res);
                } catch (e) {
                    this._setUnavailable(_('net error'));
                    return;
                }

                // GJS throws "<code> is not a valid value for enumeration
                // Status" for HTTP codes outside the Soup.Status enum (e.g.
                // 429 rate limit), so read the status defensively.
                let status;
                try {
                    status = msg.get_status();
                } catch (e) {
                    const m = /\b(\d{3})\b/.exec(e.message ?? '');
                    status = m ? Number(m[1]) : 0;
                }
                if (status !== 200) {
                    this._setUnavailable(
                        status === 429 ? _('rate limited') : `HTTP ${status}`);
                    return;
                }

                let j;
                try {
                    j = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (e) {
                    this._setUnavailable(_('parse error'));
                    return;
                }

                this._setData(j?.five_hour ?? null, j?.seven_day ?? null);
            });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(
            this.getSettings(), () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
