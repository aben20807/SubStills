document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('captureBtn');
  const includeSubtitles = document.getElementById('includeSubtitles');
  const autoDownload = document.getElementById('autoDownload');
  const formatSelect = document.getElementById('format');
  const statusDiv = document.getElementById('status');
  const previewDiv = document.getElementById('preview');
  const previewImage = document.getElementById('previewImage');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');

  let lastScreenshot = null;

  // Load saved settings
  chrome.storage.local.get(['includeSubtitles', 'autoDownload', 'format'], (result) => {
    if (result.includeSubtitles !== undefined) {
      includeSubtitles.checked = result.includeSubtitles;
    }
    if (result.autoDownload !== undefined) {
      autoDownload.checked = result.autoDownload;
    }
    if (result.format) {
      formatSelect.value = result.format;
    }
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

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  function hideStatus() {
    statusDiv.className = 'status';
  }

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
