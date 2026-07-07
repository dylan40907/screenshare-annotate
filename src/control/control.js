const $ = (id) => document.getElementById(id);

// ── Set this to your deployed server before building ──
// e.g. 'wss://annotate.example.com'  (append '?token=SECRET' if you set JOIN_TOKEN)
const DEFAULT_SERVER = 'ws://localhost:4321';

let role = 'share';
let shareType = 'window';
let windows = [];

// Restore last-used settings.
$('server').value = localStorage.getItem('server') || DEFAULT_SERVER;
$('room').value = localStorage.getItem('room') || '';
$('name').value = localStorage.getItem('name') || '';

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
}

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

$('connect').addEventListener('click', () => {
  const server = $('server').value.trim();
  const room = $('room').value.trim();
  const name = $('name').value.trim();
  if (!server || !room || !name) {
    $('status').textContent = 'Server, room, and name are all required.';
    return;
  }
  localStorage.setItem('server', server);
  localStorage.setItem('room', room);
  localStorage.setItem('name', name);

  const cfg = { serverUrl: server, room, name, role };

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

updateUI();
loadDisplays();
