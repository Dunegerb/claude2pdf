# Claude2PDF

**Turn public AI conversations into clean, readable PDFs.**

Claude2PDF converts public shared chats from Claude, ChatGPT, Gemini, Grok, and Qwen into properly formatted PDFs while preserving the structure that makes the conversation worth keeping.

Code blocks stay code blocks. Lists stay lists. Tables, math, headings, quotes, and rich text come along for the ride.

No account. No login. No runaround.

**Live:** https://claude2pdf.up.railway.app

---

## Supported Platforms

* Claude
* ChatGPT
* Gemini
* Grok
* Qwen

Claude2PDF works with **public shared conversation links** from supported platforms.

---

## What It Preserves

The goal is simple: the PDF should still look like the conversation you actually read.

Claude2PDF handles:

* Bold and italic text
* Headings and subheadings
* Ordered and unordered lists
* Nested lists
* Inline code
* Code blocks
* Syntax-formatted content
* Blockquotes
* Tables
* Links
* Math and formulas
* Horizontal rules
* Long conversations
* Searchable and selectable text

Built to do one job and do it well.

---

## How It Works

1. Create a public share link from a supported AI platform.
2. Paste the link into Claude2PDF.
3. Claude2PDF loads and extracts the public conversation.
4. Provider-specific parsing preserves the conversation structure and formatting.
5. A clean print-ready version is rendered in the browser.
6. Save it as a PDF.

That's the whole deal.

---

## Privacy

Claude2PDF is built around public share links.

You do **not** need to provide your Claude, ChatGPT, Gemini, Grok, or Qwen account credentials to use the service.

The repository is public on purpose so anyone can inspect how conversation extraction and PDF rendering are handled.

Transparency matters, especially for a tool that works with conversations.

---

## Run Locally

### Requirements

* Node.js 20+
* npm
* Chromium-compatible environment

### Install

```bash
git clone https://github.com/Dunegerb/claude2pdf.git
cd claude2pdf
npm install
```

### Start

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

---

## Build

Build the production CSS:

```bash
npm run build
```

---

## Tests

Run the test suite with:

```bash
npm test
```

The extraction layer includes provider-specific regression tests so changes made for one platform don't quietly break another.

---

## Docker

Build the image:

```bash
docker build -t claude2pdf .
```

Run it:

```bash
docker run -p 3000:3000 claude2pdf
```

Then open:

```text
http://localhost:3000
```

---

## Architecture

Claude2PDF uses provider-specific extraction rather than treating every AI platform the same.

Each supported provider has its own markup, rendering behavior, and edge cases. The extraction pipeline is designed to preserve the richest available representation of a conversation before it reaches the PDF renderer.

At a high level:

```text
Public Share URL
       ↓
Provider Detection
       ↓
Browser Extraction
       ↓
Provider-Specific Parsing
       ↓
Sanitized Conversation Data
       ↓
PDF Preview
       ↓
Browser Print / PDF
```

That approach takes a little more work, but it keeps the output dependable when providers don't play by the same rules.

---

## Reporting an Issue

AI platforms change their frontend markup from time to time.

If an export stops working correctly, open an issue and include:

* The affected platform
* What formatting is missing or incorrect
* A reproducible public share link, if possible
* A screenshot of the expected and actual result

Please do not include private conversations, credentials, cookies, session tokens, or other sensitive information.

---

## Source & License

The source code in this repository is public for **transparency, security review, and independent inspection**.

Claude2PDF is **not open-source software**.

Copyright © 2026 DuneGerb. All Rights Reserved.

You may inspect the source code to understand how the platform works, but no permission is granted to copy, modify, redistribute, sublicense, sell, host, deploy, republish, or commercially use the software without prior written authorization from the copyright holder.

See [`LICENSE`](./LICENSE) for the full terms.

---

## Support the Project

If Claude2PDF saves you some time, giving the repository a star helps folks find it.

Much appreciated.
