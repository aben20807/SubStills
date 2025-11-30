// Background service worker for SubStills extension

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings
    chrome.storage.local.set({
      includeSubtitles: true,
      autoDownload: true,
      format: 'png'
    });
    
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
            format: settings.format || 'png'
          }
        });
        
        if (response && response.success) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `video-screenshot-${timestamp}.${settings.format || 'png'}`;
          
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
  
  return true;
});

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
