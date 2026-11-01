// The status page (status.html): reads status.json, which .github/workflows/status.yml publishes
// on the repository's status-data branch every ~5 minutes, and draws it. Everything is built
// with textContent, never HTML strings, since issue titles come from GitHub.
(function () {
  'use strict';

  var DATA_URL = 'https://raw.githubusercontent.com/KIvanow/spend-brake/status-data/status.json';
  // A local preview (a static server in website/) reads a sample status.json next to the page.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) DATA_URL = '/status.json';

  var DAYS = 90;
  var DAY_MS = 86400000;
  var LATE_MS = 20 * 60000; // three missed runs
  var REFETCH_MS = 5 * 60000;

  var data = null;
  var failed = false;

  function $(id) {
    return document.getElementById(id);
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function time(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }
  function ago(ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + ' h ago';
    return Math.round(hours / 24) + ' days ago';
  }
  function span(ms) {
    var minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + ' h ' + (minutes % 60) + ' min';
    return Math.round(hours / 24) + ' days';
  }
  function date(t) {
    return new Date(t).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  function dayKey(t) {
    return new Date(t).toISOString().slice(0, 10);
  }
  function percent(up, checks) {
    var p = (up / checks) * 100;
    if (p === 100) return '100%';
    // Never round a bad day up to 100%.
    return (Math.floor(p * 100) / 100).toFixed(2) + '%';
  }
  function band(up, checks) {
    if (!checks) return 'none';
    if (up === checks) return 'u100';
    var p = (up / checks) * 100;
    if (p >= 99) return 'u99';
    if (p >= 95) return 'u95';
    return 'u0';
  }
  function hostOf(url) {
    try {
      var u = new URL(url);
      return u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch {
      return '';
    }
  }

  function renderBanner() {
    var banner = $('banner');
    var services = data && Array.isArray(data.services) ? data.services : [];
    if (!services.length) {
      banner.className = 'banner';
      banner.textContent = failed
        ? 'Status unavailable: the latest checks could not be loaded.'
        : 'No checks recorded yet.';
      return;
    }
    var down = services.filter(function (s) {
      return !s.up;
    });
    if (!down.length) {
      banner.className = 'banner ok';
      banner.textContent = 'All systems operational';
    } else {
      banner.className = 'banner down';
      var names = down.map(function (s) {
        return s.name;
      });
      banner.textContent =
        down.length === services.length
          ? 'All services are down'
          : names.join(', ') + (down.length === 1 ? ' is down' : ' are down');
    }
  }

  function renderUpdated() {
    var p = $('updated');
    var updated = data && time(data.updatedAt);
    var note = 'Checks run every ~5 minutes from GitHub Actions.';
    p.className = 'updated';
    if (updated == null) {
      p.textContent = (failed ? 'Could not load status.json. ' : '') + note;
      return;
    }
    var late = Date.now() - updated > LATE_MS;
    if (late) p.className = 'updated late';
    p.textContent =
      'Updated ' +
      ago(Date.now() - updated) +
      (late ? ' (the checks are running late; these are the last results).' : '.') +
      ' ' +
      note;
    p.title = new Date(updated).toISOString();
  }

  function renderServices() {
    var list = $('services');
    clear(list);
    var services = data && Array.isArray(data.services) ? data.services : [];
    var days = (data && data.days) || {};
    var today = Date.now();

    services.forEach(function (s) {
      var item = el('li', 'service');
      var head = el('div', 'head');
      head.appendChild(el('h3', null, s.name));
      head.appendChild(el('span', 'host', hostOf(s.url)));
      var now = el('div', 'now');
      if (s.up) {
        now.appendChild(el('span', 'latency', s.latencyMs + ' ms'));
        now.appendChild(el('span', 'pill up', 'Operational'));
      } else {
        var pill = el('span', 'pill down', 'Down');
        if (s.error) pill.title = s.error;
        now.appendChild(pill);
      }
      head.appendChild(now);
      item.appendChild(head);

      var bar = el('div', 'bar');
      var totalChecks = 0;
      var totalUp = 0;
      for (var i = DAYS - 1; i >= 0; i--) {
        var key = dayKey(today - i * DAY_MS);
        var counts = days[key] && days[key][s.id];
        var checks = counts ? Number(counts.checks) || 0 : 0;
        var up = counts ? Number(counts.up) || 0 : 0;
        totalChecks += checks;
        totalUp += up;
        var cell = el('i', band(up, checks));
        cell.title = checks
          ? key + ': ' + percent(up, checks) + ' (' + up + ' of ' + checks + ' checks)'
          : key + ': no data';
        bar.appendChild(cell);
      }
      var overall = totalChecks ? percent(totalUp, totalChecks) : null;
      bar.setAttribute('role', 'img');
      bar.setAttribute(
        'aria-label',
        s.name +
          ' uptime over the last ' +
          DAYS +
          ' days: ' +
          (overall ? overall : 'no data yet') +
          '.',
      );
      item.appendChild(bar);

      var scale = el('div', 'scale');
      scale.appendChild(el('span', null, DAYS + ' days ago'));
      var middle = el('span');
      if (overall) {
        middle.appendChild(el('b', null, overall));
        middle.appendChild(document.createTextNode(' uptime'));
      } else {
        middle.textContent = 'no data yet';
      }
      scale.appendChild(middle);
      scale.appendChild(el('span', null, 'Today'));
      item.appendChild(scale);
      list.appendChild(item);
    });
  }

  function renderIncidents() {
    var list = $('incidents');
    clear(list);
    var incidents = data && Array.isArray(data.incidents) ? data.incidents : null;
    if (!incidents || !incidents.length) {
      list.appendChild(
        el(
          'li',
          'none',
          incidents ? 'No incidents recorded.' : failed ? 'Incidents could not be loaded.' : '-',
        ),
      );
      return;
    }
    incidents.forEach(function (inc) {
      var item = el('li');
      var link = el('a', null, inc.title);
      if (/^https:\/\/github\.com\//.test(inc.url || '')) link.href = inc.url;
      item.appendChild(link);
      var open = inc.state === 'open';
      item.appendChild(el('span', 'tag ' + (open ? 'open' : 'closed'), open ? 'Open' : 'Resolved'));
      var opened = time(inc.createdAt);
      var closed = time(inc.closedAt);
      var when = opened != null ? 'Opened ' + date(opened) : '';
      if (!open && opened != null && closed != null) {
        when += ', resolved after ' + span(closed - opened);
      }
      if (when) item.appendChild(el('span', 'when', when));
      list.appendChild(item);
    });
  }

  function render() {
    renderBanner();
    renderUpdated();
    renderServices();
    renderIncidents();
  }

  function load() {
    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        data = json && typeof json === 'object' ? json : null;
        failed = !data;
        render();
      })
      .catch(function () {
        // Keep showing the last good data, if any.
        failed = true;
        render();
      });
  }

  load();
  setInterval(load, REFETCH_MS);
  setInterval(renderUpdated, 30000);
})();
