document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('captureBtn');
  const seekPrevBtn = document.getElementById('seekPrevBtn');
  const seekNextBtn = document.getElementById('seekNextBtn');
  const seekStepValueInput = document.getElementById('seekStepValue');
  const seekStepUnitSelect = document.getElementById('seekStepUnit');
  const includeSubtitles = document.getElementById('includeSubtitles');
  const autoDownload = document.getElementById('autoDownload');
  const formatSelect = document.getElementById('format');
  const statusDiv = document.getElementById('status');
  const previewDiv = document.getElementById('preview');
  const previewImage = document.getElementById('previewImage');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');
  const DEFAULT_SEEK_SETTINGS = {
    seekStepValue: 1,
    seekStepUnit: 'frames',
    seekMethod: 'auto'
  };

  let lastScreenshot = null;

  // Load saved settings
  chrome.storage.local.get([
    'includeSubtitles',
    'autoDownload',
    'format',
    'seekStepValue',
    'seekStepUnit'
  ], (result) => {
    if (result.includeSubtitles !== undefined) {
      includeSubtitles.checked = result.includeSubtitles;
    }
    if (result.autoDownload !== undefined) {
      autoDownload.checked = result.autoDownload;
    }
    // Default format to jpeg if not set
    formatSelect.value = result.format || 'jpeg';

    const seekSettings = normalizeSeekSettings(result);
    seekStepValueInput.value = seekSettings.seekStepValue;
    seekStepUnitSelect.value = seekSettings.seekStepUnit;
  });

  // Save settings on change
  includeSubtitles.addEventListener('change', () => {
    chrome.storage.local.set({ includeSubtitles: includeSubtitles.checked });
  });

  autoDownload.addEventListener('change', () => {
    chrome.storage.local.set({ autoDownload: autoDownload.checked });
  });

  formatSelect.addEventListener('change', () => {
    chrome.storage.local.set({ format: formatSelect.value });
  });

  seekStepValueInput.addEventListener('change', saveSeekSettings);
  seekStepUnitSelect.addEventListener('change', saveSeekSettings);

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  function hideStatus() {
    statusDiv.className = 'status';
  }

  function normalizeSeekSettings(rawSettings = {}) {
    const unit = rawSettings.seekStepUnit === 'seconds' ? 'seconds' : DEFAULT_SEEK_SETTINGS.seekStepUnit;
    const numericValue = Number(rawSettings.seekStepValue);

    let seekStepValue = Number.isFinite(numericValue) && numericValue > 0
      ? numericValue
      : DEFAULT_SEEK_SETTINGS.seekStepValue;

    if (unit === 'frames') {
      seekStepValue = Math.max(1, Math.round(seekStepValue));
    } else {
      seekStepValue = Math.max(0.01, Number(seekStepValue.toFixed(3)));
    }

    return {
      seekStepValue,
      seekStepUnit: unit,
      seekMethod: DEFAULT_SEEK_SETTINGS.seekMethod
    };
  }

  function saveSeekSettings() {
    const seekSettings = normalizeSeekSettings({
      seekStepValue: seekStepValueInput.value,
      seekStepUnit: seekStepUnitSelect.value
    });

    seekStepValueInput.value = seekSettings.seekStepValue;
    seekStepUnitSelect.value = seekSettings.seekStepUnit;
    chrome.storage.local.set(seekSettings);
  }

  function formatSeekLabel(value, unit) {
    const suffix = value === 1 ? unit.slice(0, -1) : unit;
    return `${value} ${suffix}`;
  }

  async function sendSeekCommand(direction) {
    seekPrevBtn.disabled = true;
    seekNextBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        showStatus('No active tab found', 'error');
        return;
      }

      const seekSettings = normalizeSeekSettings({
        seekStepValue: seekStepValueInput.value,
        seekStepUnit: seekStepUnitSelect.value
      });

      const response = await chrome.runtime.sendMessage({
        action: 'performSeek',
        tabId: tab.id,
        direction,
        settings: seekSettings
      });

      if (response?.success) {
        const methodLabel = response.methodLabel || 'player API';
        showStatus(
          `${direction === 'previous' ? 'Moved back' : 'Moved forward'} ${formatSeekLabel(response.seekStepValue, response.seekStepUnit)} via ${methodLabel}`,
          'success'
        );
      } else {
        showStatus(response?.error || 'No video found on this page', 'error');
      }
    } catch (error) {
      console.error('Seek error:', error);
      showStatus('Failed to seek video on this page', 'error');
    } finally {
      seekPrevBtn.disabled = false;
      seekNextBtn.disabled = false;
    }
  }

  seekPrevBtn.addEventListener('click', () => sendSeekCommand('previous'));
  seekNextBtn.addEventListener('click', () => sendSeekCommand('next'));

  captureBtn.addEventListener('click', async () => {
    captureBtn.disabled = true;
    showStatus('Capturing...', 'info');
    previewDiv.classList.add('hidden');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        showStatus('No active tab found', 'error');
        captureBtn.disabled = false;
        return;
      }

      // First try canvas-based capture (works for non-DRM content)
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          action: 'captureScreenshot',
          options: {
            includeSubtitles: includeSubtitles.checked,
            format: formatSelect.value
          }
        });
      } catch (e) {
        response = null;
      }

      // Check if canvas capture returned black/empty (DRM protected)
      if (response && response.success && response.isBlack) {
        // Fall back to visible tab capture for DRM content
        showStatus('DRM detected, using screen capture...', 'info');
        response = await captureVisibleTab(tab, formatSelect.value, includeSubtitles.checked);
      } else if (!response || !response.success) {
        // Try visible tab capture as fallback
        response = await captureVisibleTab(tab, formatSelect.value, includeSubtitles.checked);
      }

      if (response && response.success) {
        lastScreenshot = response.data;
        lastVideoInfo = await getVideoInfo(tab);
        previewImage.src = response.data;
        previewDiv.classList.remove('hidden');
        showStatus('Screenshot captured!', 'success');

        if (autoDownload.checked) {
          downloadScreenshot(response.data, formatSelect.value, lastVideoInfo);
        }
      } else {
        showStatus(response?.error || 'No video found on this page', 'error');
      }
    } catch (error) {
      console.error('Capture error:', error);
      showStatus('Failed to capture. Make sure there\'s a video on the page.', 'error');
    }

    captureBtn.disabled = false;
  });

  async function captureVisibleTab(tab, format, includeSubtitles) {
    try {
      // Hide player controls (and optionally subtitles) before capture
      await chrome.tabs.sendMessage(tab.id, { 
        action: 'hideControls',
        hideSubtitles: !includeSubtitles
      });
      
      // Small delay to let controls hide
      await new Promise(resolve => setTimeout(resolve, 100));

      // Get video bounds from content script
      const boundsResponse = await chrome.tabs.sendMessage(tab.id, {
        action: 'getVideoBounds'
      });

      if (!boundsResponse || !boundsResponse.success) {
        await chrome.tabs.sendMessage(tab.id, { action: 'showControls' });
        return { success: false, error: 'No video found' };
      }

      // Capture visible tab
      const screenshotUrl = await chrome.tabs.captureVisibleTab(null, {
        format: format === 'jpeg' ? 'jpeg' : 'png',
        quality: format === 'jpeg' ? 95 : undefined
      });

      // Restore controls
      await chrome.tabs.sendMessage(tab.id, { action: 'showControls' });

      // Crop to video area
      const croppedImage = await cropImage(
        screenshotUrl,
        boundsResponse.bounds,
        format
      );

      return { success: true, data: croppedImage };
    } catch (error) {
      console.error('Visible tab capture error:', error);
      // Try to restore controls on error
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'showControls' });
      } catch (e) {}
      return { success: false, error: error.message };
    }
  }

  async function cropImage(imageUrl, bounds, format) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Account for device pixel ratio
        const dpr = bounds.devicePixelRatio || 1;
        
        canvas.width = bounds.width * dpr;
        canvas.height = bounds.height * dpr;
        
        ctx.drawImage(
          img,
          bounds.x * dpr,
          bounds.y * dpr,
          bounds.width * dpr,
          bounds.height * dpr,
          0,
          0,
          canvas.width,
          canvas.height
        );
        
        const mimeType = `image/${format}`;
        const quality = format === 'jpeg' ? 0.95 : undefined;
        resolve(canvas.toDataURL(mimeType, quality));
      };
      img.onerror = reject;
      img.src = imageUrl;
    });
  }

  let lastVideoInfo = null;

  downloadBtn.addEventListener('click', () => {
    if (lastScreenshot) {
      downloadScreenshot(lastScreenshot, formatSelect.value, lastVideoInfo);
    }
  });

  copyBtn.addEventListener('click', async () => {
    if (!lastScreenshot) return;

    try {
      const response = await fetch(lastScreenshot);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      showStatus('Copied to clipboard!', 'success');
    } catch (error) {
      console.error('Copy error:', error);
      showStatus('Failed to copy to clipboard', 'error');
    }
  });

  async function getVideoInfo(tab) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });
      return response?.success ? response : null;
    } catch (e) {
      return null;
    }
  }

  function downloadScreenshot(dataUrl, format, videoInfo) {
    let filename;
    
    if (videoInfo && videoInfo.title && videoInfo.timestamp) {
      filename = `${videoInfo.title}_${videoInfo.timestamp}.${format}`;
    } else if (videoInfo && videoInfo.timestamp) {
      filename = `video_${videoInfo.timestamp}.${format}`;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      filename = `video-screenshot-${timestamp}.${format}`;
    }

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });
  }
});
