# Video Screenshot Chrome Extension

## Project Overview
A Chrome extension that captures screenshots from video elements on web pages, including visible subtitles/captions overlay.

## Tech Stack
- JavaScript (ES6+)
- Chrome Extension Manifest V3
- HTML5 Canvas API

## Project Structure
- `manifest.json` - Extension configuration
- `popup/` - Extension popup UI
- `content/` - Content scripts injected into pages
- `background/` - Service worker for extension
- `icons/` - Extension icons

## Development Guidelines
- Use Chrome Extension Manifest V3 APIs
- Support video elements from various sources (YouTube, HTML5 videos, etc.)
- Capture both video frame and subtitle/caption overlay
- Maintain clean, modular code structure

## Testing
- Load extension in Chrome via `chrome://extensions/` in Developer mode
- Test on YouTube and other video platforms
- Verify subtitle capture functionality
