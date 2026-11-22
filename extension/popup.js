document.addEventListener('DOMContentLoaded', () => {
  const apiBaseEl = document.getElementById('apiBase');
  const extKeyEl = document.getElementById('extKey');
  const autoListenEl = document.getElementById('autoListen');
  const statusBox = document.getElementById('statusBox');

  function refreshUI() {
    chrome.storage.local.get(['apiBase', 'extKey', 'autoListen', 'activeTask', 'lastLog'], (res) => {
      const savedBase = String(res.apiBase || '').trim().replace(/\/+$/, '');
      apiBaseEl.value = !savedBase || savedBase === 'https://api.arorashop.com' ? 'https://ff.uniqbd.com' : savedBase;
      if (res.extKey) extKeyEl.value = res.extKey;
      autoListenEl.checked = Boolean(res.autoListen);
      if (res.activeTask) {
        statusBox.textContent = `Active: ${res.activeTask.order_utr} (UID: ${res.activeTask.player_uid})`;
      } else {
        statusBox.textContent = res.lastLog || 'Idle';
      }
    });
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    chrome.storage.local.set(
      {
        apiBase: apiBaseEl.value.trim() || 'https://ff.uniqbd.com',
        extKey: extKeyEl.value.trim(),
        autoListen: autoListenEl.checked,
        lastLog: 'Settings saved',
      },
      () => refreshUI()
    );
  });

  autoListenEl.addEventListener('change', () => {
    chrome.storage.local.set({ autoListen: autoListenEl.checked }, () => refreshUI());
  });

  document.getElementById('pollBtn').addEventListener('click', () => {
    statusBox.textContent = 'Checking queue...';
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }, () => refreshUI());
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVE_TASK' }, () => refreshUI());
  });

  refreshUI();
});
