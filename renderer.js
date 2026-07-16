// renderer.js - Frontend logic for Tower Heroes Macro UI

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const closeBtn = document.getElementById('close-btn');
  const mapSelect = document.getElementById('map-select');
  const difficultySelect = document.getElementById('difficulty-select');
  const resolutionSelect = document.getElementById('resolution-select');
  const statusPanel = document.getElementById('status-panel');

  function setStatus(message, level='info') {
    if (!statusPanel) return;
    statusPanel.textContent = message;
    statusPanel.className = `status-panel ${level}`;
    statusPanel.style.display = 'block';
    if (level !== 'error') {
      setTimeout(() => { statusPanel.style.display = 'none'; }, 4500);
    }
  }

  function getSelectedResolution() {
    return resolutionSelect ? resolutionSelect.value : '2560x1440';
  }

  window.electronAPI.onStatus((status) => {
    if (!status) return;
    const lower = status.toLowerCase();
    if (lower.includes('error') || lower.includes('warning')) {
      setStatus(status, lower.includes('error') ? 'error' : 'warning');
    } else {
      setStatus(status, 'info');
    }
  });

  // Start button
  startBtn.addEventListener('click', () => {
    const map = mapSelect.value;
    const difficulty = difficultySelect.value;
    const resolution = getSelectedResolution();
    window.electronAPI.runScript('start', map, difficulty, resolution);
  });

  // Stop button
  stopBtn.addEventListener('click', () => {
    const map = mapSelect.value;
    const difficulty = difficultySelect.value;
    const resolution = getSelectedResolution();
    window.electronAPI.runScript('stop', map, difficulty, resolution);
  });

  // Close button
  closeBtn.addEventListener('click', () => {
    window.electronAPI.close();
  });

  // Hotkey listener
  window.electronAPI.onHotkey((action) => {
    if (action === 'play') {
      startBtn.click();
    } else if (action === 'stop' || action === 'pause') {
      stopBtn.click();
    }
  });
});