// SubStills Content Script
// Captures video frames with subtitle overlay

(function() {
  'use strict';

  const DEFAULT_SEEK_SETTINGS = {
    seekStepValue: 1,
    seekStepUnit: 'frames'
  };

  const IS_NETFLIX = /(^|\.)netflix\.com$/i.test(window.location.hostname);
  const IS_YOUTUBE = /(^|\.)youtube\.com$/i.test(window.location.hostname);

  // Store hidden elements to restore later
  let hiddenElements = [];
  
  // Track if screenshot button has been injected
  let buttonInjected = false;

  // Restore the original screenshot injection path everywhere.
  // Seek functionality is executed via the background worker so we do not need
  // to mutate Netflix's control bar with custom seek buttons.
  initScreenshotButton();
  initKeyboardShortcuts();

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'captureScreenshot') {
      captureVideoScreenshot(request.options)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response
    }
    
    if (request.action === 'getVideoBounds') {
      const bounds = getVideoBounds();
      sendResponse(bounds);
      return true;
    }

    if (request.action === 'getVideoInfo') {
      const info = getVideoInfo();
      sendResponse(info);
      return true;
    }

    if (request.action === 'hideControls') {
      hidePlayerControls(request.hideSubtitles);
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'showControls') {
      showPlayerControls();
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'seekVideo') {
      seekVideoByDirection(request.direction, request.settings)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }
  });

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', async (event) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.shiftKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.code === 'Comma' || event.key === ',') {
        event.preventDefault();
        event.stopPropagation();
        await seekVideoByDirection('previous');
      }

      if (event.code === 'Period' || event.key === '.') {
        event.preventDefault();
        event.stopPropagation();
        await seekVideoByDirection('next');
      }
    }, true);
  }

  function isEditableTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      !!target.closest('[contenteditable="true"]');
  }

  // Initialize screenshot button injection
  function initScreenshotButton() {
    const inject = () => {
      if (document.querySelector('[data-substills-control="screenshot"]')) {
        return;
      }

      const netflixReferenceBtn = document.querySelector('[data-uia="control-audio-subtitle"]') ||
                                  document.querySelector('[data-uia="control-speed"]') ||
                                  document.querySelector('[data-uia="control-fullscreen-enter"]');
      const youtubeControls = document.querySelector('.ytp-right-controls');
      const hasVideo = !!findBestVideo();

      if ((IS_NETFLIX && netflixReferenceBtn) || (IS_YOUTUBE && youtubeControls) || hasVideo) {
        injectScreenshotButton();
      }
    };

    // Check frequently - Netflix removes/recreates controls constantly
    // This is the most robust way to handle the disappearing button issue
    setInterval(inject, 500);

    // Use MutationObserver to watch for control bar appearing
    const observer = new MutationObserver((mutations) => {
      let shouldInject = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldInject = true;
          break;
        }
      }
      if (shouldInject) {
        // Small delay to ensure DOM is ready
        setTimeout(inject, 100);
      }
    });

    // Observe the body for changes
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also check on mouse move (controls appear on interaction)
    // This is crucial for Netflix as controls are destroyed/recreated
    let mouseTimeout;
    document.addEventListener('mousemove', () => {
      if (!mouseTimeout) {
        mouseTimeout = setTimeout(() => {
          inject();
          mouseTimeout = null;
        }, 200);
      }
    }, { passive: true });

    // Initial injection
    inject();
  }

  function injectScreenshotButton() {
    const video = findBestVideo();
    if (!video) return;

    // Check if button already exists
    if (document.querySelector('[data-substills-control="screenshot"]')) {
      buttonInjected = true;
      return;
    }

    if (IS_NETFLIX) {
      if (injectIntoNetflixControls()) {
        buttonInjected = true;
      }
      return;
    }

    // Try to inject into Netflix's control bar first
    if (injectIntoNetflixControls()) {
      buttonInjected = true;
      return;
    }

    // Try to inject into YouTube's control bar
    if (injectIntoYouTubeControls()) {
      buttonInjected = true;
      return;
    }

    // Fallback: inject as overlay on video
    injectAsOverlay(video);
    buttonInjected = true;
  }

  function injectIntoNetflixControls() {
    // Find a reference button to clone its structure
    // Try multiple selectors to be robust
    const referenceBtn = document.querySelector('[data-uia="control-audio-subtitle"]') || 
                         document.querySelector('[data-uia="control-speed"]') ||
                         document.querySelector('[data-uia="control-fullscreen-enter"]');
    
    if (!referenceBtn) return false;

    // In Netflix, buttons are often wrapped in a div. We need to clone the wrapper.
    // Structure: Container > Wrapper > Button
    const wrapper = referenceBtn.parentElement;
    if (!wrapper) return false;

    const container = wrapper.parentElement;
    if (!container) return false;

    const existingSvg = referenceBtn.querySelector('svg');
    const svgClass = existingSvg ? existingSvg.getAttribute('class') : '';

    const controls = [
      {
        action: 'screenshot',
        title: 'Screenshot',
        icon: getScreenshotIcon(svgClass),
        onClick: () => takeScreenshotFromButton()
      }
    ];

    // Insert logic: We want to insert the wrapper into the container.
    // We also need to handle the spacer div if it exists.
    
    // Try to find a spacer to clone
    let spacer = null;
    if (wrapper.previousElementSibling && 
        wrapper.previousElementSibling.tagName === 'DIV' && 
        !wrapper.previousElementSibling.querySelector('button')) {
      spacer = wrapper.previousElementSibling.cloneNode(true);
    }

    for (const control of controls) {
      const newWrapper = wrapper.cloneNode(true);
      const btn = newWrapper.querySelector('button');

      if (!btn) {
        continue;
      }

      btn.setAttribute('data-uia', `control-substills-${control.action}`);
      btn.setAttribute('data-substills-control', control.action);
      btn.className = `${referenceBtn.className} video-screenshot-btn`;
      btn.title = control.title;
      btn.style.order = '';
      btn.innerHTML = `
        <div class="control-medium default-ltr-iqcdef-cache-iyulz3" role="presentation">
          ${control.icon}
        </div>
      `;
      btn.onclick = null;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await control.onClick();
      });

      container.insertBefore(newWrapper, wrapper);
    }

    if (spacer) {
      container.insertBefore(spacer, wrapper);
    }

    return true;
  }

  function injectIntoYouTubeControls() {
    // YouTube right controls
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return false;

    const controls = [
      {
        action: 'previous',
        title: 'Previous Step',
        icon: getPreviousIcon(),
        onClick: () => seekVideoByDirection('previous')
      },
      {
        action: 'screenshot',
        title: 'Screenshot',
        icon: getScreenshotIcon(),
        onClick: () => takeScreenshotFromButton()
      },
      {
        action: 'next',
        title: 'Next Step',
        icon: getNextIcon(),
        onClick: () => seekVideoByDirection('next')
      }
    ];

    for (let index = controls.length - 1; index >= 0; index -= 1) {
      const control = controls[index];
      const btn = document.createElement('button');
      btn.className = 'video-screenshot-btn ytp-button';
      btn.title = control.title;
      btn.dataset.substillsControl = control.action;
      btn.innerHTML = control.icon;

      Object.assign(btn.style, {
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        width: '48px',
        height: '48px',
        padding: '12px',
        opacity: '0.9'
      });

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await control.onClick();
      });

      rightControls.insertBefore(btn, rightControls.firstChild);
    }

    return true;
  }

  function injectAsOverlay(video) {
    const videoContainer = findVideoContainer(video);
    if (!videoContainer) return;

    const controls = document.createElement('div');
    controls.className = 'substills-overlay-controls';

    const overlayButtons = [
      {
        action: 'previous',
        title: 'Previous Step',
        icon: getPreviousIcon(),
        onClick: () => seekVideoByDirection('previous')
      },
      {
        action: 'screenshot',
        title: 'Take Screenshot',
        icon: getScreenshotIcon(),
        onClick: () => takeScreenshotFromButton()
      },
      {
        action: 'next',
        title: 'Next Step',
        icon: getNextIcon(),
        onClick: () => seekVideoByDirection('next')
      }
    ];

    for (const control of overlayButtons) {
      const btn = document.createElement('button');
      btn.className = 'video-screenshot-btn video-screenshot-btn-overlay';
      btn.dataset.substillsControl = control.action;
      btn.innerHTML = control.icon;
      btn.title = control.title;

      Object.assign(btn.style, {
        background: 'rgba(0, 0, 0, 0.6)',
        border: 'none',
        borderRadius: '4px',
        padding: '8px',
        cursor: 'pointer',
        color: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.2s ease',
        pointerEvents: 'auto'
      });

      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(102, 126, 234, 0.8)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(0, 0, 0, 0.6)');
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await control.onClick();
      });

      controls.appendChild(btn);
    }

    videoContainer.addEventListener('mouseenter', () => controls.style.opacity = '1');
    videoContainer.addEventListener('mouseleave', () => controls.style.opacity = '0');

    const containerStyle = window.getComputedStyle(videoContainer);
    if (containerStyle.position === 'static') {
      videoContainer.style.position = 'relative';
    }

    videoContainer.appendChild(controls);
  }

  function getPreviousIcon(svgClass = '') {
    return `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="${svgClass}" aria-hidden="true">
        <path d="M8 6V18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
        <path d="M17 7L11 12L17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function getNextIcon(svgClass = '') {
    return `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="${svgClass}" aria-hidden="true">
        <path d="M16 6V18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
        <path d="M7 7L13 12L7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function getScreenshotIcon(svgClass = '') {
    return `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="${svgClass}" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M4 6C2.89543 6 2 6.89543 2 8V18C2 19.1046 2.89543 20 4 20H20C21.1046 20 22 19.1046 22 18V8C22 6.89543 21.1046 6 20 6H17.4142L15.7071 4.29289C15.5196 4.10536 15.2652 4 15 4H9C8.73478 4 8.48043 4.10536 8.29289 4.29289L6.58579 6H4ZM12 17C14.4853 17 16.5 14.9853 16.5 12.5C16.5 10.0147 14.4853 8 12 8C9.51472 8 7.5 10.0147 7.5 12.5C7.5 14.9853 9.51472 17 12 17Z" fill="currentColor"></path>
      </svg>
    `;
  }

  function findVideoContainer(video) {
    let container = video.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const rect = container.getBoundingClientRect();
      if (rect.width >= video.clientWidth * 0.9 && rect.height >= video.clientHeight * 0.9) {
        return container;
      }
      container = container.parentElement;
    }
    return video.parentElement;
  }

  async function takeScreenshotFromButton() {
    // Get settings from storage
    const settings = await chrome.storage.local.get(['includeSubtitles', 'format']);
    const includeSubtitles = settings.includeSubtitles !== false; // default true
    const format = settings.format || 'jpeg'; // default jpeg

    // Hide controls but keep subtitles based on setting
    hidePlayerControls(!includeSubtitles);
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // Try canvas capture first
    let result = await captureVideoScreenshot({
      includeSubtitles: includeSubtitles,
      format: format
    });

    // If black (DRM), use message to background for visible tab capture
    if (result.success && result.isBlack) {
      // Send message to background to capture visible tab
      const bounds = getVideoBounds();
      if (bounds.success) {
        result = await chrome.runtime.sendMessage({
          action: 'captureVisibleTab',
          bounds: bounds.bounds,
          format: format
        });
      }
    }

    // Restore controls
    showPlayerControls();

    if (result && result.success && result.data) {
      // Get video info for filename
      const videoInfo = getVideoInfo();
      
      // Download the screenshot
      const filename = generateFilename(videoInfo, format);
      
      chrome.runtime.sendMessage({
        action: 'download',
        url: result.data,
        filename: filename
      });

      // Show flash effect
      showFlashEffect();
    }
  }

  function generateFilename(videoInfo, format) {
    if (videoInfo && videoInfo.success && videoInfo.title && videoInfo.timestamp) {
      return `${videoInfo.title}_${videoInfo.timestamp}.${format}`;
    } else if (videoInfo && videoInfo.success && videoInfo.timestamp) {
      return `video_${videoInfo.timestamp}.${format}`;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      return `video-screenshot-${timestamp}.${format}`;
    }
  }

  function showFlashEffect() {
    const video = findBestVideo();
    if (!video) return;
    
    const container = findVideoContainer(video);
    if (!container) return;

    const flash = document.createElement('div');
    flash.className = 'video-screenshot-flash';
    container.appendChild(flash);
    
    setTimeout(() => flash.remove(), 300);
  }

  function getVideoInfo() {
    const video = findBestVideo();
    
    if (!video) {
      return { success: false };
    }

    // Get current time formatted as HH-MM-SS
    const currentTime = video.currentTime;
    const hours = Math.floor(currentTime / 3600);
    const minutes = Math.floor((currentTime % 3600) / 60);
    const seconds = Math.floor(currentTime % 60);
    const timestamp = [
      hours.toString().padStart(2, '0'),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0')
    ].join('-');

    // Try to get video title from various sources
    let title = getVideoTitle();
    
    return {
      success: true,
      title: title,
      timestamp: timestamp
    };
  }

  async function seekVideoByDirection(direction, settingsOverride) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'performSeek',
        direction,
        settings: settingsOverride
      });

      return response || { success: false, error: 'Seek execution returned no response' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  function getVideoTitle() {
    // Try different methods to get video title
    
    // Netflix - try multiple selectors
    const netflixSelectors = [
      '[class*="video-title"] h4',
      '[class*="video-title"] span',
      '[data-uia="video-title"]',
      '.watch-video--evidence-title',
      'h4[class*="previewModal--player-titleTreatment"]',
      '.title-logo',
      // Title from player UI
      '[class*="ellipsize-text"]'
    ];
    
    for (const selector of netflixSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) {
          return sanitizeFilename(el.textContent.trim());
        }
      } catch (e) {}
    }
    
    // YouTube
    const ytTitle = document.querySelector('h1.ytd-video-primary-info-renderer, h1.ytd-watch-metadata yt-formatted-string');
    if (ytTitle) return sanitizeFilename(ytTitle.textContent);
    
    // Generic: try document title and extract the actual title
    const docTitle = document.title;
    if (docTitle) {
      // Clean up common suffixes/prefixes
      let cleaned = docTitle
        .replace(/^\s*Watch\s+/i, '')           // Remove "Watch " prefix
        .replace(/\s*[-|–—]\s*Netflix.*$/i, '') // Remove " - Netflix" suffix
        .replace(/\s*[-|–—]\s*YouTube.*$/i, '')
        .replace(/\s*[-|–—]\s*Prime Video.*$/i, '')
        .replace(/\s*[-|–—]\s*Disney\+.*$/i, '')
        .replace(/\s*[-|–—]\s*HBO.*$/i, '')
        .trim();
      if (cleaned && cleaned !== 'Netflix') return sanitizeFilename(cleaned);
    }
    
    return 'video';
  }

  function sanitizeFilename(name) {
    // Remove or replace characters not allowed in filenames
    return name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100); // Limit length
  }

  function hidePlayerControls(hideSubtitles = false) {
    hiddenElements = [];
    
    // Common player control selectors (excluding subtitles)
    const controlSelectors = [
      // Netflix
      '[class*="PlayerControlsNeo"]',
      '[class*="watch-video--bottom-controls"]',
      '.watch-video--bottom-controls-container',
      '[class*="ltr-"]>[class*="medium"]', // Netflix UI buttons
      // YouTube
      '.ytp-chrome-bottom',
      '.ytp-chrome-top',
      '.ytp-gradient-bottom',
      '.ytp-gradient-top',
      // Generic
      '[class*="control-bar"]',
      '[class*="controls-bar"]',
      '[class*="player-controls"]',
      '[class*="video-controls"]',
      '.vjs-control-bar',
      // Cursor/pointer
      '[class*="cursor"]',
      // Specific unwanted overlay
      '#controller',
      // Video Speed Controller extension
      'vsc-controller',
      '.vsc-controller'
    ];

    // Subtitle selectors - only hide if hideSubtitles is true
    const subtitleSelectors = [
      // Netflix
      '.player-timedtext',
      '.player-timedtext-text-container',
      // YouTube
      '.ytp-caption-window-container',
      '.caption-window',
      '.captions-text',
      // Generic
      '[class*="subtitle"]',
      '[class*="caption"]',
      '[class*="timedtext"]'
    ];

    const selectorsToHide = hideSubtitles 
      ? [...controlSelectors, ...subtitleSelectors]
      : controlSelectors;

    for (const selector of selectorsToHide) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          // If not hiding subtitles, skip subtitle elements
          if (!hideSubtitles) {
            const classList = el.classList.toString().toLowerCase();
            if (classList.includes('timedtext') ||
                classList.includes('caption') ||
                classList.includes('subtitle')) {
              continue;
            }
          }
          
          // Store original display/visibility
          const originalDisplay = el.style.display;
          const originalVisibility = el.style.visibility;
          const originalOpacity = el.style.opacity;
          const originalZIndex = el.style.zIndex;
          
          hiddenElements.push({
            element: el,
            display: originalDisplay,
            visibility: originalVisibility,
            opacity: originalOpacity,
            zIndex: originalZIndex
          });
          
          // Hide the element
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          // Also set display: none to ensure it's gone, especially for overlays
          // that might intercept clicks or have background effects
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('z-index', '-10000', 'important');
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
  }

  function showPlayerControls() {
    // Restore all hidden elements
    for (const item of hiddenElements) {
      item.element.style.display = item.display;
      item.element.style.visibility = item.visibility;
      item.element.style.opacity = item.opacity;
      item.element.style.zIndex = item.zIndex;
    }
    hiddenElements = [];
  }

  function getVideoBounds() {
    const video = findBestVideo();
    
    if (!video) {
      return { success: false, error: 'No video found' };
    }

    const rect = video.getBoundingClientRect();
    
    // Calculate actual video content bounds (excluding letterbox black bars)
    const videoAspectRatio = video.videoWidth / video.videoHeight;
    const containerAspectRatio = rect.width / rect.height;
    
    let contentX = rect.left;
    let contentY = rect.top;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    
    if (videoAspectRatio > containerAspectRatio) {
      // Video is wider - black bars on top and bottom
      const actualHeight = rect.width / videoAspectRatio;
      const blackBarHeight = (rect.height - actualHeight) / 2;
      contentY = rect.top + blackBarHeight;
      contentHeight = actualHeight;
    } else if (videoAspectRatio < containerAspectRatio) {
      // Video is taller - black bars on left and right
      const actualWidth = rect.height * videoAspectRatio;
      const blackBarWidth = (rect.width - actualWidth) / 2;
      contentX = rect.left + blackBarWidth;
      contentWidth = actualWidth;
    }
    
    return {
      success: true,
      bounds: {
        x: contentX,
        y: contentY,
        width: contentWidth,
        height: contentHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    };
  }

  function findSubtitleContainer(video) {
    // Look for subtitle containers near the video
    const subtitleSelectors = [
      '.player-timedtext',
      '.player-timedtext-text-container',
      '.ytp-caption-window-container',
      '.caption-window',
      '[class*="subtitle"]',
      '[class*="caption"]'
    ];

    for (const selector of subtitleSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (isElementVisible(el)) {
            return el;
          }
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return null;
  }

  async function captureVideoScreenshot(options) {
    const video = findBestVideo();
    
    if (!video) {
      return { success: false, error: 'No video found on this page' };
    }

    if (video.readyState < 2) {
      return { success: false, error: 'Video is not ready yet' };
    }

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Set canvas size to video dimensions
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      
      canvas.width = videoWidth;
      canvas.height = videoHeight;

      // Draw video frame
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

      // Check if the canvas is black (DRM protected content)
      const isBlack = isCanvasBlack(ctx, videoWidth, videoHeight);
      
      if (isBlack) {
        // Signal that we need to use screen capture instead
        return { success: true, isBlack: true, data: null };
      }

      // Capture subtitles if option is enabled
      if (options.includeSubtitles) {
        await captureSubtitles(ctx, video, videoWidth, videoHeight);
      }

      // Convert to data URL
      const mimeType = `image/${options.format}`;
      const quality = options.format === 'jpeg' ? 0.95 : undefined;
      const dataUrl = canvas.toDataURL(mimeType, quality);

      return { success: true, data: dataUrl, isBlack: false };
    } catch (error) {
      console.error('Screenshot capture error:', error);
      return { success: false, error: error.message };
    }
  }

  function isCanvasBlack(ctx, width, height) {
    // Sample pixels from the canvas to check if it's all black
    const sampleSize = 100;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    let nonBlackPixels = 0;
    const step = Math.floor(data.length / 4 / sampleSize);
    
    for (let i = 0; i < sampleSize; i++) {
      const idx = i * step * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      
      // Consider pixel non-black if any channel > 10
      if (r > 10 || g > 10 || b > 10) {
        nonBlackPixels++;
      }
    }
    
    // If less than 5% of sampled pixels are non-black, consider it black
    return nonBlackPixels < sampleSize * 0.05;
  }

  function findBestVideo() {
    // Get all videos on the page
    const videos = Array.from(document.querySelectorAll('video'));
    
    if (videos.length === 0) {
      return null;
    }

    // Sort by visibility and size, prefer playing videos
    const sortedVideos = videos
      .filter(v => v.videoWidth > 0 && v.videoHeight > 0)
      .sort((a, b) => {
        // Prefer playing videos
        if (!a.paused && b.paused) return -1;
        if (a.paused && !b.paused) return 1;
        
        // Then prefer larger videos
        const areaA = a.videoWidth * a.videoHeight;
        const areaB = b.videoWidth * b.videoHeight;
        return areaB - areaA;
      });

    return sortedVideos[0] || null;
  }

  async function captureSubtitles(ctx, video, canvasWidth, canvasHeight) {
    // Method 1: Capture text tracks (native subtitles)
    captureTextTracks(ctx, video, canvasWidth, canvasHeight);
    
    // Method 2: Capture DOM-based subtitles (YouTube, Netflix, etc.)
    await captureDOMSubtitles(ctx, video, canvasWidth, canvasHeight);
  }

  function captureTextTracks(ctx, video, canvasWidth, canvasHeight) {
    const tracks = video.textTracks;
    
    if (!tracks || tracks.length === 0) return;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      
      if (track.mode === 'showing' && track.activeCues) {
        for (let j = 0; j < track.activeCues.length; j++) {
          const cue = track.activeCues[j];
          if (cue && cue.text) {
            drawSubtitleText(ctx, cue.text, canvasWidth, canvasHeight);
          }
        }
      }
    }
  }

  async function captureDOMSubtitles(ctx, video, canvasWidth, canvasHeight) {
    // Prefer precise site selectors so random overlays are not treated as subtitles.
    const platformSelectors = IS_YOUTUBE
      ? [
          '.ytp-caption-window-container .ytp-caption-segment',
          '.ytp-caption-window-container .caption-window',
          '.ytp-caption-segment'
        ]
      : IS_NETFLIX
        ? [
            '.player-timedtext-text-container',
            '.player-timedtext span'
          ]
        : [];

    const fallbackSelectors = [
      '.vp-captions',
      '.vjs-text-track-display',
      '.atvwebplayersdk-captions-text',
      '.btm-media-overlays-container'
    ];

    const subtitleSelectors = platformSelectors.length > 0
      ? platformSelectors
      : fallbackSelectors;

    const videoRect = video.getBoundingClientRect();
    const seenElements = new Set();
    
    for (const selector of subtitleSelectors) {
      const elements = document.querySelectorAll(selector);
      
      for (const element of elements) {
        if (seenElements.has(element)) continue;
        seenElements.add(element);

        if (!isElementVisible(element)) continue;

        const elementRect = element.getBoundingClientRect();
        if (!isLikelySubtitleElement(element, elementRect, videoRect)) continue;
        
        const text = element.innerText || element.textContent;
        if (!text || !text.trim()) continue;
        const normalizedText = text.replace(/\s+/g, ' ').trim();
        if (!normalizedText || normalizedText.length > 240) continue;

        // Get computed styles for accurate rendering
        const computedStyle = window.getComputedStyle(element);
        
        // Calculate position relative to video
        const relativeX = (elementRect.left - videoRect.left) / videoRect.width;
        const relativeY = (elementRect.top - videoRect.top) / videoRect.height;
        
        // Only render if subtitle is within video bounds
        if (relativeX >= -0.1 && relativeX <= 1.1 && relativeY >= -0.1 && relativeY <= 1.1) {
          drawStyledSubtitle(ctx, normalizedText, {
            x: relativeX * canvasWidth,
            y: relativeY * canvasHeight,
            width: (elementRect.width / videoRect.width) * canvasWidth,
            fontSize: parseFloat(computedStyle.fontSize) * (canvasWidth / videoRect.width),
            fontFamily: computedStyle.fontFamily,
            color: computedStyle.color,
            backgroundColor: computedStyle.backgroundColor,
            textAlign: computedStyle.textAlign
          }, canvasWidth, canvasHeight);
        }
      }
    }
  }

  function isElementVisible(element) {
    if (!element) return false;
    
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isLikelySubtitleElement(element, elementRect, videoRect) {
    if (!videoRect || videoRect.width <= 0 || videoRect.height <= 0) {
      return false;
    }

    const relativeLeft = (elementRect.left - videoRect.left) / videoRect.width;
    const relativeTop = (elementRect.top - videoRect.top) / videoRect.height;
    const relativeRight = (elementRect.right - videoRect.left) / videoRect.width;
    const relativeBottom = (elementRect.bottom - videoRect.top) / videoRect.height;
    const widthRatio = elementRect.width / videoRect.width;
    const heightRatio = elementRect.height / videoRect.height;
    const centerX = (relativeLeft + relativeRight) / 2;

    const overlapsVideo = relativeRight >= -0.05 && relativeLeft <= 1.05 && relativeBottom >= -0.05 && relativeTop <= 1.05;
    if (!overlapsVideo) {
      return false;
    }

    if (widthRatio <= 0 || widthRatio > 0.95 || heightRatio <= 0 || heightRatio > 0.35) {
      return false;
    }

    const className = (element.className || '').toString();

    if (IS_YOUTUBE) {
      return element.closest('.ytp-caption-window-container') !== null ||
        className.includes('ytp-caption') ||
        className.includes('caption-window');
    }

    if (IS_NETFLIX) {
      return className.toLowerCase().includes('timedtext');
    }

    const nearBottom = relativeTop >= 0.35 && relativeBottom <= 0.99;
    const nearCenter = centerX >= 0.12 && centerX <= 0.88;
    return nearBottom && nearCenter;
  }

  function drawSubtitleText(ctx, text, canvasWidth, canvasHeight) {
    // Default subtitle styling
    const fontSize = Math.max(canvasHeight * 0.04, 16);
    const padding = 10;
    const bottomMargin = canvasHeight * 0.1;

    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    // Measure text for background
    const lines = text.split('\n');
    const lineHeight = fontSize * 1.2;
    const maxWidth = canvasWidth * 0.9;

    let y = canvasHeight - bottomMargin;

    // Draw each line from bottom to top
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      const metrics = ctx.measureText(line);
      const textWidth = Math.min(metrics.width, maxWidth);

      // Draw semi-transparent background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(
        (canvasWidth - textWidth) / 2 - padding,
        y - fontSize - padding / 2,
        textWidth + padding * 2,
        fontSize + padding
      );

      // Draw text outline for better visibility
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.strokeText(line, canvasWidth / 2, y, maxWidth);

      // Draw text
      ctx.fillStyle = 'white';
      ctx.fillText(line, canvasWidth / 2, y, maxWidth);

      y -= lineHeight;
    }
  }

  function drawStyledSubtitle(ctx, text, style, canvasWidth, canvasHeight) {
    const fontSize = style.fontSize || Math.max(canvasHeight * 0.04, 16);
    const fontFamily = style.fontFamily || 'Arial, sans-serif';
    const padding = 8;

    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textAlign = style.textAlign || 'center';
    ctx.textBaseline = 'top';

    const lines = text.split('\n');
    const lineHeight = fontSize * 1.3;
    
    let x = style.x || canvasWidth / 2;
    let y = style.y || canvasHeight * 0.85;

    // Adjust x based on text alignment
    if (ctx.textAlign === 'center') {
      x = style.x + (style.width || 0) / 2;
    }

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        y += lineHeight;
        continue;
      }

      const metrics = ctx.measureText(trimmedLine);
      const textWidth = metrics.width;

      // Draw background if specified
      if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        ctx.fillStyle = style.backgroundColor;
        let bgX = x;
        if (ctx.textAlign === 'center') {
          bgX = x - textWidth / 2;
        }
        ctx.fillRect(bgX - padding, y - padding / 2, textWidth + padding * 2, fontSize + padding);
      } else {
        // Default semi-transparent background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        let bgX = x;
        if (ctx.textAlign === 'center') {
          bgX = x - textWidth / 2;
        }
        ctx.fillRect(bgX - padding, y - padding / 2, textWidth + padding * 2, fontSize + padding);
      }

      // Draw text outline
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.strokeText(trimmedLine, x, y);

      // Draw text
      ctx.fillStyle = style.color || 'white';
      ctx.fillText(trimmedLine, x, y);

      y += lineHeight;
    }
  }

})();
