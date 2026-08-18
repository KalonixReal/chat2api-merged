/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
function authHeaders() {
  return window.API_KEY ? { Authorization: 'Bearer ' + window.API_KEY } : {};
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(),
    m = d.getMinutes(),
    s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0 || s > 0) parts.push(s + 's');
  return parts.join(' ');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function createPoller(fn, baseInterval) {
  var timer = null,
    failures = 0,
    running = false;
  function tick() {
    if (!running) return;
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        r.then(
          function () {
            failures = 0;
            schedule();
          },
          function () {
            failures++;
            schedule();
          },
        );
        return;
      }
      failures = 0;
    } catch {
      failures++;
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    var delay = Math.min(baseInterval * Math.pow(2, Math.min(failures, 3)), baseInterval * 8);
    timer = setTimeout(tick, delay);
  }
  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function start() {
    if (!running) {
      running = true;
      failures = 0;
      tick();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  start();
  return { start: start, stop: stop };
}

/* ── Dark Mode ── */
function applyDarkMode(enabled) {
  var html = document.documentElement;
  var label = document.getElementById('dmLabel');
  var sw = document.getElementById('dmSwitch');
  var moon = document.getElementById('dmMoon');
  var sun = document.getElementById('dmSun');
  if (enabled) {
    html.classList.add('dark-mode');
    if (label) label.textContent = 'Dark';
    if (moon) moon.style.display = '';
    if (sun) sun.style.display = 'none';
    if (sw) sw.classList.add('active');
  } else {
    html.classList.remove('dark-mode');
    if (label) label.textContent = 'Light';
    if (moon) moon.style.display = 'none';
    if (sun) sun.style.display = '';
    if (sw) sw.classList.remove('active');
  }
}

async function toggleDarkMode() {
  var next = !document.documentElement.classList.contains('dark-mode');
  applyDarkMode(next);
  try {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.API_KEY },
      body: JSON.stringify({ DARK_MODE: String(next) }),
    });
  } catch (e) {
    console.error('Failed to save dark mode preference:', e);
  }
}

/* Apply dark mode on load */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    applyDarkMode(window.DARK_MODE);
  });
} else {
  applyDarkMode(window.DARK_MODE);
}

/* ── Account action notifications ── */
var accountLastAlertId = 0;
var accountVisibleAlertCount = 0;
try {
  accountLastAlertId =
    Number(localStorage.getItem('qwenGateAccountLastAlertId')) ||
    Number(localStorage.getItem('qwenGateCaptchaLastAlertId')) ||
    0;
} catch {}

function rememberAccountAlert(id) {
  accountLastAlertId = Math.max(accountLastAlertId, Number(id) || 0);
  try {
    localStorage.setItem('qwenGateAccountLastAlertId', String(accountLastAlertId));
  } catch {}
}

function removeAccountNotificationToggle() {
  var button = document.getElementById('accountNotificationToggle');
  if (button) button.remove();
}

function ensureAccountNotificationToggle() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (document.getElementById('accountNotificationToggle')) return;

  var button = document.createElement('button');
  button.id = 'accountNotificationToggle';
  button.className = 'captcha-notification-toggle';
  button.type = 'button';
  button.textContent = 'Enable account alerts';
  button.addEventListener('click', async function () {
    try {
      var permission = await Notification.requestPermission();
      if (permission === 'granted') removeAccountNotificationToggle();
      else button.textContent = 'Account alerts blocked';
    } catch {
      button.textContent = 'Notifications unavailable';
    }
  });
  document.body.appendChild(button);
}

function openAccountsPage() {
  window.focus();
  window.location.href = '/dashboard/accounts';
}

function accountAlertPresentation(alert) {
  var maskedEmail = alert.maskedEmail || 'unknown account';
  if (alert.kind === 'throttled') {
    var until = alert.throttledUntil ? new Date(alert.throttledUntil).toLocaleString() : 'the cooldown ends';
    return {
      title: 'Qwen Gate account throttled',
      message: maskedEmail + ' is throttled until ' + until + '.',
      body: maskedEmail + ' cannot receive requests until ' + until + '.',
      requireInteraction: false,
    };
  }
  if (alert.kind === 'manual_login') {
    return {
      title: 'Qwen Gate login required',
      message: maskedEmail + ' needs a manual login.',
      body: maskedEmail + ' could not sign in automatically. Open Accounts and click Login.',
      requireInteraction: true,
    };
  }
  return {
    title: 'Qwen Gate needs human verification',
    message: maskedEmail + ' needs CAPTCHA verification.',
    body: maskedEmail + ' requires a CAPTCHA. Open Accounts to solve it.',
    requireInteraction: true,
  };
}

function showAccountActionAlert(alert) {
  accountVisibleAlertCount++;
  var presentation = accountAlertPresentation(alert);
  var banner = document.getElementById('accountActionBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'accountActionBanner';
    banner.className = 'captcha-action-banner';
    banner.setAttribute('role', 'alert');

    var message = document.createElement('span');
    message.className = 'captcha-action-message';
    banner.appendChild(message);

    var openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = 'Open Accounts';
    openButton.addEventListener('click', openAccountsPage);
    banner.appendChild(openButton);

    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'captcha-action-close';
    closeButton.setAttribute('aria-label', 'Dismiss account alert');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', function () {
      banner.remove();
      accountVisibleAlertCount = 0;
    });
    banner.appendChild(closeButton);
    document.body.appendChild(banner);
  }

  var messageEl = banner.querySelector('.captcha-action-message');
  if (messageEl) {
    var prefix = accountVisibleAlertCount > 1 ? accountVisibleAlertCount + ' account alerts. Latest: ' : '';
    messageEl.textContent = prefix + presentation.message;
  }

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      var notification = new Notification(presentation.title, {
        body: presentation.body,
        icon: '/dashboard/static/logo.svg',
        tag: 'qwen-gate-' + (alert.kind || 'account') + '-' + (alert.maskedEmail || 'unknown'),
        renotify: true,
        requireInteraction: presentation.requireInteraction,
      });
      notification.onclick = openAccountsPage;
    } catch {}
  } else {
    ensureAccountNotificationToggle();
  }
}

async function pollAccountAlerts() {
  var result = await apiFetch('/dashboard/account-alerts?after=' + encodeURIComponent(accountLastAlertId));
  if (!result || !Array.isArray(result.alerts)) return;
  for (var i = 0; i < result.alerts.length; i++) {
    var alert = result.alerts[i];
    showAccountActionAlert(alert);
    rememberAccountAlert(alert.id);
  }
}

function startAccountNotifications() {
  ensureAccountNotificationToggle();
  pollAccountAlerts();
  setInterval(pollAccountAlerts, 3000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAccountNotifications);
else startAccountNotifications();
