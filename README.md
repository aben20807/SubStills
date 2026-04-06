# SubStills

SubStills combines "Subtitles" and "Stills". It is a Chrome extension that captures video screenshots with subtitles.

## Features

- 📷 **Capture video screenshots** - Take screenshots from any video playing in your browser
- ⏮️ **Fine-grained stepping** - Move to the previous or next frame-sized step from popup buttons or keyboard shortcuts
- 📝 **Include subtitles** - Automatically captures visible subtitles/captions with the screenshot
- 🎨 **Multiple formats** - Export as PNG, JPEG, or WebP
- 📋 **Copy to clipboard** - Quickly copy screenshots to clipboard
- ⬇️ **Auto download** - Optionally auto-download screenshots
- 🌐 **Wide compatibility** - Works with YouTube, Netflix, Vimeo, and most HTML5 video players

## Installation

### Developer Mode (Local Installation)

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right corner)
4. Click **Load unpacked**
5. Select the `SubStills` folder

## Usage

1. Navigate to a page with a video (e.g., YouTube)
2. Start playing the video
3. Enable subtitles/captions if you want them included
4. Click the extension icon in your toolbar
5. Use **Previous** / **Next** to step the video by your configured jump size
6. Click **Capture Screenshot**
7. Use keyboard shortcuts `,` for previous step and `.` for next step while focused on the page
8. The screenshot will be saved automatically or shown in preview

### Options

- **Include Subtitles** - Toggle to include visible subtitles in the screenshot
- **Auto Download** - Automatically download screenshots when captured
- **Format** - Choose between PNG, JPEG, or WebP
- **Jump Size** - Configure how far Previous/Next moves the video
- **Jump Unit** - Choose whether the jump size is measured in frames or seconds
- **Seek Method** - Uses the Netflix player API only

## Project Structure

```text
video-shot/
├── manifest.json          # Extension configuration
├── popup/
│   ├── popup.html        # Popup UI
│   ├── popup.css         # Popup styles
│   └── popup.js          # Popup logic
├── content/
│   ├── content.js        # Content script for video capture
│   └── content.css       # Content script styles
├── background/
│   └── background.js     # Service worker
├── icons/
│   ├── icon16.png        # 16x16 icon
│   ├── icon48.png        # 48x48 icon
│   └── icon128.png       # 128x128 icon
└── README.md
```

## Development

### Prerequisites

- Google Chrome browser
- Basic knowledge of Chrome Extension development

### Setup

1. Clone the repository
2. Make your changes
3. Reload the extension in `chrome://extensions/`

### Building

No build step required - this is a vanilla JavaScript extension.

## How It Works

1. **Video Detection**: The content script finds the largest playing video on the page
2. **Frame Capture**: Uses HTML5 Canvas API to draw the current video frame
3. **Subtitle Capture**:
   - Captures native text tracks (WebVTT)
   - Captures DOM-based subtitles (YouTube, Netflix custom players)
4. **Export**: Converts canvas to image data URL for download/clipboard

## Troubleshooting

### Subtitles not captured

- Make sure subtitles are enabled and visible on the video

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

Apache 2.0 License

## Acknowledgments

- Inspired by [Video Screenshot](https://chromewebstore.google.com/detail/video-screenshot/ppkojackhibeogijphhfnamhemklmial), which requires a monthly fee of \$2 to capture subtitles.
- This extension was developed with substantial assistance from GitHub Copilot (Claude Opus 4.5, Gemini 3 Pro, GPT-5.4, GPT-5 mini) and refined through human feedback.

## Disclaimer

This extension respects Digital Rights Management (DRM) protected content. Screenshots captured using this tool should be used for **personal use only** and must be removed upon request from content owners or rights holders.

This tool is essentially a convenient alternative to using browser developer tools (F12) to capture video frames. It does not bypass any DRM protections or circumvent technical measures.

If you believe this tool is inappropriate or violates any terms of service, please contact us and we will address your concerns promptly.
