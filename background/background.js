// Background service worker for SubStills extension

const DEFAULT_SETTINGS = {
  includeSubtitles: true,
  autoDownload: true,
  format: 'jpeg',
  seekStepValue: 1,
  seekStepUnit: 'frames',
  seekMethod: 'netflix-player-api'
};

function normalizeSeekSettings(rawSettings = {}) {
  const unit = rawSettings.seekStepUnit === 'seconds' ? 'seconds' : DEFAULT_SETTINGS.seekStepUnit;
  const numericValue = Number(rawSettings.seekStepValue);

  let seekStepValue = Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : DEFAULT_SETTINGS.seekStepValue;

  if (unit === 'frames') {
    seekStepValue = Math.max(1, Math.round(seekStepValue));
  } else {
    seekStepValue = Math.max(0.01, Number(seekStepValue.toFixed(3)));
  }

  return {
    seekStepValue,
    seekStepUnit: unit,
    seekMethod: DEFAULT_SETTINGS.seekMethod
  };
}

async function getStoredSeekSettings(overrides = {}) {
  const storedSettings = await chrome.storage.local.get(['seekStepValue', 'seekStepUnit', 'seekMethod']);
  return normalizeSeekSettings({
    ...storedSettings,
    ...overrides
  });
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  const existingSettings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...existingSettings
  });

  if (details.reason === 'install') {
    console.log('Video Screenshot extension installed');
  }
});

// Handle keyboard shortcuts (optional)
chrome.commands?.onCommand?.addListener(async (command) => {
  if (command === 'take-screenshot') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      const settings = await chrome.storage.local.get(['includeSubtitles', 'format']);
      
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'captureScreenshot',
          options: {
            includeSubtitles: settings.includeSubtitles ?? true,
            format: settings.format || 'jpeg'
          }
        });
        
        if (response && response.success) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `video-screenshot-${timestamp}.${settings.format || 'jpeg'}`;
          
          chrome.downloads.download({
            url: response.data,
            filename: filename,
            saveAs: false
          });
        }
      } catch (error) {
        console.error('Screenshot capture failed:', error);
      }
    }
  }
});

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: request.saveAs || false
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (request.action === 'captureVisibleTab') {
    // Capture visible tab and crop to video bounds
    captureAndCrop(request.bounds, request.format)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (request.action === 'getSeekSettings') {
    chrome.storage.local.get(['seekStepValue', 'seekStepUnit', 'seekMethod'])
      .then(settings => sendResponse({ success: true, settings: normalizeSeekSettings(settings) }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'performSeek') {
    const tabId = request.tabId ?? sender.tab?.id;

    if (!tabId) {
      sendResponse({ success: false, error: 'No target tab found' });
      return false;
    }

    getStoredSeekSettings(request.settings)
      .then(settings => executeSeekInTab(tabId, request.direction, settings))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  return true;
});

async function executeSeekInTab(tabId, direction, settings) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    args: [direction, settings],
    func: async (directionArg, settingsArg) => {
      function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
      }

      function getNetflixPlayer() {
        try {
          const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
          const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() || [];
          const sessionId = sessionIds.find(id => id.includes('watch')) || sessionIds[0];
          return sessionId ? videoPlayer.getVideoPlayerBySessionId(sessionId) : null;
        } catch (error) {
          return null;
        }
      }

      function estimateFrameDuration() {
        const video = document.querySelector('video');
        const fpsCandidates = [];

        if (!video) {
          return 1 / 24;
        }

        if (typeof video.getVideoPlaybackQuality === 'function' && video.currentTime > 0.5) {
          const quality = video.getVideoPlaybackQuality();
          if (quality && quality.totalVideoFrames) {
            fpsCandidates.push(quality.totalVideoFrames / video.currentTime);
          }
        }

        if (typeof video.webkitDecodedFrameCount === 'number' && video.webkitDecodedFrameCount > 0 && video.currentTime > 0.5) {
          fpsCandidates.push(video.webkitDecodedFrameCount / video.currentTime);
        }

        const fps = fpsCandidates.find(candidate => Number.isFinite(candidate) && candidate >= 12 && candidate <= 120) || 24;
        return 1 / fps;
      }

      function getSignedSeekDelta(direction, settings) {
        if (settings.seekStepUnit === 'seconds') {
          return direction === 'previous' ? -settings.seekStepValue : settings.seekStepValue;
        }

        const frameDuration = estimateFrameDuration();
        const baseDelta = settings.seekStepValue * frameDuration;

        if (direction === 'previous') {
          const backwardBias = Math.max(frameDuration * 0.5, 1 / 1000);
          return -(baseDelta + backwardBias);
        }

        return baseDelta;
      }

      async function applyNetflixPlayerApi(signedDelta) {
        const player = getNetflixPlayer();
        if (!player || typeof player.getCurrentTime !== 'function') {
          return { success: false, error: 'Netflix player API unavailable' };
        }

        const currentMs = player.getCurrentTime();
        const targetMs = Math.max(0, currentMs + (signedDelta * 1000));

        if (typeof player.seek === 'function') {
          player.seek(targetMs);
        } else if (typeof player.seekTo === 'function') {
          player.seekTo(targetMs);
        } else {
          return { success: false, error: 'Netflix seek method unavailable' };
        }

        await wait(40);
        const actualMs = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : targetMs;
        return {
          success: true,
          currentTime: actualMs / 1000
        };
      }

      const signedDelta = getSignedSeekDelta(directionArg, settingsArg);

      const result = await applyNetflixPlayerApi(signedDelta);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          seekStepValue: settingsArg.seekStepValue,
          seekStepUnit: settingsArg.seekStepUnit,
          methodUsed: 'netflix-player-api',
          methodLabel: 'Netflix player API'
        };
      }

      return {
        success: true,
        currentTime: result.currentTime,
        seekStepValue: settingsArg.seekStepValue,
        seekStepUnit: settingsArg.seekStepUnit,
        methodUsed: 'netflix-player-api',
        methodLabel: 'Netflix player API'
      };
    }
  });

  if (!result) {
    return { success: false, error: 'Seek execution returned no result' };
  }

  return {
    ...result,
    methodLabel: 'Netflix player API'
  };
}

async function captureAndCrop(bounds, format) {
  try {
    // Capture visible tab
    const screenshotUrl = await chrome.tabs.captureVisibleTab(null, {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      quality: format === 'jpeg' ? 95 : undefined
    });

    // Create offscreen document to crop the image
    const croppedImage = await cropImageInBackground(screenshotUrl, bounds, format);
    
    return { success: true, data: croppedImage };
  } catch (error) {
    console.error('Capture error:', error);
    return { success: false, error: error.message };
  }
}

async function cropImageInBackground(imageUrl, bounds, format) {
  // Use a canvas in the service worker (via OffscreenCanvas if available)
  // For now, return the full screenshot - cropping will happen in content script
  // Actually, we need to send back to content script or popup for cropping
  
  return new Promise((resolve, reject) => {
    // Create an image bitmap from the data URL
    fetch(imageUrl)
      .then(res => res.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        const dpr = bounds.devicePixelRatio || 1;
        const canvas = new OffscreenCanvas(bounds.width * dpr, bounds.height * dpr);
        const ctx = canvas.getContext('2d');
        
        ctx.drawImage(
          bitmap,
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
        
        canvas.convertToBlob({ type: mimeType, quality })
          .then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          })
          .catch(reject);
      })
      .catch(reject);
  });
}
