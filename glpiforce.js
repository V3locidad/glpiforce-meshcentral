/**
 * MeshCentral plugin: glpiforce
 *
 * Two jobs:
 *   1. Query GLPI's REST API to surface which Windows machines have not
 *      reported an inventory in the last N days (configurable).
 *   2. Send a PowerShell to selected MeshCentral agents asking the local
 *      GLPI Agent to push an inventory now. The PowerShell side lives in
 *      the iframe (we already learned MC plugins cannot capture
 *      runcommands replies on this build — fire-and-forget is fine).
 *
 * GLPI credentials and URL live in glpi-config.json in the plugin
 * directory and are never exposed to the browser.
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var url = require('url');

module.exports.glpiforce = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = ['onDeviceRefreshEnd'];

    var configFile = path.join(__dirname, 'glpi-config.json');

    function loadConfig() {
        try {
            var c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (!c.glpiUrl) throw new Error('glpiUrl missing');
            if (!c.userToken) throw new Error('userToken missing');
            // appToken is optional: GLPI 10 lets you create an API client that
            // does not require it (or skip API clients entirely on small setups).
            if (typeof c.staleAfterDays !== 'number') c.staleAfterDays = 7;
            return c;
        } catch (e) {
            return null;
        }
    }

    // -------- session cache --------
    // GLPI requires initSession before any other call. We cache the session
    // token and reuse it. If a call comes back 401 we drop the cache and retry.
    var session = { token: null, at: 0 };
    var SESSION_TTL_MS = 30 * 60 * 1000;   // GLPI default session is 1h; we refresh sooner.

    function rawCall(method, apiPath, headers, body) {
        return new Promise(function (resolve, reject) {
            var cfg = loadConfig();
            if (!cfg) return reject(new Error('glpi-config.json missing or invalid'));
            var u = url.parse(cfg.glpiUrl);
            var isHttps = (u.protocol === 'https:');
            var lib = isHttps ? https : http;
            var basePath = (u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '') + '/apirest.php';
            var fullPath = basePath + apiPath;
            var bodyStr = body ? JSON.stringify(body) : null;
            var hdrs = Object.assign({ 'Accept': 'application/json' }, headers || {});
            if (cfg.appToken) hdrs['App-Token'] = cfg.appToken;
            if (bodyStr) {
                hdrs['Content-Type'] = 'application/json';
                hdrs['Content-Length'] = Buffer.byteLength(bodyStr);
            }
            var opts = {
                host: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: fullPath,
                method: method,
                headers: hdrs
            };
            if (isHttps && cfg.rejectUnauthorized === false) opts.rejectUnauthorized = false;
            var req = lib.request(opts, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () {
                    var text = Buffer.concat(chunks).toString('utf8');
                    var data = null;
                    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
                    resolve({ status: res.statusCode, headers: res.headers, data: data });
                });
            });
            req.on('error', function (err) { reject(err); });
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    function getSession(force) {
        if (!force && session.token && (Date.now() - session.at) < SESSION_TTL_MS) {
            return Promise.resolve(session.token);
        }
        var cfg = loadConfig();
        if (!cfg) return Promise.reject(new Error('glpi-config.json missing or invalid'));
        // GLPI accepts either basic auth (user_token via Authorization header) or
        // a JSON body. The Authorization header form is simpler.
        var headers = { 'Authorization': 'user_token ' + cfg.userToken };
        return rawCall('GET', '/initSession', headers, null).then(function (r) {
            if (r.status !== 200 || !r.data || !r.data.session_token) {
                var msg = r.data && (r.data[1] || r.data.message || r.data.raw);
                throw new Error('initSession failed (' + r.status + '): ' + (msg || 'no session_token'));
            }
            session.token = r.data.session_token;
            session.at = Date.now();
            return session.token;
        });
    }

    function glpiCall(method, apiPath, body, retryOn401) {
        return getSession(false).then(function (token) {
            return rawCall(method, apiPath, { 'Session-Token': token }, body);
        }).then(function (r) {
            if (r.status === 401 && retryOn401 !== false) {
                session.token = null;
                return glpiCall(method, apiPath, body, false);
            }
            if (r.status < 200 || r.status >= 300) {
                var msg = (r.data && (r.data[1] || r.data.message || r.data.raw)) || ('HTTP ' + r.status);
                throw new Error('GLPI ' + r.status + ': ' + msg);
            }
            return r;
        });
    }

    obj.server_startup = function () {};

    obj.onDeviceRefreshEnd = function () {
        pluginHandler.registerPluginTab({
            tabTitle: "GLPI",
            tabId: "pluginGlpiforce"
        });
        var container = document.getElementById('pluginGlpiforce');
        if (container && !container.querySelector('iframe')) {
            QA('pluginGlpiforce',
                '<iframe src="/pluginadmin.ashx?pin=glpiforce&user=1" ' +
                'style="width:100%;height:760px;border:0"></iframe>');
        }
    };

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
    }

    obj.handleAdminReq = function (req, res, user) {
        var action = req.query && req.query.action;

        // -------- ping: smoke test for config + connectivity --------
        if (action === 'ping') {
            var cfg = loadConfig();
            if (!cfg) return sendJson(res, 200, { ok: false, error: 'glpi-config.json missing or invalid' });
            return getSession(true).then(function () {
                sendJson(res, 200, { ok: true, glpiUrl: cfg.glpiUrl, staleAfterDays: cfg.staleAfterDays });
            }).catch(function (e) { sendJson(res, 200, { ok: false, error: e.message }); });
        }

        // -------- computers: list all Computer entries with name + date_mod --------
        // GLPI's search API returns paginated results. We page through with Range
        // headers — 200 per page is a good balance.
        if (action === 'computers') {
            var cfgC = loadConfig();
            if (!cfgC) return sendJson(res, 500, { error: 'config invalid' });
            var pageSize = 200;
            var all = [];
            function fetchPage(start) {
                return getSession(false).then(function (token) {
                    var hdrs = {
                        'Session-Token': token,
                        'Range': start + '-' + (start + pageSize - 1)
                    };
                    return rawCall('GET', '/Computer?expand_dropdowns=false&with_softwares=false&only_id=false', hdrs, null);
                }).then(function (r) {
                    if (r.status === 401) { session.token = null; return fetchPage(start); }
                    if (r.status >= 400) throw new Error('GLPI ' + r.status + ': ' + JSON.stringify(r.data).slice(0, 200));
                    var arr = Array.isArray(r.data) ? r.data : [];
                    arr.forEach(function (c) {
                        all.push({ id: c.id, name: c.name, date_mod: c.date_mod, is_deleted: c.is_deleted });
                    });
                    if (r.status === 206 && arr.length === pageSize) return fetchPage(start + pageSize);
                    return all;
                });
            }
            return fetchPage(0)
                .then(function (list) {
                    var nowMs = Date.now();
                    var staleMs = (cfgC.staleAfterDays || 7) * 86400000;
                    list = list.filter(function (c) { return !c.is_deleted; });
                    list.forEach(function (c) {
                        var t = c.date_mod ? Date.parse(c.date_mod.replace(' ', 'T') + 'Z') : NaN;
                        c.staleDays = isFinite(t) ? Math.floor((nowMs - t) / 86400000) : null;
                        c.stale = c.staleDays != null && (c.staleDays * 86400000) >= staleMs;
                    });
                    sendJson(res, 200, { computers: list, staleAfterDays: cfgC.staleAfterDays });
                })
                .catch(function (e) { sendJson(res, 500, { error: e.message }); });
        }

        // -------- default: render the plugin view --------
        res.render(path.join(__dirname, 'views/glpiforce'), { user: user });
    };

    return obj;
};
