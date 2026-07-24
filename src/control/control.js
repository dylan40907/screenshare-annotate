const $ = (id) => document.getElementById(id);

let role = 'share';
let shareType = 'screen';
let windows = [];
let config = { username: '', serverUrl: '', screenshotDir: '' };

// Room persists locally (changes per session); name/server/folder live in the
// app config (persist across updates, edited in Settings).
$('room').value = localStorage.getItem('room') || '';

document.querySelectorAll('.role').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    role = btn.dataset.role;
    updateUI();
  });
});

document.querySelectorAll('.stype').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stype').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    shareType = btn.dataset.stype;
    updateUI();
  });
});

function updateUI() {
  $('shareOnly').style.display = role === 'share' ? 'block' : 'none';
  $('viewOnly').style.display = role === 'view' ? 'block' : 'none';
  if (role === 'share') {
    $('windowPick').style.display = shareType === 'window' ? 'block' : 'none';
    $('screenPick').style.display = shareType === 'screen' ? 'block' : 'none';
    if (shareType === 'window' && windows.length === 0) loadWindows();
  }
  fitWindow();
}

function fitWindow() {
  requestAnimationFrame(() => window.api.setControlHeight(document.body.scrollHeight + 2));
}

// ---- settings view ----

function showSettings(firstRun) {
  $('mainView').style.display = 'none';
  $('settingsView').style.display = 'block';
  $('settingsHint').textContent = firstRun ? 'Welcome! Set your name to get started.' : '';
  $('settingsHint').style.display = firstRun ? 'block' : 'none';
  $('username').value = config.username || '';
  $('server').value = config.serverUrl || '';
  $('folderPath').textContent = config.screenshotDir || '';
  fitWindow();
}
function showMain() {
  $('settingsView').style.display = 'none';
  $('mainView').style.display = 'block';
  updateUI();
}

$('gear').addEventListener('click', () => showSettings(false));

$('settingsDone').addEventListener('click', () => {
  const name = $('username').value.trim();
  if (!name) { $('username').focus(); return; }
  config.username = name;
  config.serverUrl = $('server').value.trim() || config.serverUrl;
  window.api.setConfig({ username: config.username, serverUrl: config.serverUrl });
  showMain();
});

$('chooseShotDir').addEventListener('click', async () => {
  const r = await window.api.chooseScreenshotDir();
  if (r && r.dir) { config.screenshotDir = r.dir; $('folderPath').textContent = r.dir; fitWindow(); }
});

// ---- displays / windows ----

async function loadDisplays() {
  const displays = await window.api.getDisplays();
  [$('displayShare'), $('displayView')].forEach((sel) => {
    sel.innerHTML = '';
    displays.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      sel.appendChild(opt);
    });
  });
}

async function loadWindows() {
  const sel = $('windowSel');
  sel.innerHTML = '<option>Loading…</option>';
  windows = await window.api.getWindows();
  sel.innerHTML = '';
  if (windows.length === 0) {
    sel.innerHTML = '<option value="">No windows found - try refresh</option>';
    return;
  }
  windows.forEach((w, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${w.title}  (${w.w}×${w.h})`;
    sel.appendChild(opt);
  });
}

$('refreshWins').addEventListener('click', (e) => { e.preventDefault(); loadWindows(); });

// ---- launch ----

$('connect').addEventListener('click', () => {
  const room = $('room').value.trim();
  if (!config.username) { showSettings(true); return; }
  if (!room) { $('status').textContent = 'Enter a room name.'; return; }
  localStorage.setItem('room', room);

  const cfg = { serverUrl: config.serverUrl, room, name: config.username, role };
  if (role === 'share' && shareType === 'window') {
    const idx = Number($('windowSel').value);
    const win = windows[idx];
    if (!win) { $('status').textContent = 'Pick a window to share (or refresh the list).'; return; }
    cfg.shareType = 'window';
    cfg.window = win;
  } else if (role === 'share') {
    cfg.shareType = 'screen';
    cfg.displayId = Number($('displayShare').value);
    cfg.inset = 0;
  } else {
    cfg.displayId = Number($('displayView').value);
  }
  window.api.connect(cfg);
});

// ---- boot ----

(async function init() {
  config = await window.api.getConfig();
  await loadDisplays();
  if (!config.username) showSettings(true); // first launch: ask for a name
  else showMain();
})();
