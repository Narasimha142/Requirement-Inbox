# Requirement Inbox

A Chrome extension that pulls job requirements from Gmail, Dice, job boards and startup job posts, filters them to your profile, lets you reply to many at once with your resume attached, and tracks replies and applications.

**Website:** https://narasimha142.github.io/Requirement-Inbox/

## Install

1. Download this repo (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Follow [docs/SETUP.md](docs/SETUP.md) to connect Gmail.

## Layout

```
index.html      GitHub Pages landing page
docs/           Setup guide
extension/      The Chrome extension (load this folder)
  icons/        Extension icons
  lib/          Sync, Gmail, Dice, parsers, pdf.js, mammoth (+ their licenses)
```
