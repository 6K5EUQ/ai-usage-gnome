/*
 * AI Usage — GNOME Shell top-bar indicator for Claude.ai and Codex usage.
 *
 * Copyright (C) 2026 the AI Usage contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Claude data source: GET https://api.anthropic.com/api/oauth/usage (the same
 * endpoint the Claude Code `/usage` command uses), authenticated with the
 * OAuth access token stored in ~/.claude/.credentials.json. This is an
 * undocumented internal endpoint and may change without notice.
 *
 * Codex data source: the latest `rate_limits` object written to local Codex
 * session JSONL files for the current local user. No network request or
 * token is used.
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

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_BETA = 'oauth-2025-04-20';
const CODEX_MAX_SESSION_FILES = 50;

function defaultClaudeCredPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

function readClaudeToken(path) {
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

function codexSessionsPath() {
    const codexHome = GLib.getenv('CODEX_HOME');
    if (codexHome && codexHome.length > 0)
        return GLib.build_filenamev([codexHome, 'sessions']);

    return GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'sessions']);
}

function readTextFile(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

function collectJsonlFiles(path) {
    const root = Gio.File.new_for_path(path);
    const files = [];

    function walk(dir, depth) {
        if (depth > 8)
            return;

        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return;
        }

        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const child = dir.get_child(name);
                const type = info.get_file_type();

                if (type === Gio.FileType.DIRECTORY) {
                    walk(child, depth + 1);
                    continue;
                }

                if (!name.endsWith('.jsonl'))
                    continue;

                files.push({
                    path: child.get_path(),
                    mtime: info.get_attribute_uint64('time::modified'),
                });
            }
        } finally {
            enumerator.close(null);
        }
    }

    walk(root, 0);
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, CODEX_MAX_SESSION_FILES);
}

function findLatestCodexRateLimits(path) {
    const files = collectJsonlFiles(path);
    for (const file of files) {
        const text = readTextFile(file.path);
        if (!text)
            continue;

        const lines = text.trimEnd().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line.includes('"rate_limits"'))
                continue;

            try {
                const event = JSON.parse(line);
                const rateLimits = event?.payload?.rate_limits ?? event?.rate_limits;
                if (!rateLimits?.primary && !rateLimits?.secondary)
                    continue;

                return {
                    primary: rateLimits.primary ?? null,
                    secondary: rateLimits.secondary ?? null,
                    planType: rateLimits.plan_type ?? null,
                    limitName: rateLimits.limit_name ?? rateLimits.limit_id ?? null,
                    reachedType: rateLimits.rate_limit_reached_type ?? null,
                    timestamp: event?.timestamp ?? null,
                };
            } catch (e) {
                continue;
            }
        }
    }

    return null;
}

function normalizeCodexWindow(window) {
    if (!window)
        return null;

    return {
        utilization: Number(window.used_percent),
        resets_at: window.resets_at,
        window_minutes: window.window_minutes,
    };
}

function codexWindowLabel(window, fallback) {
    const minutes = Number(window?.window_minutes);
    if (minutes === 300)
        return '5h';
    if (minutes === 10080)
        return '7d';
    if (minutes > 0 && minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes > 0 && minutes % 60 === 0)
        return `${minutes / 60}h`;
    if (minutes > 0)
        return `${minutes}m`;
    return fallback;
}

function logoGicon(extensionPath, fileName) {
    const path = GLib.build_filenamev([extensionPath, 'icons', fileName]);
    return Gio.FileIcon.new(Gio.File.new_for_path(path));
}

const UsageSection = GObject.registerClass(
class UsageSection extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'ai-usage-section',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.label = new St.Label({
            style_class: 'ai-usage-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '--%',
        });
        this.add_child(this.label);
    }

    setValue(util, high, stale) {
        if (util === null || util === undefined || Number.isNaN(util)) {
            this.label.text = '--%';
            this.remove_style_class_name('ai-usage-high');
            return;
        }
        const pct = Math.round(util);
        this.label.text = stale ? `${pct}+%` : `${pct}%`;
        if (pct >= high)
            this.add_style_class_name('ai-usage-high');
        else
            this.remove_style_class_name('ai-usage-high');
    }
});

// One provider's panel widgets (logo + 5h/7d sections) and menu items, with
// a provider-supplied _fetch() that resolves usage data or throws a reason.
const ProviderSection = GObject.registerClass(
class ProviderSection extends St.BoxLayout {
    _init(settings, extensionPath, menu, provider) {
        super._init({
            style_class: 'ai-usage-provider',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._settings = settings;
        this._provider = provider;
        this._timeoutId = 0;
        this._data = {five: null, seven: null, note: null, stale: false};
        this._last = {five: null, seven: null};

        this.add_child(new St.Icon({
            style_class: 'ai-usage-logo',
            gicon: logoGicon(extensionPath, provider.logo),
            icon_size: 16,
        }));

        this._five = new UsageSection();
        this._seven = new UsageSection();
        this.add_child(this._five);
        this.add_child(new St.Widget({style_class: 'ai-usage-separator-gap'}));
        this.add_child(this._seven);

        this._fiveItem = new PopupMenu.PopupMenuItem(`5h: --`, {reactive: false});
        this._sevenItem = new PopupMenu.PopupMenuItem(`7d: --`, {reactive: false});
        menu.addMenuItem(this._fiveItem);
        menu.addMenuItem(this._sevenItem);

        this._applyVisibility();
    }

    start() {
        this._refresh();
        this._scheduleRefresh();
    }

    scheduleRefresh() {
        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const interval = this._settings.get_int(this._provider.intervalKey);
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    applyVisibility() {
        this._applyVisibility();
    }

    _applyVisibility() {
        const shown = this._settings.get_boolean(this._provider.showKey);
        this.visible = shown;
        this._five.visible = shown && this._settings.get_boolean('show-five-hour');
        this._seven.visible = shown && this._settings.get_boolean('show-seven-day');
        this._fiveItem.visible = shown;
        this._sevenItem.visible = shown;
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

    render() {
        const high = this._settings.get_int('high-threshold');
        const {five, seven, note, stale} = this._data;
        this._five.setValue(five?.utilization ?? null, high, stale);
        this._seven.setValue(seven?.utilization ?? null, high, stale);

        const fiveLabel = this._provider.fiveLabel(five);
        const sevenLabel = this._provider.sevenLabel(seven);

        // Error with no prior value to fall back on: show the reason instead.
        if (note && five == null && seven == null) {
            this._fiveItem.label.text = `${fiveLabel}: ${note}`;
            this._sevenItem.label.text = `${sevenLabel}: --`;
            return;
        }
        const plus = stale ? '+' : '';
        const why = stale && note ? `  (${note})` : '';
        this._fiveItem.label.text =
            `${fiveLabel}: ${five?.utilization ?? '--'}${plus}%  ${_('resets')} ${this._fmtReset(five?.resets_at)}${why}`;
        this._sevenItem.label.text =
            `${sevenLabel}: ${seven?.utilization ?? '--'}${plus}%  ${_('resets')} ${this._fmtReset(seven?.resets_at)}${why}`;
    }

    refresh() {
        this._refresh();
    }

    _refresh() {
        this._provider.fetch(this._settings, (result, error) => {
            if (error) {
                this._setUnavailable(error);
                return;
            }
            this._setData(result.five, result.seven);
        });
    }

    _setData(five, seven) {
        this._last = {five, seven};
        this._data = {five, seven, note: null, stale: false};
        this.render();
    }

    _setUnavailable(note) {
        // Keep the last good values (shown stale with a '+') instead of '--%'.
        this._data = {
            five: this._last.five,
            seven: this._last.seven,
            note,
            stale: true,
        };
        this.render();
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

function makeClaudeProvider(session) {
    return {
        showKey: 'show-claude',
        intervalKey: 'claude-refresh-interval',
        logo: 'claude-logo.svg',
        fiveLabel: () => '5h',
        sevenLabel: () => '7d',
        fetch(settings, cb) {
            const p = settings.get_string('credentials-path');
            const credPath = p && p.length ? p : defaultClaudeCredPath();
            const token = readClaudeToken(credPath);
            if (!token) {
                cb(null, _('no token'));
                return;
            }

            const msg = Soup.Message.new('GET', CLAUDE_ENDPOINT);
            const h = msg.get_request_headers();
            h.append('Authorization', 'Bearer ' + token);
            h.append('anthropic-beta', CLAUDE_BETA);
            h.append('anthropic-version', '2023-06-01');
            h.append('User-Agent', 'claude-cli');

            session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                    let bytes;
                    try {
                        bytes = sess.send_and_read_finish(res);
                    } catch (e) {
                        cb(null, _('net error'));
                        return;
                    }

                    // GJS throws "<code> is not a valid value for enumeration
                    // Status" for HTTP codes outside the Soup.Status enum
                    // (e.g. 429 rate limit), so read the status defensively.
                    let status;
                    try {
                        status = msg.get_status();
                    } catch (e) {
                        const m = /\b(\d{3})\b/.exec(e.message ?? '');
                        status = m ? Number(m[1]) : 0;
                    }
                    if (status !== 200) {
                        cb(null, status === 429 ? _('rate limited') : `HTTP ${status}`);
                        return;
                    }

                    let j;
                    try {
                        j = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    } catch (e) {
                        cb(null, _('parse error'));
                        return;
                    }

                    cb({five: j?.five_hour ?? null, seven: j?.seven_day ?? null}, null);
                });
        },
    };
}

function makeCodexProvider() {
    return {
        showKey: 'show-codex',
        intervalKey: 'codex-refresh-interval',
        logo: 'chatgpt-logo.svg',
        fiveLabel: window => codexWindowLabel(window, '5h'),
        sevenLabel: window => codexWindowLabel(window, '7d'),
        fetch(settings, cb) {
            const rateLimits = findLatestCodexRateLimits(codexSessionsPath());
            if (!rateLimits) {
                cb(null, _('no rate limits'));
                return;
            }
            cb({
                five: normalizeCodexWindow(rateLimits.primary),
                seven: normalizeCodexWindow(rateLimits.secondary),
            }, null);
        },
    };
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(settings, extensionPath, openPrefs) {
        super._init(0.5, 'AI Usage');

        this._settings = settings;
        this._session = new Soup.Session();

        const box = new St.BoxLayout({style_class: 'ai-usage-box'});
        this.add_child(box);

        this._claude = new ProviderSection(
            settings, extensionPath, this.menu, makeClaudeProvider(this._session));
        box.add_child(this._claude);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._codex = new ProviderSection(
            settings, extensionPath, this.menu, makeCodexProvider());
        box.add_child(this._codex);

        this._providers = [this._claude, this._codex];

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Refresh now'), () => this._refreshAll());
        if (openPrefs)
            this.menu.addAction(_('Settings'), () => openPrefs());

        this._settingsChangedId = this._settings.connect(
            'changed', (_s, key) => this._onSettingsChanged(key));
    }

    start() {
        this._providers.forEach(p => p.start());
    }

    _refreshAll() {
        this._providers.forEach(p => p.refresh());
    }

    _onSettingsChanged(key) {
        switch (key) {
        case 'claude-refresh-interval':
            this._claude.scheduleRefresh();
            break;
        case 'codex-refresh-interval':
            this._codex.scheduleRefresh();
            break;
        case 'show-five-hour':
        case 'show-seven-day':
        case 'show-claude':
        case 'show-codex':
            this._providers.forEach(p => p.applyVisibility());
            break;
        case 'high-threshold':
            this._providers.forEach(p => p.render());
            break;
        case 'credentials-path':
            this._claude.refresh();
            break;
        }
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._providers.forEach(p => p.destroy());
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class AiUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(
            this.getSettings(), this.path, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
